/**
 * @fileoverview BackgroundManager — owns the background canvas and animation
 * loop for Phase 14 environment backgrounds.
 *
 * The background canvas (`#bg-canvas`) sits BEHIND the simulation canvas
 * inside `#canvas-frame`.  Both canvases are always the same pixel size:
 * `appState.gridWidth × appState.cellSize` × `appState.gridHeight × appState.cellSize`.
 *
 * Sizing is derived from `appState` directly, not from the DOM canvas element,
 * because after `transferControlToOffscreen()` the main-thread HTMLCanvasElement
 * dimensions may not be populated until after the first RenderWorker frame.
 */

import { type Background, type BackgroundType, createBackground } from './BackgroundRenderer.js';
import { bus }      from '../state/EventBus.js';
import { appState } from '../state/AppState.js';

// ---------------------------------------------------------------------------
// BackgroundManager class
// ---------------------------------------------------------------------------

/**
 * Manages the background canvas animation loop.
 *
 * Mount once after the DOM is ready; all further changes are driven by
 * EventBus subscriptions.
 */
export class BackgroundManager {
  /** The background canvas element (`#bg-canvas`). */
  private _canvas: HTMLCanvasElement | null = null;

  /** 2D context of the background canvas. */
  private _ctx: CanvasRenderingContext2D | null = null;

  /** Currently active background renderer. `null` when type === 'none'. */
  private _background: Background | null = null;

  /** Monotonically increasing frame counter passed to `background.render()`. */
  private _frame = 0;

  /** RAF handle; 0 when the loop is not running. */
  private _rafHandle = 0;

  /** Active background type key — used to skip redundant transitions. */
  private _activeType: BackgroundType = 'none';

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Mounts the manager onto `bgCanvas` and subscribes to EventBus events.
   *
   * @param bgCanvas - The background canvas element (`#bg-canvas`).
   */
  mount(bgCanvas: HTMLCanvasElement): void {
    this._canvas = bgCanvas;
    const ctx = bgCanvas.getContext('2d');
    if (!ctx) throw new Error('BackgroundManager: failed to acquire Canvas 2D context.');
    this._ctx = ctx;

    // Size the canvas immediately from appState (guaranteed correct).
    this._syncSize();

    // Re-size whenever zoom or grid changes — both alter the pixel dimensions.
    bus.on('cellSizeChange', () => this._syncSize());
    bus.on('reset',          () => this._syncSize());

    // Switch backgrounds when the user picks one from the dropdown.
    bus.on('backgroundChange', ({ type }) => void this._switchBackground(type));
  }

  /**
   * Programmatically activates a background type.
   *
   * Called from `main.ts` on startup to restore the persisted background.
   *
   * @param type - The background to activate.
   */
  async setBackground(type: BackgroundType): Promise<void> {
    await this._switchBackground(type);
  }

  /** Returns the pixel size the bg-canvas should be at the current settings. */
  expectedSize(): { width: number; height: number } {
    return {
      width:  appState.gridWidth  * appState.cellSize,
      height: appState.gridHeight * appState.cellSize,
    };
  }

  /** Stops the RAF loop and clears the canvas. Call when tearing down. */
  destroy(): void {
    this._stopLoop();
    if (this._ctx && this._canvas) {
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Sets the background canvas pixel dimensions to exactly match the
   * simulation grid at the current cell size.
   *
   * Always derived from `appState` rather than reading the DOM canvas so
   * this is correct even before the RenderWorker has rendered its first frame.
   */
  private _syncSize(): void {
    if (!this._canvas) return;
    const { width, height } = this.expectedSize();
    // Fallback to 512 if appState hasn't been populated yet (shouldn't happen).
    this._canvas.width  = width  > 0 ? width  : 512;
    this._canvas.height = height > 0 ? height : 512;
  }

  /**
   * Switches the active background to `type`.
   *
   * Stops the current RAF loop, re-syncs canvas size, then dynamically imports
   * and starts the new background.
   *
   * @param type - Target background type.
   */
  private async _switchBackground(type: BackgroundType): Promise<void> {
    if (type === this._activeType) return;
    this._activeType = type;
    this._stopLoop();

    // Always re-sync size on switch — the grid may have changed since mount.
    this._syncSize();

    if (type === 'none') {
      if (this._ctx && this._canvas) {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      }
      this._background = null;
      return;
    }

    this._background = await createBackground(type);
    this._frame      = 0;
    this._startLoop();
  }

  /** Starts the RAF render loop (no-op if already running). */
  private _startLoop(): void {
    if (this._rafHandle !== 0) return;
    const tick = (): void => {
      this._renderFrame();
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);
  }

  /** Cancels the RAF render loop. Safe to call when already stopped. */
  private _stopLoop(): void {
    if (this._rafHandle !== 0) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = 0;
    }
  }

  /**
   * Renders one animation frame to the background canvas.
   * Automatically re-syncs dimensions if the canvas size drifted.
   */
  private _renderFrame(): void {
    const ctx    = this._ctx;
    const canvas = this._canvas;
    const bg     = this._background;
    if (!ctx || !canvas || !bg) return;

    // Guard against canvas size drift (e.g. after zoom without a resize event).
    const { width, height } = this.expectedSize();
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width  = width  > 0 ? width  : canvas.width;
      canvas.height = height > 0 ? height : canvas.height;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    bg.render(ctx, canvas.width, canvas.height, this._frame);
    this._frame++;
  }
}
