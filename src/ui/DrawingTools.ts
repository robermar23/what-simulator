/**
 * @fileoverview Canvas drawing tool handler for the What Simulator.
 *
 * Translates pointer (mouse / touch / pen) events on the simulation canvas
 * into cell-paint operations on the grid.  Reads the active tool and brush
 * size from {@link AppState} and delegates actual cell writes to a
 * caller-supplied callback.
 *
 * Pointer interaction contract:
 *   - Left-click + drag  → paint with the active tool
 *   - Right-click + drag → erase (paint CellType.Empty)
 *   - Context menu       → suppressed on the canvas (enables right-drag erase)
 *
 * Architecture: DrawingTools owns ONLY input mapping.  It never touches the
 * grid or renderer directly — the `paintCell` callback is the sole output.
 * This keeps the class testable and swappable for Phase 4 (Worker bridge).
 */

import { appState, type DrawingTool } from '../state/AppState.js';
import { CellType } from '../simulation/GridState.js';

// ---------------------------------------------------------------------------
// Tool → CellType mapping
// ---------------------------------------------------------------------------

/**
 * Maps every drawing tool name to the CellType it paints.
 * 'erase' maps to CellType.Empty (wipes a cell).
 */
const TOOL_CELL_TYPE: Readonly<Record<DrawingTool, CellType>> = {
  life:        CellType.Life,
  wall:        CellType.Wall,
  toxin:       CellType.Toxin,
  nutrient:    CellType.Nutrient,
  drain:       CellType.Drain,
  gravityWell: CellType.GravityWell,
  barrier:     CellType.Barrier,
  fire:        CellType.Fire,
  ice:         CellType.Ice,
  erase:       CellType.Empty,
};

// ---------------------------------------------------------------------------
// Callback type
// ---------------------------------------------------------------------------

/**
 * Callback invoked for each cell that should be painted.
 *
 * @param cellX - Grid column index (0-based).
 * @param cellY - Grid row index (0-based).
 * @param type  - CellType to place at that coordinate.
 */
export type PaintCellFn = (cellX: number, cellY: number, type: CellType) => void;

// ---------------------------------------------------------------------------
// DrawingTools class
// ---------------------------------------------------------------------------

/**
 * Manages all canvas pointer interactions for the simulation drawing tools.
 *
 * Usage:
 * ```ts
 * const tools = new DrawingTools();
 * tools.mount(canvas, (x, y, type) => app.paintCell(x, y, type));
 * ```
 */
export class DrawingTools {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** Whether a pointer button is currently held on the canvas. */
  private _isPainting = false;

  /**
   * CellType currently being painted.
   * Set on `pointerdown` and held for the duration of the drag gesture.
   * Right-button always overrides to `CellType.Empty` (erase mode).
   */
  private _paintType: CellType = CellType.Life;

  /** Callback that actually modifies the grid. */
  private _paintCell: PaintCellFn | null = null;

  /** Reference to the canvas element for coordinate math and cleanup. */
  private _canvas: HTMLCanvasElement | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attaches pointer event listeners to `canvas` and stores the paint
   * callback.  Call {@link unmount} to remove listeners when done.
   *
   * @param canvas    - The simulation `<canvas>` element.
   * @param paintCell - Callback invoked for every painted cell.
   */
  mount(canvas: HTMLCanvasElement, paintCell: PaintCellFn): void {
    this._canvas    = canvas;
    this._paintCell = paintCell;

    canvas.addEventListener('pointerdown',   this._onPointerDown);
    canvas.addEventListener('pointermove',   this._onPointerMove);
    canvas.addEventListener('pointerup',     this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);
    canvas.addEventListener('contextmenu',   this._onContextMenu);
  }

  /**
   * Removes all event listeners and releases internal references.
   * Safe to call even if {@link mount} was never called.
   */
  unmount(): void {
    if (!this._canvas) return;

    this._canvas.removeEventListener('pointerdown',   this._onPointerDown);
    this._canvas.removeEventListener('pointermove',   this._onPointerMove);
    this._canvas.removeEventListener('pointerup',     this._onPointerUp);
    this._canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this._canvas.removeEventListener('contextmenu',   this._onContextMenu);

    this._canvas    = null;
    this._paintCell = null;
    this._isPainting = false;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // Arrow functions used so `this` is always the DrawingTools instance even
  // when the browser calls back through addEventListener.
  // -------------------------------------------------------------------------

  /**
   * Handles `pointerdown`: starts a paint gesture.
   * Only left (button 0) and right (button 2) buttons are handled.
   * Captures the pointer so drag-out-of-canvas still fires pointermove.
   *
   * @param e - Pointer event.
   */
  private readonly _onPointerDown = (e: PointerEvent): void => {
    // Ignore middle-click (button 1) and any other buttons.
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();

    // Capture so pointermove fires even when the cursor leaves the canvas.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    this._isPainting = true;

    // Right-click always erases, regardless of the active tool.
    this._paintType = (e.button === 2)
      ? CellType.Empty
      : TOOL_CELL_TYPE[appState.activeTool];

    this._paintAt(e);
  };

  /**
   * Handles `pointermove`: continues painting while a button is held.
   *
   * @param e - Pointer event.
   */
  private readonly _onPointerMove = (e: PointerEvent): void => {
    if (!this._isPainting) return;
    e.preventDefault();
    this._paintAt(e);
  };

  /**
   * Handles `pointerup`: ends the paint gesture.
   *
   * @param e - Pointer event.
   */
  private readonly _onPointerUp = (e: PointerEvent): void => {
    if (!this._isPainting) return;
    e.preventDefault();
    this._isPainting = false;
  };

  /**
   * Handles `pointercancel` (e.g. system interruption): aborts painting.
   *
   * @param e - Pointer event.
   */
  private readonly _onPointerCancel = (_e: PointerEvent): void => {
    this._isPainting = false;
  };

  /**
   * Suppresses the browser context menu so right-click can be used to erase.
   *
   * @param e - Mouse event.
   */
  private readonly _onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  // -------------------------------------------------------------------------
  // Coordinate translation and brush application
  // -------------------------------------------------------------------------

  /**
   * Converts a PointerEvent's client coordinates to grid cell coordinates,
   * then applies the brush centred on that cell.
   *
   * Accounts for the CSS-vs-intrinsic-size ratio of the canvas element so
   * painting remains accurate even when the browser has scaled the canvas.
   *
   * @param e - The pointer event carrying `clientX` / `clientY`.
   */
  private _paintAt(e: PointerEvent): void {
    if (!this._canvas || !this._paintCell) return;

    const rect     = this._canvas.getBoundingClientRect();
    const cellSize = appState.cellSize;

    // Ratio between the canvas's intrinsic pixel size and its CSS display
    // size.  This handles browser zoom, high-DPI screens, and CSS scaling.
    const scaleX = this._canvas.width  / rect.width;
    const scaleY = this._canvas.height / rect.height;

    // Convert from CSS viewport coordinates → canvas pixels → cell indices.
    const cellX = Math.floor((e.clientX - rect.left) * scaleX / cellSize);
    const cellY = Math.floor((e.clientY - rect.top)  * scaleY / cellSize);

    this._applyBrush(cellX, cellY);
  }

  /**
   * Paints a circular disc brush centred at `(cx, cy)`.
   *
   * Brush sizes:
   *   - 1 → single cell (fast path, no loop)
   *   - N → all cells within radius (N - 1) of the centre (disc shape)
   *
   * Out-of-bounds cells are silently skipped.
   *
   * @param cx - Centre cell column (0-based).
   * @param cy - Centre cell row (0-based).
   */
  private _applyBrush(cx: number, cy: number): void {
    if (!this._paintCell) return;

    const gridWidth  = appState.gridWidth;
    const gridHeight = appState.gridHeight;
    const type       = this._paintType;

    if (appState.brushSize === 1) {
      // Fast path: single-cell brush — no inner loops.
      if (cx >= 0 && cx < gridWidth && cy >= 0 && cy < gridHeight) {
        this._paintCell(cx, cy, type);
      }
      return;
    }

    // Disc brush: all cells within radius `r` of the centre.
    // We compute r = brushSize - 1 so that brushSize=2 gives a 3×3 disc (r=1).
    const r  = appState.brushSize - 1;
    const r2 = r * r; // compare squared distances to avoid sqrt

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Inside the disc if dx²+dy² ≤ r².
        if (dx * dx + dy * dy <= r2) {
          const nx = cx + dx;
          const ny = cy + dy;
          // Bounds check — grid edges clip the disc.
          if (nx >= 0 && nx < gridWidth && ny >= 0 && ny < gridHeight) {
            this._paintCell(nx, ny, type);
          }
        }
      }
    }
  }
}
