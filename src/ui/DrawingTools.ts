/**
 * @fileoverview Canvas drawing tool handler for the What Simulator.
 *
 * Translates pointer (mouse / touch / pen) events on the simulation canvas
 * into cell-paint operations on the grid.  Reads the active tool and brush
 * size from {@link AppState} and delegates actual cell writes to a
 * caller-supplied callback.
 *
 * Pointer interaction contract:
 *   - Left-click + drag    → paint with the active tool
 *   - Right-click + drag   → erase (paint CellType.Empty)
 *   - Middle-click + drag  → pan the canvas-container (Phase 6)
 *   - Scroll wheel         → zoom in/out (Phase 6)
 *   - Hover (no button)    → fire `onHover` callback for the tooltip (Phase 6)
 *   - Context menu         → suppressed on the canvas (enables right-drag erase)
 *
 * Architecture: DrawingTools owns ONLY input mapping.  It never touches the
 * grid or renderer directly — the `paintCell` callback is the sole output.
 * This keeps the class testable and swappable for Phase 4 (Worker bridge).
 */

import { appState, type DrawingTool } from '../state/AppState.js';
import { CellType } from '../simulation/GridState.js';
import { bus } from '../state/EventBus.js';

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

  // --- Phase 6: pan state ---------------------------------------------------

  /** Whether a middle-button pan gesture is in progress. */
  private _isPanning = false;

  /**
   * Client-coordinate snapshot taken at the start of a pan gesture.
   * The delta from this point is applied to the container's scroll position.
   */
  private _panStartX = 0;
  private _panStartY = 0;

  /** Scroll-position snapshot taken at the start of a pan gesture. */
  private _scrollStartX = 0;
  private _scrollStartY = 0;

  /**
   * The scrollable container wrapping the canvas.
   * Populated in {@link mount}; used by middle-drag pan.
   */
  private _container: HTMLElement | null = null;

  /**
   * Most recently hovered cell coordinates.
   * Used to avoid firing redundant `cellHover` events when the pointer moves
   * within the same cell.
   */
  private _lastHoverX = -1;
  private _lastHoverY = -1;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attaches pointer event listeners to `canvas` and stores the paint
   * callback.  Call {@link unmount} to remove listeners when done.
   *
   * Phase 6: also attaches wheel (zoom) listener to `canvas` and resolves
   * the scrollable container from the canvas's parent for middle-drag pan.
   *
   * @param canvas    - The simulation `<canvas>` element.
   * @param paintCell - Callback invoked for every painted cell.
   */
  mount(canvas: HTMLCanvasElement, paintCell: PaintCellFn): void {
    this._canvas    = canvas;
    this._paintCell = paintCell;

    // Resolve the scrollable container for middle-drag pan (Phase 6).
    // The canvas lives inside #canvas-container which has overflow: auto.
    this._container = canvas.parentElement;

    canvas.addEventListener('pointerdown',   this._onPointerDown);
    canvas.addEventListener('pointermove',   this._onPointerMove);
    canvas.addEventListener('pointerup',     this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);
    canvas.addEventListener('contextmenu',   this._onContextMenu);
    canvas.addEventListener('mouseleave',    this._onMouseLeave);
    // Wheel zoom — must be non-passive to call preventDefault.
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
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
    this._canvas.removeEventListener('mouseleave',    this._onMouseLeave);
    this._canvas.removeEventListener('wheel',         this._onWheel);

    this._canvas     = null;
    this._paintCell  = null;
    this._container  = null;
    this._isPainting = false;
    this._isPanning  = false;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // Arrow functions used so `this` is always the DrawingTools instance even
  // when the browser calls back through addEventListener.
  // -------------------------------------------------------------------------

  /**
   * Handles `pointerdown`.
   *
   * - Left (button 0) or Right (button 2) → start painting/erasing.
   * - Middle (button 1) → start a pan gesture (Phase 6).
   *
   * @param e - Pointer event.
   */
  private readonly _onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    if (e.button === 1) {
      // Middle-click: begin pan gesture.
      this._isPanning    = true;
      this._panStartX    = e.clientX;
      this._panStartY    = e.clientY;
      this._scrollStartX = this._container?.scrollLeft ?? 0;
      this._scrollStartY = this._container?.scrollTop  ?? 0;
      return;
    }

    // Ignore any other buttons besides left (0) and right (2).
    if (e.button !== 0 && e.button !== 2) return;

    this._isPainting = true;
    // Right-click always erases, regardless of the active tool.
    this._paintType = (e.button === 2)
      ? CellType.Empty
      : TOOL_CELL_TYPE[appState.activeTool];

    this._paintAt(e);
  };

  /**
   * Handles `pointermove`.
   *
   * While painting: continues brush strokes.
   * While panning:  scrolls the canvas container (Phase 6).
   * Otherwise:      emits `cellHover` for the tooltip (Phase 6).
   *
   * @param e - Pointer event.
   */
  private readonly _onPointerMove = (e: PointerEvent): void => {
    if (this._isPainting) {
      e.preventDefault();
      this._paintAt(e);
      return;
    }

    if (this._isPanning && this._container) {
      e.preventDefault();
      this._container.scrollLeft = this._scrollStartX + (this._panStartX - e.clientX);
      this._container.scrollTop  = this._scrollStartY + (this._panStartY - e.clientY);
      return;
    }

    // No button held — emit hover coordinates for the tooltip.
    this._emitHover(e);
  };

  /**
   * Handles `pointerup`: ends the paint or pan gesture.
   *
   * @param e - Pointer event.
   */
  private readonly _onPointerUp = (e: PointerEvent): void => {
    if (e.button === 1) {
      this._isPanning = false;
      return;
    }
    if (!this._isPainting) return;
    e.preventDefault();
    this._isPainting = false;
  };

  /**
   * Handles `pointercancel` (e.g. system interruption): aborts all gestures.
   */
  private readonly _onPointerCancel = (_e: PointerEvent): void => {
    this._isPainting = false;
    this._isPanning  = false;
  };

  /**
   * Suppresses the browser context menu so right-click can be used to erase.
   *
   * @param e - Mouse event.
   */
  private readonly _onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  /**
   * Fires a `cellHover` event with `(-1, -1)` when the pointer leaves the
   * canvas, so the tooltip is hidden.  Phase 6.
   */
  private readonly _onMouseLeave = (): void => {
    this._lastHoverX = -1;
    this._lastHoverY = -1;
    bus.emit('cellHover', { cellX: -1, cellY: -1 });
  };

  /**
   * Handles the scroll-wheel event for zoom.
   *
   * Scrolling up → zoom in (increase cellSize); scrolling down → zoom out.
   * `cellSize` is clamped to [1, 8] by `AppState.cellSize` setter.
   * Phase 6.
   *
   * @param e - WheelEvent.
   */
  private readonly _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    appState.cellSize = appState.cellSize + delta;
  };

  /**
   * Converts pointer coordinates to cell coordinates and emits `cellHover`
   * only when the hovered cell has actually changed.  This avoids flooding
   * the EventBus when the pointer moves within the same cell.
   * Phase 6.
   *
   * @param e - The pointer event carrying `clientX` / `clientY`.
   */
  private _emitHover(e: PointerEvent): void {
    if (!this._canvas) return;

    const rect     = this._canvas.getBoundingClientRect();
    const cellSize = appState.cellSize;
    const scaleX   = this._canvas.width  / rect.width;
    const scaleY   = this._canvas.height / rect.height;

    const cellX = Math.floor((e.clientX - rect.left) * scaleX / cellSize);
    const cellY = Math.floor((e.clientY - rect.top)  * scaleY / cellSize);

    // Skip if same cell as last tick.
    if (cellX === this._lastHoverX && cellY === this._lastHoverY) return;
    this._lastHoverX = cellX;
    this._lastHoverY = cellY;

    bus.emit('cellHover', { cellX, cellY });
  }

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
