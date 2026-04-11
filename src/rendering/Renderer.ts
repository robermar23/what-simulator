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

import { type GridBuffers } from '../simulation/GridState.js';
import { COLOR_LUT, ENERGY_STEPS } from './ColorMap.js';

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
 */
interface Canvas2DCtx {
  imageSmoothingEnabled: boolean;
  createImageData(sw: number, sh: number): ImageData;
  putImageData(imagedata: ImageData, dx: number, dy: number): void;
}

// ---------------------------------------------------------------------------
// Renderer options
// ---------------------------------------------------------------------------

/** Construction options for {@link Renderer}. */
export interface RendererOptions {
  /** Pixels per cell (1–8).  Default: 2. */
  cellSize?: number;
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
    this._canvas   = canvas;
    this._cellSize = options.cellSize ?? 2;

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

    const lut      = COLOR_LUT;
    const cellSize = this._cellSize;
    const pixelBuf = this._pixelBuf;
    const prev     = this._prevColors;
    const { cellType, energy } = buffers;

    const canvasWidth = this._canvas.width; // pixels

    if (cellSize === 1) {
      // Fast path: 1-pixel cells — every cell maps to one pixel.
      for (let i = 0; i < this._totalCells; i++) {
        const e      = Math.min(ENERGY_STEPS - 1, Math.floor(energy[i] * (ENERGY_STEPS - 1)));
        const packed = lut[cellType[i] * ENERGY_STEPS + e];
        if (packed !== prev[i]) {
          prev[i]     = packed;
          pixelBuf[i] = packed;
        }
      }
    } else {
      // General path: each cell maps to a `cellSize × cellSize` pixel square.
      const gridWidth  = this._gridWidth;
      const gridHeight = this._gridHeight;

      for (let cy = 0; cy < gridHeight; cy++) {
        for (let cx = 0; cx < gridWidth; cx++) {
          const ci     = cy * gridWidth + cx;
          const e      = Math.min(
            ENERGY_STEPS - 1,
            Math.floor(energy[ci] * (ENERGY_STEPS - 1)),
          );
          const packed = lut[cellType[ci] * ENERGY_STEPS + e];

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
