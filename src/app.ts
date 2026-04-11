/**
 * @fileoverview Top-level application orchestrator for the What Simulator.
 *
 * Phase 4 rewrite: `App` no longer owns `GridState`, `SimulationEngine`, or
 * `Renderer` directly.  Instead it:
 *
 *   1. Allocates a `SharedArrayBuffer` for zero-copy grid state sharing.
 *   2. Spawns a `SimulationWorker` that runs the tick loop off-thread.
 *   3. Spawns a `RenderWorker` that drives the OffscreenCanvas rAF loop.
 *   4. Transfers the canvas element to the RenderWorker so the main thread
 *      never touches pixels directly.
 *   5. Routes `EventBus` events to workers via typed `postMessage` calls.
 *   6. Forwards incoming worker messages back to the `EventBus` so the rest
 *      of the UI (status bar, ControlPanel) is unaffected by the move to
 *      workers.
 *
 * The public API surface (`.start()`, `.paintCell()`) is intentionally
 * unchanged from Phase 1–3 so `main.ts` and `DrawingTools` need no edits.
 *
 * ## Data flow
 *
 * ```
 * EventBus                App (main thread)            Workers
 * ─────────               ──────────────────           ───────
 * playStateChange  ──►  postMessage('play/pause')  ──► SimWorker
 * speedChange      ──►  postMessage('speedChange') ──► SimWorker
 * configChange     ──►  postMessage('configUpdate')──► SimWorker
 * reset            ──►  postMessage('reset')        ──► SimWorker
 *                        postMessage('invalidate')  ──► RenderWorker
 * cellSizeChange   ──►  postMessage('cellSizeChange')─► RenderWorker
 * snapshotRequested──►  postMessage('snapshot')     ──► RenderWorker
 *
 * SimWorker   ──► onmessage('tick')         ──► bus.emit('fpsUpdate')
 * RenderWorker──► onmessage('snapshotBlob') ──► bus.emit('snapshotReady')
 * ```
 */

import { CellType }                          from './simulation/GridState.js';
import { allocateSharedGrid }                from './workers/sharedBuffers.js';
import { appState }                          from './state/AppState.js';
import { bus }                               from './state/EventBus.js';
import { FpsCounter }                        from './utils/performance.js';
import { type SimWorkerInMsg, type SimWorkerOutMsg }       from './workers/workerBridge.js';
import { type RenderWorkerInMsg, type RenderWorkerOutMsg } from './workers/workerBridge.js';

// ---------------------------------------------------------------------------
// App class
// ---------------------------------------------------------------------------

/**
 * Main application controller for Phase 4+.
 *
 * Instantiate once with the `<canvas>` element and call {@link App.start}.
 */
export class App {
  // --- Workers ---------------------------------------------------------------

  /** Web Worker running the simulation tick loop. */
  private readonly _simWorker: Worker;

  /** Web Worker running the OffscreenCanvas render loop. */
  private readonly _renderWorker: Worker;

  // --- Canvas (kept for DrawingTools pointer-event wiring) ------------------

  /**
   * The original DOM canvas element.
   *
   * After `transferControlToOffscreen()` the main thread can no longer call
   * `getContext()` or read pixels from this element, but it can still receive
   * pointer events — so DrawingTools continues to attach listeners here.
   */
  readonly canvas: HTMLCanvasElement;

  // --- FPS tracking (main-thread side) --------------------------------------

  /**
   * Smoothed "sim ticks per second" counter.
   *
   * The render rAF loop lives in the RenderWorker, so we can no longer
   * measure render FPS directly on the main thread.  Instead we count
   * `SimWorkerOutMsg` tick messages, which arrive at the configured sim Hz.
   * At 60 Hz this matches render FPS closely enough for the status bar.
   */
  private readonly _fpsCounter = new FpsCounter(60);

  /**
   * @param canvas - The `<canvas>` element to hand off to the RenderWorker.
   */
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // -----------------------------------------------------------------------
    // 1. Allocate SharedArrayBuffer for zero-copy grid sharing.
    // -----------------------------------------------------------------------

    const sab = allocateSharedGrid(appState.gridWidth, appState.gridHeight);

    // -----------------------------------------------------------------------
    // 2. Spawn workers via Vite's worker-bundling syntax.
    //    Each `new URL(…, import.meta.url)` tells Vite to bundle the file as
    //    a separate worker chunk so it can safely use `self` / `importScripts`.
    // -----------------------------------------------------------------------

    this._simWorker = new Worker(
      new URL('./simulation/SimulationWorker.ts', import.meta.url),
      { type: 'module' },
    );

    this._renderWorker = new Worker(
      new URL('./rendering/RenderWorker.ts', import.meta.url),
      { type: 'module' },
    );

    // -----------------------------------------------------------------------
    // 3. Transfer the canvas to the RenderWorker.
    //    After this call the main thread loses direct access to canvas pixels.
    //    DrawingTools can still attach pointer listeners to the DOM element.
    // -----------------------------------------------------------------------

    const offscreen = canvas.transferControlToOffscreen();

    const renderInit: RenderWorkerInMsg = {
      type:     'init',
      canvas:   offscreen,
      sab,
      width:    appState.gridWidth,
      height:   appState.gridHeight,
      cellSize: appState.cellSize,
    };
    // `offscreen` must be listed in the transferables array — it is a
    // `Transferable` that can only live in one thread at a time.
    this._renderWorker.postMessage(renderInit, [offscreen]);

    // -----------------------------------------------------------------------
    // 4. Initialise the SimulationWorker with the same SAB.
    //    The SAB is *shared* (not transferred) so both workers and the main
    //    thread can all hold references to it simultaneously.
    // -----------------------------------------------------------------------

    const simInit: SimWorkerInMsg = {
      type: 'init',
      payload: {
        sab,
        width:         appState.gridWidth,
        height:        appState.gridHeight,
        config:        appState.config,
        density:       appState.initialDensity,
        initialEnergy: appState.config.initialEnergy,
      },
    };
    this._simWorker.postMessage(simInit);

    // -----------------------------------------------------------------------
    // 5. Wire incoming worker messages → EventBus / downloads.
    // -----------------------------------------------------------------------

    this._simWorker.onmessage    = (e: MessageEvent<SimWorkerOutMsg>) =>
      this._onSimMessage(e.data);

    this._renderWorker.onmessage = (e: MessageEvent<RenderWorkerOutMsg>) =>
      this._onRenderMessage(e.data);

    // -----------------------------------------------------------------------
    // 6. Subscribe to EventBus to forward UI interactions to the workers.
    // -----------------------------------------------------------------------

    this._subscribeToEvents();
  }

  // -------------------------------------------------------------------------
  // Public API (unchanged surface from Phase 1–3)
  // -------------------------------------------------------------------------

  /**
   * Called once from `main.ts` after construction.
   *
   * In Phase 4 the workers are already running their loops after `init` — the
   * RenderWorker starts its rAF loop immediately, and the SimWorker waits for
   * a `play` message.  Nothing extra is needed here.
   */
  start(): void {
    // Render loop started automatically in RenderWorker on 'init'.
    // Sim loop starts when the user clicks Play (bus → 'play' message).
  }

  /**
   * Paints a single cell at grid coordinates `(cellX, cellY)`.
   *
   * Sends an `editCmd` to the SimulationWorker, which writes the change to
   * both its local `GridState` and the SAB front buffer so the RenderWorker
   * sees the updated pixel on the very next animation frame — even while
   * the simulation is paused.
   *
   * @param cellX - Column index (0-based).
   * @param cellY - Row index (0-based).
   * @param type  - The {@link CellType} to place at that coordinate.
   */
  paintCell(cellX: number, cellY: number, type: CellType): void {
    const idx = cellX + cellY * appState.gridWidth;

    // For Life cells, use the configured initial energy; obstacles default to
    // their own energy logic inside SimulationWorker.applyEdit.
    const energy = (type === CellType.Life || type === CellType.LifeVariant)
      ? appState.config.initialEnergy
      : 1.0;

    const msg: SimWorkerInMsg = { type: 'editCmd', index: idx, cellType: type, energy };
    this._simWorker.postMessage(msg);
  }

  // -------------------------------------------------------------------------
  // Incoming SimulationWorker messages
  // -------------------------------------------------------------------------

  /**
   * Handles all messages posted by the SimulationWorker.
   *
   * @param msg - Typed discriminated-union message from the worker.
   */
  private _onSimMessage(msg: SimWorkerOutMsg): void {
    switch (msg.type) {

      case 'ready':
        // Worker has finished its `init` handler and is waiting for 'play'.
        // Nothing to do — the render loop already started independently.
        break;

      case 'tick': {
        // Tick messages arrive at the configured sim Hz.
        // We use their timestamps to compute "sim ticks per second" as a
        // proxy for the status-bar FPS display.
        this._fpsCounter.frame(performance.now());
        const fps = this._fpsCounter.fps;

        // Emit fpsUpdate every 15 ticks (~4 Hz at 60 Hz sim rate) to avoid
        // flooding the DOM with status-bar updates.
        if (msg.tickNum % 15 === 0 || msg.tickNum < 2) {
          bus.emit('fpsUpdate', {
            fps,
            tickNum:      msg.tickNum,
            liveCells:    msg.liveCells + msg.variantCells,
            variantCells: msg.variantCells,
          });
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Incoming RenderWorker messages
  // -------------------------------------------------------------------------

  /**
   * Handles all messages posted by the RenderWorker.
   *
   * @param msg - Typed discriminated-union message from the worker.
   */
  private _onRenderMessage(msg: RenderWorkerOutMsg): void {
    switch (msg.type) {

      case 'snapshotBlob':
        // Forward the blob URL to the EventBus.
        // `main.ts` listens to `snapshotReady` and triggers the download link.
        bus.emit('snapshotReady', { url: msg.url });
        break;
    }
  }

  // -------------------------------------------------------------------------
  // EventBus subscriptions → worker messages
  // -------------------------------------------------------------------------

  /**
   * Wires all EventBus events to the appropriate worker `postMessage` calls.
   * Called once during construction.
   */
  private _subscribeToEvents(): void {

    // Play / Pause — toggle the sim tick loop.
    bus.on('playStateChange', ({ running }) => {
      this._simWorker.postMessage(
        running
          ? ({ type: 'play' }  as SimWorkerInMsg)
          : ({ type: 'pause' } as SimWorkerInMsg),
      );
    });

    // Speed — change the tick interval inside the sim worker.
    bus.on('speedChange', ({ hz }) => {
      const msg: SimWorkerInMsg = { type: 'speedChange', hz };
      this._simWorker.postMessage(msg);
    });

    // Config — update simulation parameters for the next tick.
    bus.on('configChange', ({ config }) => {
      const msg: SimWorkerInMsg = { type: 'configUpdate', config };
      this._simWorker.postMessage(msg);
    });

    // Reset — stop the sim, re-seed, force a full render redraw.
    bus.on('reset', () => {
      // Pause first so the worker isn't mid-tick during reset.
      appState.running = false;

      const resetMsg: SimWorkerInMsg = {
        type:          'reset',
        density:       appState.initialDensity,
        initialEnergy: appState.config.initialEnergy,
      };
      this._simWorker.postMessage(resetMsg);

      // Tell the render worker to discard its dirty-region cache.
      const invalidateMsg: RenderWorkerInMsg = { type: 'invalidate' };
      this._renderWorker.postMessage(invalidateMsg);
    });

    // Cell size — re-zoom the renderer inside the render worker.
    bus.on('cellSizeChange', ({ cellSize }) => {
      const msg: RenderWorkerInMsg = { type: 'cellSizeChange', cellSize };
      this._renderWorker.postMessage(msg);
    });

    // Snapshot — delegate to the render worker (main thread can't read pixels
    // after `transferControlToOffscreen`).
    bus.on('snapshotRequested', () => {
      const msg: RenderWorkerInMsg = { type: 'snapshot' };
      this._renderWorker.postMessage(msg);
    });

    // Step (single tick while paused) — fired via DOM custom event from
    // Toolbar's Step button.
    window.addEventListener('step-requested', () => {
      if (!appState.running) {
        this._simWorker.postMessage({ type: 'step' } as SimWorkerInMsg);
      }
    });
  }
}
