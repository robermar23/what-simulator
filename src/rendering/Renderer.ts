/**
 * @fileoverview Canvas 2D renderer for the What Simulator.
 *
 * Converts the simulation's TypedArray buffers into pixels on a canvas
 * element.  Works with both `HTMLCanvasElement` (main thread, Phase 1–3)
 * and `OffscreenCanvas` (RenderWorker, Phase 4+) because both expose the
 * same Canvas 2D API surface used here.
 *
 * Hot-path design:
 *   - One flat for-loop over all cells.
 *   - `Uint32Array` view over `ImageData.data` → one 32-bit write per cell
 *     (vs. four 8-bit writes) — ~4× faster on most JS engines.
 *   - Pre-built colour lookup table (see {@link ColorMap}) — one array read
 *     per cell instead of conditional branching.
 *   - Dirty-region detection — skips cells whose colour hasn't changed.
 *
 * Phase 4: accepts `OffscreenCanvas` so the RenderWorker can instantiate it
 * without DOM access.
 */

import { type GridBuffers, CellType } from '../simulation/GridState.js';
import {
  COLOR_LUT,
  ENERGY_STEPS,
  lifecycleColorFor,
  variantColorFor,
  // Phase 12: new render mode colour functions
  genomeColorFor,
  generationColorFor,
  fitnessColorFor,
  signalColorFor,
} from './ColorMap.js';

// Phase 14: fully transparent packed RGBA value (little-endian: A=0, B=0, G=0, R=0).
// Used to render Empty cells as transparent when a background canvas is active,
// allowing the procedural background to show through the simulation grid.
const TRANSPARENT = 0x00000000;

/**
 * Per-type hash-noise magnitude for obstacle cells.
 * Index = CellType ordinal.  0 = no noise (life cells and empty).
 * Matches obstacleNoiseMag() in the WebGL fragment shader.
 */
const OBSTACLE_NOISE_MAG: readonly number[] = [
  0,    // 0  Empty
  0,    // 1  Life
  0.13, // 2  Wall       — rough stone
  0.10, // 3  Toxin
  0.10, // 4  Nutrient
  0.10, // 5  Drain
  0.10, // 6  GravityWell
  0.08, // 7  Barrier
  0.10, // 8  Fire
  0.05, // 9  Ice        — clean crystal
  0,    // 10 LifeVariant
  0.12, // 11 Mutagen
  0.18, // 12 RadioWaste — highly irregular
  0.05, // 13 Antibiotic — crystalline
  0.08, // 14 Rewinder
  0.10, // 15 Colony
];

// ---------------------------------------------------------------------------
// Canvas type alias
// ---------------------------------------------------------------------------

/**
 * Any canvas-like object the Renderer can target.
 * Both `HTMLCanvasElement` and `OffscreenCanvas` implement this interface:
 * they have `width` / `height` properties and `getContext('2d')`.
 */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The subset of the Canvas 2D rendering context actually used by the Renderer.
 * Both `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D`
 * satisfy this shape, so we can write to either without type gymnastics.
 *
 * Phase 6: added stroke methods for grid-line overlay.
 */
interface Canvas2DCtx {
  imageSmoothingEnabled: boolean;
  createImageData(sw: number, sh: number): ImageData;
  putImageData(imagedata: ImageData, dx: number, dy: number): void;
  // Grid-line drawing (Phase 6)
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

// ---------------------------------------------------------------------------
// Renderer options
// ---------------------------------------------------------------------------

/** Construction options for {@link Renderer}. */
export interface RendererOptions {
  /** Pixels per cell (1–8).  Default: 2. */
  cellSize?: number;
  /**
   * Whether to draw thin grid lines between cells.  Default: false.
   * Grid lines are only visually meaningful at `cellSize` >= 2.
   * Phase 6.
   */
  showGridLines?: boolean;
}

// ---------------------------------------------------------------------------
// Renderer class
// ---------------------------------------------------------------------------

/**
 * Manages the Canvas 2D rendering pipeline for the simulation grid.
 *
 * Usage (main thread, HTMLCanvasElement):
 * ```ts
 * const renderer = new Renderer(canvasEl, { cellSize: 2 });
 * renderer.render(grid.front, 256, 256);
 * ```
 *
 * Usage (RenderWorker, OffscreenCanvas):
 * ```ts
 * const renderer = new Renderer(offscreenCanvas, { cellSize: 2 });
 * renderer.render(sabGridBuffers, 256, 256);
 * ```
 */
export class Renderer {
  /** The target canvas (HTMLCanvasElement or OffscreenCanvas). */
  private readonly _canvas: AnyCanvas;
  /** Canvas 2D rendering context (works for both canvas types). */
  private readonly _ctx: Canvas2DCtx;

  /** Pixels per cell. */
  private _cellSize: number;

  /** Grid width in cells (set on first render). */
  private _gridWidth  = 0;
  /** Grid height in cells (set on first render). */
  private _gridHeight = 0;
  /** Total cell count. */
  private _totalCells = 0;

  /**
   * Whether thin grid-line borders should be drawn between cells.
   * Only visible at `cellSize` >= 2 px.  Phase 6.
   */
  private _showGridLines = false;

  /**
   * When true, Empty cells are written as fully transparent (alpha=0) rather
   * than opaque near-black.  Enabled when a procedural background is active
   * (Phase 14) so the background canvas shows through the simulation grid.
   */
  private _transparentEmpty = false;

  /**
   * Current render mode.
   * - `'default'`    — colour from the pre-built LUT (cellType + energy).
   * - `'lifecycle'`  — Life cells coloured by JUVENILE/SENESCENT flags.
   * - `'variantId'`  — Life cells coloured by variant lineage palette (Phase 11).
   * - `'genome'`     — Life cells coloured by 16-bit genome value (Phase 12).
   * - `'generation'` — Life cells coloured by generation count (Phase 12).
   * - `'fitness'`    — Life cells coloured by energy × spreadBonus (Phase 12).
   * - `'signal'`     — All cells overlaid with chemical signal strength (Phase 12).
   */
  private _renderMode: 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal' = 'default';

  /**
   * Environment colour tint `[r, g, b, alpha]` blended into every non-empty
   * Life cell colour so cells visually belong to the active background
   * environment regardless of grid saturation.
   * r/g/b ∈ [0, 255]; alpha ∈ [0, 1] (0 = no tint).
   */
  private _envTint: readonly [number, number, number, number] = [0, 0, 0, 0];

  /**
   * Pre-allocated ImageData written into each frame.
   * Re-allocated when grid dimensions or cellSize changes.
   */
  private _imageData!: ImageData;

  /**
   * `Uint32Array` view over `_imageData.data`.
   * Allows writing all 4 RGBA bytes in a single 32-bit store — 4× faster than
   * individual byte writes on most JS engines.
   */
  private _pixelBuf!: Uint32Array;

  /**
   * Flat array storing the packed colour of each cell as rendered last frame.
   * Used for dirty-region detection: only cells whose colour changed need
   * their pixels rewritten.
   */
  private _prevColors!: Uint32Array;

  /**
   * @param canvas  - The canvas to render into (`HTMLCanvasElement` or
   *                  `OffscreenCanvas`).
   * @param options - Optional rendering configuration.
   * @throws If the Canvas 2D context cannot be acquired.
   */
  constructor(canvas: AnyCanvas, options: RendererOptions = {}) {
    this._canvas        = canvas;
    this._cellSize      = options.cellSize      ?? 2;
    this._showGridLines = options.showGridLines ?? false;

    // Both HTMLCanvasElement and OffscreenCanvas return a context that
    // implements the Canvas2DCtx interface we rely on.
    const ctx = canvas.getContext('2d') as Canvas2DCtx | null;
    if (ctx === null) {
      throw new Error('Renderer: failed to acquire Canvas 2D context.');
    }
    this._ctx = ctx;

    // Disable image smoothing — cells must be pixel-sharp.
    this._ctx.imageSmoothingEnabled = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Current pixels-per-cell setting. */
  get cellSize(): number {
    return this._cellSize;
  }

  /**
   * Changes the cell size and forces a full redraw on the next render call.
   * Also triggers a canvas resize on the next {@link render} call.
   *
   * @param size - New cell size (1–8 pixels per cell).
   */
  set cellSize(size: number) {
    this._cellSize = size;
    // Force _resize() on the next render by invalidating the cached dimensions.
    this._gridWidth = 0;
  }

  /** Whether grid lines are currently drawn between cells. */
  get showGridLines(): boolean {
    return this._showGridLines;
  }

  /**
   * Enables or disables the thin grid-line overlay.
   * Grid lines are only visible when `cellSize` >= 2.
   *
   * @param show - True to draw grid lines; false to hide them.
   */
  set showGridLines(show: boolean) {
    this._showGridLines = show;
  }

  /**
   * Whether Empty cells render as fully transparent (alpha=0).
   * Set to `true` when a procedural background is active so the background
   * canvas shows through.  Set to `false` when background is `'none'`.
   * Phase 14.
   */
  get transparentEmpty(): boolean {
    return this._transparentEmpty;
  }

  /**
   * Enables or disables transparent Empty-cell rendering.
   * Forces a full redraw on the next frame so stale opaque pixels are cleared.
   *
   * @param value - True to use transparent empty cells; false for opaque.
   */
  set transparentEmpty(value: boolean) {
    if (this._transparentEmpty === value) return;
    this._transparentEmpty = value;
    this.invalidate(); // force full repaint — empty cell colour changed
  }

  /**
   * Current render mode.
   * - `'default'`    — standard colour LUT (cellType + energy).
   * - `'lifecycle'`  — Life cells coloured by JUVENILE / SENESCENT flags.
   * - `'variantId'`  — Life cells coloured by variant lineage palette (Phase 11).
   * - `'genome'`     — Life cells coloured by 16-bit genome value (Phase 12).
   * - `'generation'` — Life cells coloured by generation count (Phase 12).
   * - `'fitness'`    — Life cells coloured by energy × spreadBonus (Phase 12).
   * - `'signal'`     — All cells overlaid with chemical signal strength (Phase 12).
   */
  get renderMode(): 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal' {
    return this._renderMode;
  }

  /**
   * Changes the render mode and forces a full redraw on the next render call.
   *
   * @param mode - New render mode.
   */
  set renderMode(mode: 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal') {
    if (this._renderMode !== mode) {
      this._renderMode = mode;
      this.invalidate();
    }
  }

  /**
   * Environment colour tint blended into Life cell colours at render time.
   *
   * `[r, g, b, alpha]` — r/g/b in [0, 255], alpha in [0, 1].
   * Set to `[0, 0, 0, 0]` to disable tinting (default / no background).
   *
   * @param tint - The new tint tuple.
   */
  set envTint(tint: readonly [number, number, number, number]) {
    this._envTint = tint;
    this.invalidate();
  }

  /**
   * Renders the current simulation state onto the canvas.
   *
   * Designed to be called inside a `requestAnimationFrame` callback.
   *
   * Steps:
   * 1. Resize canvas if grid dimensions or cellSize changed.
   * 2. Iterate all cells; look up packed RGBA from the colour LUT.
   * 3. Write only changed-colour pixels into the `ImageData` buffer.
   * 4. Flush the buffer with a single `putImageData` call.
   *
   * @param buffers - Grid front buffers (read-only by convention).
   * @param width   - Grid width in cells.
   * @param height  - Grid height in cells.
   */
  render(buffers: GridBuffers, width: number, height: number): void {
    // Resize canvas and reallocate ImageData if dimensions or zoom changed.
    if (width !== this._gridWidth || height !== this._gridHeight) {
      this._resize(width, height);
    }

    const lut            = COLOR_LUT;
    const cellSize       = this._cellSize;
    const pixelBuf       = this._pixelBuf;
    const prev           = this._prevColors;
    const mode           = this._renderMode;
    const transpEmpty    = this._transparentEmpty;
    const tintAlpha      = this._envTint[3]; // fast check: skip tint work when alpha=0
    const isLifecycle    = mode === 'lifecycle';
    const isVariant      = mode === 'variantId';
    const isGenome       = mode === 'genome';
    const isGeneration   = mode === 'generation';
    const isFitness      = mode === 'fitness';
    const isSignal       = mode === 'signal';
    const { cellType, energy, flags, variantId, genome, generation, spreadBonus, signalStrength } = buffers;

    const canvasWidth = this._canvas.width; // pixels
    const gridWidth   = this._gridWidth;    // needed by 1px path for noise cx/cy

    if (cellSize === 1) {
      // Fast path: 1-pixel cells — every cell maps to one pixel.
      // Running (cx, cy) counter avoids modulo/division inside the hot loop.
      let ncx = 0;
      let ncy = 0;
      for (let i = 0; i < this._totalCells; i++) {
        const ct = cellType[i];
        let packed: number;

        // Base LUT colour (used for non-Life cells and as base for signal overlay).
        const e     = Math.min(ENERGY_STEPS - 1, Math.floor(energy[i] * (ENERGY_STEPS - 1)));
        const base  = lut[ct * ENERGY_STEPS + e];

        if (ct === CellType.Life || ct === CellType.LifeVariant) {
          if (isLifecycle) {
            packed = lifecycleColorFor(flags[i], energy[i]);
          } else if (isVariant) {
            packed = variantColorFor(variantId[i], energy[i]);
          } else if (isGenome) {
            packed = genomeColorFor(genome[i], energy[i]);
          } else if (isGeneration) {
            packed = generationColorFor(generation[i], energy[i]);
          } else if (isFitness) {
            packed = fitnessColorFor(energy[i], spreadBonus[i]);
          } else if (isSignal) {
            packed = signalColorFor(signalStrength[i], base);
          } else {
            packed = base;
          }
        } else if (transpEmpty && ct === CellType.Empty) {
          packed = TRANSPARENT;
        } else {
          packed = isSignal ? signalColorFor(signalStrength[i], base) : base;
        }

        // Per-cell hash noise for obstacle cells — breaks the flat uniform look.
        const noiseMag = OBSTACLE_NOISE_MAG[ct] ?? 0;
        if (noiseMag > 0) {
          packed = Renderer._noisePacked(packed, Renderer._cellNoise(ncx, ncy) * noiseMag * 255);
        }

        if (tintAlpha > 0 && packed !== TRANSPARENT) {
          packed = this._applyTint(packed);
        }

        if (packed !== prev[i]) {
          prev[i]     = packed;
          pixelBuf[i] = packed;
        }

        // Advance running position — cheaper than modulo/division every iteration.
        if (++ncx === gridWidth) { ncx = 0; ++ncy; }
      }
    } else {
      // General path: each cell maps to a `cellSize × cellSize` pixel square.
      const gridHeight = this._gridHeight;

      for (let cy = 0; cy < gridHeight; cy++) {
        for (let cx = 0; cx < gridWidth; cx++) {
          const ci = cy * gridWidth + cx;
          const ct = cellType[ci];
          let packed: number;

          const e    = Math.min(ENERGY_STEPS - 1, Math.floor(energy[ci] * (ENERGY_STEPS - 1)));
          const base = lut[ct * ENERGY_STEPS + e];

          if (ct === CellType.Life || ct === CellType.LifeVariant) {
            if (isLifecycle) {
              packed = lifecycleColorFor(flags[ci], energy[ci]);
            } else if (isVariant) {
              packed = variantColorFor(variantId[ci], energy[ci]);
            } else if (isGenome) {
              packed = genomeColorFor(genome[ci], energy[ci]);
            } else if (isGeneration) {
              packed = generationColorFor(generation[ci], energy[ci]);
            } else if (isFitness) {
              packed = fitnessColorFor(energy[ci], spreadBonus[ci]);
            } else if (isSignal) {
              packed = signalColorFor(signalStrength[ci], base);
            } else {
              packed = base;
            }
          } else if (transpEmpty && ct === CellType.Empty) {
            packed = TRANSPARENT;
          } else {
            packed = isSignal ? signalColorFor(signalStrength[ci], base) : base;
          }

          // Per-cell hash noise for obstacle cells.
          const noiseMag = OBSTACLE_NOISE_MAG[ct] ?? 0;
          if (noiseMag > 0) {
            packed = Renderer._noisePacked(packed, Renderer._cellNoise(cx, cy) * noiseMag * 255);
          }

          if (tintAlpha > 0 && packed !== TRANSPARENT) {
            packed = this._applyTint(packed);
          }

          // Skip unchanged cells — no pixel writes needed.
          if (packed === prev[ci]) continue;
          prev[ci] = packed;

          // Write the `cellSize × cellSize` block of pixels for this cell.
          const basePixelX = cx * cellSize;
          const basePixelY = cy * cellSize;

          for (let py = 0; py < cellSize; py++) {
            const rowStart = (basePixelY + py) * canvasWidth + basePixelX;
            for (let px = 0; px < cellSize; px++) {
              pixelBuf[rowStart + px] = packed;
            }
          }
        }
      }
    }

    // Flush the entire pixel buffer to the canvas in one DMA-like call.
    this._ctx.putImageData(this._imageData, 0, 0);

    // Phase 6: draw thin grid lines over the cells if enabled.
    // Only drawn at cellSize >= 2 — at 1 px per cell the lines would cover cells.
    if (this._showGridLines && cellSize >= 2) {
      this._drawGridLines();
    }
  }

  /**
   * Forces a full pixel-buffer rebuild on the next render call by invalidating
   * the previous-colour cache.
   *
   * Call this after the grid is reset, re-seeded, or when the cell-size
   * changes so stale pixels are not retained across scenes.
   */
  invalidate(): void {
    if (this._prevColors) {
      // 0xffffffff is an impossible colour (fully transparent opaque white) so
      // every cell is guaranteed to be redrawn on the next render.
      this._prevColors.fill(0xffffffff);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Draws thin lines along every cell boundary using the Canvas 2D stroke API.
   *
   * Called after `putImageData` so lines appear on top of cell colours.
   * Uses a very low-opacity white so the grid hint is subtle on all backgrounds.
   * Each line is 1 physical pixel regardless of `cellSize`.
   */
  /**
   * Blends an environment tint colour into a packed RGBA cell colour.
   *
   * Packed format (little-endian): bits [0–7]=R, [8–15]=G, [16–23]=B, [24–31]=A.
   * The alpha channel of the cell is preserved; only RGB is shifted toward the tint.
   *
   * @param packed - Original packed RGBA cell colour.
   * @returns Tinted packed RGBA colour.
   */
  /**
   * Murmur-inspired integer hash — deterministic per-cell brightness noise.
   * Matches the GLSL cellHash() function in WebGLRenderer so both renderers
   * produce the same per-cell texture pattern.
   *
   * @param cx - Cell column (0-based).
   * @param cy - Cell row (0-based).
   * @returns Signed noise in [-1, +1].
   */
  private static _cellNoise(cx: number, cy: number): number {
    let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263) + 2166136261) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1540483477) >>> 0;
    h ^= h >>> 15;
    return ((h & 0xffff) / 32767.5) - 1.0; // [-1, +1]
  }

  /**
   * Applies a brightness delta (in raw 0–255 units) to the RGB channels of a
   * packed little-endian RGBA colour.  Alpha is preserved unchanged.
   *
   * @param packed - Source packed RGBA word (R in low byte).
   * @param delta  - Integer brightness offset in [-255, +255].
   * @returns Modified packed RGBA with channels clamped to [0, 255].
   */
  private static _noisePacked(packed: number, delta: number): number {
    const d = (delta + 0.5) | 0;
    const r = Math.min(255, Math.max(0, ( packed         & 0xff) + d));
    const g = Math.min(255, Math.max(0, ((packed >>>  8) & 0xff) + d));
    const b = Math.min(255, Math.max(0, ((packed >>> 16) & 0xff) + d));
    return (packed & 0xff000000) | (b << 16) | (g << 8) | r;
  }

  private _applyTint(packed: number): number {
    const [tr, tg, tb, ta] = this._envTint;
    const r =  packed         & 0xff;
    const g = (packed >>>  8) & 0xff;
    const b = (packed >>> 16) & 0xff;
    const a = (packed >>> 24) & 0xff;
    return (a                                         << 24) |
           (((b + ((tb - b) * ta + 0.5)) | 0)        << 16) |
           (((g + ((tg - g) * ta + 0.5)) | 0)        <<  8) |
            ((r + ((tr - r) * ta + 0.5)) | 0);
  }

  private _drawGridLines(): void {
    const ctx        = this._ctx;
    const cellSize   = this._cellSize;
    const canvasW    = this._canvas.width;
    const canvasH    = this._canvas.height;
    const gridWidth  = this._gridWidth;
    const gridHeight = this._gridHeight;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth   = 1;

    // Vertical lines — one per column boundary.
    for (let cx = 0; cx <= gridWidth; cx++) {
      const x = cx * cellSize;
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, canvasH);
    }

    // Horizontal lines — one per row boundary.
    for (let cy = 0; cy <= gridHeight; cy++) {
      const y = cy * cellSize;
      ctx.moveTo(0,      y + 0.5);
      ctx.lineTo(canvasW, y + 0.5);
    }

    ctx.stroke();
  }

  /**
   * Allocates (or re-allocates) the `ImageData` and helper buffers to match
   * the given grid dimensions and current `cellSize`.  Also resizes the canvas.
   *
   * @param width  - Grid width in cells.
   * @param height - Grid height in cells.
   */
  private _resize(width: number, height: number): void {
    this._gridWidth  = width;
    this._gridHeight = height;
    this._totalCells = width * height;

    const canvasW = width  * this._cellSize;
    const canvasH = height * this._cellSize;

    // Resize the canvas (works for both HTMLCanvasElement and OffscreenCanvas).
    this._canvas.width  = canvasW;
    this._canvas.height = canvasH;

    // Re-create ImageData at the new pixel dimensions.
    this._imageData = this._ctx.createImageData(canvasW, canvasH);

    // Create a Uint32 view over the ImageData byte buffer.
    // One 32-bit write per cell instead of four 8-bit writes.
    this._pixelBuf = new Uint32Array(this._imageData.data.buffer);

    // Pre-allocate dirty-detection cache (one entry per cell, not per pixel).
    this._prevColors = new Uint32Array(this._totalCells);
    // Initialise to an impossible value to force a full draw on the first frame.
    this._prevColors.fill(0xffffffff);

    // Fill the canvas black initially.
    this._pixelBuf.fill(0xff000000); // opaque black in little-endian RGBA
  }
}
