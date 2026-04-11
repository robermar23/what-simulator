/**
 * @fileoverview Overlay canvas renderer for the What Simulator.
 *
 * A second `<canvas>` element (positioned via CSS over the simulation canvas)
 * draws editor-mode annotations that do not belong in the pixel-perfect
 * simulation render:
 *
 *   - **GravityWell arrows**: each GravityWell cell gets a small radial-glow
 *     disc plus four directional arrows pointing inward toward the cell,
 *     indicating the pull direction for nearby Life cells.
 *
 * The overlay canvas is only repainted when:
 *   - The simulation grid state changes (new tick data from the SAB).
 *   - The user paints or erases a GravityWell cell.
 *   - The cell size (zoom level) changes.
 *
 * This means the overlay is NOT redrawn every animation frame — only when
 * the well positions or zoom actually change, which is very infrequent.
 *
 * ## Integration
 *
 * `OverlayRenderer` is mounted on top of the simulation canvas in `main.ts`
 * and receives cell-size updates from the EventBus.  It reads GravityWell
 * positions directly from the SharedArrayBuffer via a caller-supplied callback
 * so it stays decoupled from the worker message protocol.
 */

import { CellType } from '../simulation/GridState.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A function that returns all flat indices of GravityWell cells in the
 * current front buffer of the simulation grid.
 *
 * The OverlayRenderer calls this callback each time it needs to repaint.
 * The implementation in `main.ts` reads from the SAB's front buffer.
 */
export type WellIndexProvider = () => readonly number[];

// ---------------------------------------------------------------------------
// OverlayRenderer
// ---------------------------------------------------------------------------

/**
 * Draws GravityWell annotations on a transparent overlay canvas positioned
 * over the simulation canvas.
 *
 * Usage:
 * ```ts
 * const overlay = new OverlayRenderer();
 * overlay.mount(overlayCanvas, cellSize, width, height, () => wellIndices);
 * overlay.repaint(); // call whenever well positions may have changed
 * ```
 */
export class OverlayRenderer {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** The overlay canvas element. */
  private _canvas: HTMLCanvasElement | null = null;

  /** 2D rendering context for the overlay canvas. */
  private _ctx: CanvasRenderingContext2D | null = null;

  /** Current pixels-per-cell zoom level. */
  private _cellSize = 2;

  /** Grid width in cells. */
  private _gridWidth = 0;

  /** Grid height in cells. */
  private _gridHeight = 0;

  /** Callback to retrieve current GravityWell cell flat indices. */
  private _getWells: WellIndexProvider | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attaches the overlay renderer to a canvas element.
   *
   * The canvas should be positioned via CSS `position: absolute` over the
   * simulation canvas with `pointer-events: none` so it does not block input.
   *
   * @param canvas - The overlay HTMLCanvasElement.
   * @param cellSize - Initial pixels-per-cell zoom level.
   * @param gridWidth - Grid width in cells.
   * @param gridHeight - Grid height in cells.
   * @param getWells - Callback returning flat indices of GravityWell cells.
   */
  mount(
    canvas: HTMLCanvasElement,
    cellSize: number,
    gridWidth: number,
    gridHeight: number,
    getWells: WellIndexProvider,
  ): void {
    this._canvas     = canvas;
    this._cellSize   = cellSize;
    this._gridWidth  = gridWidth;
    this._gridHeight = gridHeight;
    this._getWells   = getWells;
    this._ctx        = canvas.getContext('2d');

    // Size the overlay canvas to match the simulation canvas exactly.
    this._resizeCanvas();
    this.repaint();
  }

  /**
   * Updates the cell size (zoom level) and repaints the overlay.
   *
   * Call this whenever `AppState.cellSize` changes.
   *
   * @param cellSize - New pixels-per-cell zoom level.
   */
  setCellSize(cellSize: number): void {
    this._cellSize = cellSize;
    this._resizeCanvas();
    this.repaint();
  }

  /**
   * Clears and repaints the entire overlay.
   *
   * Call this after any tick that may have changed the GravityWell cell
   * positions (e.g., after a reset, or when the user paints/erases a well).
   */
  repaint(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas || !this._getWells) return;

    // Clear the entire overlay to transparent.
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

    const wellIndices = this._getWells();
    if (wellIndices.length === 0) return;

    const cellSize   = this._cellSize;
    const gridWidth  = this._gridWidth;

    for (const idx of wellIndices) {
      const x = idx % gridWidth;
      const y = (idx - x) / gridWidth;

      // Pixel centre of this cell on the overlay canvas.
      const cx = x * cellSize + cellSize * 0.5;
      const cy = y * cellSize + cellSize * 0.5;

      this._drawWellGlow(ctx, cx, cy, cellSize);
      this._drawWellArrows(ctx, cx, cy, cellSize);
    }
  }

  // -------------------------------------------------------------------------
  // Private drawing helpers
  // -------------------------------------------------------------------------

  /**
   * Sizes the overlay canvas to match the full simulation grid in pixels.
   * Must be called when cellSize or grid dimensions change.
   */
  private _resizeCanvas(): void {
    if (!this._canvas) return;
    this._canvas.width  = this._gridWidth  * this._cellSize;
    this._canvas.height = this._gridHeight * this._cellSize;
  }

  /**
   * Draws a soft radial glow centred on a GravityWell cell.
   *
   * The glow is an orange radial gradient that fills the cell and fades
   * outward.  At small cell sizes (1–2 px) the glow is minimal; at larger
   * zoom levels it becomes a visible ambient halo.
   *
   * @param ctx - Canvas 2D rendering context.
   * @param cx - Pixel X centre of the cell.
   * @param cy - Pixel Y centre of the cell.
   * @param cellSize - Pixels per cell.
   */
  private _drawWellGlow(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    cellSize: number,
  ): void {
    // Glow radius: 2× cell size so it bleeds into neighbours slightly.
    const r = cellSize * 2;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0,   'rgba(255, 136, 0, 0.55)');  // bright centre
    grad.addColorStop(0.4, 'rgba(255, 136, 0, 0.25)');  // mid
    grad.addColorStop(1,   'rgba(255, 136, 0, 0)');     // transparent edge

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  /**
   * Draws four inward-pointing chevron arrows around a GravityWell cell.
   *
   * The arrows are drawn only when `cellSize ≥ 4` — at smaller zoom levels
   * they would be illegibly tiny and are omitted for cleanliness.
   *
   * Each arrow points toward the well centre from the four cardinal directions
   * (N, S, E, W), giving a visual cue that life is attracted inward.
   *
   * @param ctx - Canvas 2D rendering context.
   * @param cx - Pixel X centre of the cell.
   * @param cy - Pixel Y centre of the cell.
   * @param cellSize - Pixels per cell.
   */
  private _drawWellArrows(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    cellSize: number,
  ): void {
    // Skip arrows at zoom levels too small to be readable.
    if (cellSize < 4) return;

    // Arrow geometry: tip reaches the cell edge, tail is half a cell out.
    const arrowLen  = Math.max(cellSize * 0.8, 4);
    const arrowHead = Math.max(cellSize * 0.3, 2);

    ctx.strokeStyle = 'rgba(255, 180, 50, 0.85)';
    ctx.fillStyle   = 'rgba(255, 180, 50, 0.85)';
    ctx.lineWidth   = Math.max(1, cellSize * 0.1);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    // Four directions: [angle in radians pointing TOWARD the centre]
    // North arrow points down (π/2), South points up (3π/2), etc.
    const directions: readonly number[] = [
      0,           // → East (arrow from right, pointing left)
      Math.PI,     // ← West (arrow from left, pointing right)
      Math.PI / 2, // ↓ South (arrow from below, pointing up)
      -Math.PI / 2,// ↑ North (arrow from above, pointing down)
    ];

    for (const angle of directions) {
      // Start of arrow shaft (displaced outward from centre by arrowLen).
      const tailX = cx + Math.cos(angle) * arrowLen;
      const tailY = cy + Math.sin(angle) * arrowLen;

      // Tip points toward the centre (opposite direction).
      const tipX = cx + Math.cos(angle) * (arrowLen * 0.2);
      const tipY = cy + Math.sin(angle) * (arrowLen * 0.2);

      // --- Shaft ---
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      // --- Arrowhead (filled triangle at the tip) ---
      const perpAngle = angle + Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(
        tipX + Math.cos(angle + (3 * Math.PI) / 4) * arrowHead,
        tipY + Math.sin(angle + (3 * Math.PI) / 4) * arrowHead,
      );
      ctx.lineTo(
        tipX + Math.cos(angle - (3 * Math.PI) / 4) * arrowHead,
        tipY + Math.sin(angle - (3 * Math.PI) / 4) * arrowHead,
      );
      ctx.closePath();
      ctx.fill();

      // perpAngle is unused — disable the lint warning via void.
      void perpAngle;
    }
  }
}

// Re-export CellType so callers checking for GravityWell don't need a separate
// import from GridState.
export { CellType };
