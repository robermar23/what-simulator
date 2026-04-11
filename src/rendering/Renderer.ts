/**
 * @fileoverview Canvas 2D renderer for the What Simulator.
 *
 * Converts the simulation's TypedArray buffers into pixels on an HTML5 Canvas
 * element.  The hot path is a single flat for-loop that writes directly into
 * an `ImageData` pixel buffer (`Uint8ClampedArray`) via a `Uint32Array` view —
 * one 32-bit write per cell instead of four 8-bit writes.
 *
 * Phase 1 rendering:
 *   - Grid → canvas at configurable `cellSize` (pixels per cell).
 *   - Colour lookup via pre-built LUT (see {@link ColorMap}).
 *   - Dirty-region tracking: only redraws cells that changed since last frame.
 *   - No overlay, no zoom, no pan (added in Phase 6).
 *
 * Memory:
 *   ImageData for 512×512 grid at cellSize=2 → 1024×1024 canvas → 4 MB pixel
 *   buffer.  Pre-allocated once; `putImageData` is a DMA-like memcpy.
 */

import { type GridBuffers } from '../simulation/GridState.js';
import { COLOR_LUT, ENERGY_STEPS } from './ColorMap.js';

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
 * Manages the HTML5 Canvas 2D rendering pipeline for the simulation grid.
 *
 * Usage:
 * ```ts
 * const renderer = new Renderer(canvas, { cellSize: 2 });
 * // In the RAF loop:
 * renderer.render(grid.front);
 * ```
 */
export class Renderer {
  /** The target canvas element. */
  private readonly _canvas: HTMLCanvasElement;
  /** Canvas 2D rendering context. */
  private readonly _ctx: CanvasRenderingContext2D;

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
   * @param canvas - The `<canvas>` element to render into.
   * @param options - Optional rendering configuration.
   */
  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this._canvas   = canvas;
    this._cellSize = options.cellSize ?? 2;

    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Renderer: failed to acquire Canvas 2D context.');
    }
    this._ctx = ctx;

    // Disable image smoothing — cells should be pixel-sharp.
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
   * Also resizes the canvas to match.
   *
   * @param size - New cell size (1–8 pixels per cell).
   */
  set cellSize(size: number) {
    this._cellSize = size;
    // Force a full resize / redraw next render call.
    this._gridWidth = 0;
  }

  /**
   * Renders the current simulation state onto the canvas.
   *
   * The method is designed to be called inside a `requestAnimationFrame`
   * callback.  It:
   * 1. Resizes canvas if grid dimensions or cellSize changed.
   * 2. Iterates all cells, looking up colours from the LUT.
   * 3. Writes changed pixels into the `ImageData` buffer.
   * 4. Calls `putImageData` once to flush the entire buffer.
   *
   * @param buffers - The simulation's front buffers (read-only by convention).
   * @param width   - Grid width in cells.
   * @param height  - Grid height in cells.
   */
  render(buffers: GridBuffers, width: number, height: number): void {
    // Resize canvas and ImageData if dimensions changed.
    if (width !== this._gridWidth || height !== this._gridHeight) {
      this._resize(width, height);
    }

    const lut      = COLOR_LUT;
    const cellSize = this._cellSize;
    const pixelBuf = this._pixelBuf;
    const prev     = this._prevColors;
    const { cellType, energy } = buffers;

    const canvasWidth = this._canvas.width; // in pixels

    if (cellSize === 1) {
      // Fast path: 1px cells — each cell maps to exactly one pixel.
      for (let i = 0; i < this._totalCells; i++) {
        const e      = Math.min(ENERGY_STEPS - 1, Math.floor(energy[i] * (ENERGY_STEPS - 1)));
        const packed = lut[cellType[i] * ENERGY_STEPS + e];
        if (packed !== prev[i]) {
          prev[i]    = packed;
          pixelBuf[i] = packed;
        }
      }
    } else {
      // General path: each cell maps to a cellSize × cellSize square.
      const gridWidth  = this._gridWidth;
      const gridHeight = this._gridHeight;

      for (let cy = 0; cy < gridHeight; cy++) {
        for (let cx = 0; cx < gridWidth; cx++) {
          const ci = cy * gridWidth + cx; // cell index
          const e  = Math.min(
            ENERGY_STEPS - 1,
            Math.floor(energy[ci] * (ENERGY_STEPS - 1)),
          );
          const packed = lut[cellType[ci] * ENERGY_STEPS + e];

          // Only update pixels when the colour changed.
          if (packed === prev[ci]) continue;
          prev[ci] = packed;

          // Write cellSize × cellSize pixels for this cell.
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

    // Flush the entire pixel buffer to the canvas in one call.
    this._ctx.putImageData(this._imageData, 0, 0);
  }

  /**
   * Forces a full pixel-buffer rebuild on the next render call by invalidating
   * the previous-colour cache.  Use this after the grid is reset or seeded.
   */
  invalidate(): void {
    if (this._prevColors) this._prevColors.fill(0xffffffff); // impossible colour
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Allocates (or re-allocates) the ImageData and helper buffers to match the
   * given grid dimensions and current cellSize.  Also resizes the canvas DOM
   * element.
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

    this._canvas.width  = canvasW;
    this._canvas.height = canvasH;

    // Re-create ImageData at the new pixel dimensions.
    this._imageData = this._ctx.createImageData(canvasW, canvasH);

    // Create a Uint32 view over the ImageData byte buffer.
    this._pixelBuf = new Uint32Array(this._imageData.data.buffer);

    // Pre-allocate dirty-detection cache (one entry per cell, not per pixel).
    this._prevColors = new Uint32Array(this._totalCells);
    // Initialise to an impossible value to force a full draw on the first frame.
    this._prevColors.fill(0xffffffff);

    // Fill the canvas black initially.
    this._pixelBuf.fill(0xff000000); // opaque black in little-endian RGBA
  }
}
