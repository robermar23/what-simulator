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

import { CellType }                           from './simulation/GridState.js';
import { variantRegistry }                    from './simulation/genetics/VariantRegistry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Snapshot of a single grid cell's current state.
 * Returned by {@link App.getCellInfo} and used to populate the hover tooltip.
 * Phase 6.
 */
export interface CellInfo {
  /** Grid column index (0-based). */
  readonly cellX: number;
  /** Grid row index (0-based). */
  readonly cellY: number;
  /** Raw CellType enum value. */
  readonly cellType: number;
  /** Energy level [0, 1]. */
  readonly energy: number;
  /** Age in simulation ticks. */
  readonly age: number;
}
import { allocateSharedGrid, makeControlView, makeBufferViews, CTRL_FRONT_IDX } from './workers/sharedBuffers.js';
import { appState }                          from './state/AppState.js';
import { bus }                               from './state/EventBus.js';
import { FpsCounter }                        from './utils/performance.js';
import { type SimWorkerInMsg, type SimWorkerOutMsg }       from './workers/workerBridge.js';
import { type RenderWorkerInMsg, type RenderWorkerOutMsg } from './workers/workerBridge.js';
import { ENVIRONMENT_TINTS }                               from './rendering/BackgroundRenderer.js';

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

  // --- SAB front-buffer access (for OverlayRenderer) -----------------------

  /**
   * Int32Array control section of the SharedArrayBuffer.
   * Used to determine which buffer set is currently the display front so
   * `getWellIndices` can read GravityWell positions without racing the sim.
   */
  private readonly _ctrl: Int32Array;

  /**
   * Typed views into the two SAB buffer sets.
   * Index 0 = set 0, index 1 = set 1.  The control section's CTRL_FRONT_IDX
   * tells us which set is currently authoritative.
   */
  private readonly _sabViews: [ReturnType<typeof makeBufferViews>, ReturnType<typeof makeBufferViews>];

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

    const sab        = allocateSharedGrid(appState.gridWidth, appState.gridHeight);
    const totalCells = appState.gridWidth * appState.gridHeight;

    // Keep main-thread SAB views so getWellIndices() can scan the front buffer
    // without posting messages to the sim worker.
    this._ctrl     = makeControlView(sab);
    this._sabViews = [
      makeBufferViews(sab, totalCells, 0),
      makeBufferViews(sab, totalCells, 1),
    ];

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
      type:         'init',
      canvas:       offscreen,
      sab,
      width:        appState.gridWidth,
      height:       appState.gridHeight,
      cellSize:     appState.cellSize,
      // Phase 7: pass the desired backend so the worker acquires the right
      // context type from the OffscreenCanvas before any other context is
      // created.  An OffscreenCanvas can hold only one context type.
      rendererType: appState.rendererType,
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

    // -----------------------------------------------------------------------
    // 7. Push the initial render mode to the RenderWorker.
    //    `appState._renderMode` is set in the class body (not the setter),
    //    so no `renderModeChange` event fires at construction time.  We must
    //    explicitly tell the RenderWorker which mode is active so it does not
    //    silently stay in its hardcoded 'default' mode.
    // -----------------------------------------------------------------------

    this._renderWorker.postMessage({
      type: 'renderModeChange',
      mode: appState.renderMode,
    } as RenderWorkerInMsg);
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

  /**
   * Scans the SAB front buffer and returns all flat indices of GravityWell
   * cells.  Used by the OverlayRenderer in `main.ts` to know where to draw
   * directional arrows without messaging the simulation worker.
   *
   * Reads are done directly from the SharedArrayBuffer.  The seqlock is NOT
   * checked here — a slightly torn read is acceptable since the overlay is a
   * visual hint, not simulation data.  Missing a single frame of arrow update
   * is invisible to the user.
   *
   * @returns Array of flat cell indices where CellType === GravityWell.
   */
  getWellIndices(): readonly number[] {
    const frontIdx  = Atomics.load(this._ctrl, CTRL_FRONT_IDX) as 0 | 1;
    const cellType  = this._sabViews[frontIdx].cellType;
    const wells: number[] = [];
    // CellType.GravityWell = 6 (const enum — inline the value to avoid
    // importing the enum into a non-worker context).
    for (let i = 0; i < cellType.length; i++) {
      if (cellType[i] === 6 /* CellType.GravityWell */) wells.push(i);
    }
    return wells;
  }

  /**
   * Returns a snapshot of the cell at grid coordinates `(cellX, cellY)`,
   * or `null` if the coordinates are out-of-bounds.
   *
   * Reads directly from the SAB front buffer without messaging the sim worker.
   * A slightly torn read is acceptable here — the tooltip is a visual hint,
   * not authoritative simulation data.  The seqlock is intentionally NOT
   * checked so this never blocks the main thread.
   *
   * @param cellX - Grid column index (0-based).
   * @param cellY - Grid row index (0-based).
   * @returns Cell info, or null if out of bounds.
   */
  getCellInfo(cellX: number, cellY: number): CellInfo | null {
    const w = appState.gridWidth;
    const h = appState.gridHeight;
    if (cellX < 0 || cellX >= w || cellY < 0 || cellY >= h) return null;

    const frontIdx = Atomics.load(this._ctrl, CTRL_FRONT_IDX) as 0 | 1;
    const views    = this._sabViews[frontIdx];
    const idx      = cellY * w + cellX;

    return {
      cellX,
      cellY,
      cellType: views.cellType[idx],
      energy:   views.energy[idx],
      age:      views.age[idx],
    };
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
        // Bootstrap the variant registry so variant 0 (the base Life seed)
        // is registered and livingCount starts at 1.
        variantRegistry.bootstrap();
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
            tickNum:       msg.tickNum,
            liveCells:     msg.liveCells + msg.variantCells,
            variantCells:  msg.variantCells,
            predatorCells: msg.predatorCells,
            sporeCells:    msg.sporeCells,
          });
        }
        break;
      }

      // --- Phase 11: variant lifecycle events --------------------------------

      case 'variantCreated':
        // A new lineage has diverged ≥3 bits from its parent genome.
        // Register it in the main-thread VariantRegistry for history tracking
        // and phylogenetic tree display.
        variantRegistry.registerVariant(
          msg.variantId,
          msg.parentId,
          msg.tick,
          msg.genome,
        );
        break;

      case 'variantExtinct':
        // A lineage's population just dropped to zero.
        // Update the registry so it is marked as extinct and no longer
        // counted in `livingCount`.
        variantRegistry.markExtinct(msg.variantId, msg.tick, msg.peakPop);
        break;

      case 'variantCensus':
        // Population snapshot broadcast every `censusInterval` ticks.
        // Update peak populations in the registry, then re-emit on the
        // EventBus so the ControlPanel Evolution section can display a live
        // variant count.
        variantRegistry.onCensus(msg.data);
        bus.emit('variantCensus', {
          census:         msg.data,
          livingVariants: variantRegistry.livingCount,
        });
        break;

      case 'environmentApplied':
        // Round 5: obstacle generation and life re-seeding are complete.
        // Invalidate the render worker's dirty-region cache so the new layout
        // is fully redrawn on the next frame.
        this._renderWorker.postMessage({ type: 'invalidate' } as RenderWorkerInMsg);
        bus.emit('environmentApplied', {});
        break;
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
    // Phase 21: also forward predatorGenomeThreshold to the render worker so the
    // predprey render mode can classify Life cells as predator vs prey in GLSL.
    bus.on('configChange', ({ config }) => {
      const msg: SimWorkerInMsg = { type: 'configUpdate', config };
      this._simWorker.postMessage(msg);
      const thresholdMsg: RenderWorkerInMsg = {
        type:      'predatorThresholdChange',
        rawUint16: config.predatorGenomeThreshold,
      };
      this._renderWorker.postMessage(thresholdMsg);
    });

    // Reset — stop the sim, re-seed, force a full render redraw.
    bus.on('reset', () => {
      // Pause first so the worker isn't mid-tick during reset.
      appState.running = false;

      // Re-bootstrap the variant registry so variant 0 is re-registered and
      // all extinct lineage history is cleared for the fresh grid.
      variantRegistry.bootstrap();

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

    // Grid lines toggle (Phase 6) — forward to the render worker so it can
    // enable/disable grid-line drawing in its rAF loop.
    bus.on('gridLinesChange', ({ show }) => {
      const msg: RenderWorkerInMsg = { type: 'gridLinesChange', show };
      this._renderWorker.postMessage(msg);
    });

    // Render mode change (Phase 10/11) — forward to the render worker so it
    // switches the active visualisation mode on the next rAF frame.
    bus.on('renderModeChange', ({ mode }) => {
      const msg: RenderWorkerInMsg = { type: 'renderModeChange', mode };
      this._renderWorker.postMessage(msg);
    });

    // Phase 18: alive-detail slider — forward to the render worker so the
    // WebGL renderer updates its u_aliveDetail uniform on the next frame.
    bus.on('aliveDetailChange', ({ value }) => {
      const msg: RenderWorkerInMsg = { type: 'aliveDetailChange', value };
      this._renderWorker.postMessage(msg);
    });

    // Background change (Phase 14) — forward to the render worker so it
    // toggles transparent-empty-cell rendering to show the background through.
    bus.on('backgroundChange', ({ type }) => {
      const msg: RenderWorkerInMsg = {
        type: 'backgroundChange',
        backgroundActive: type !== 'none',
        backgroundType: type,
        tint: ENVIRONMENT_TINTS[type],
      };
      this._renderWorker.postMessage(msg);
    });

    // Round 5: environment preset application.
    // 1. Switch the renderer background immediately (visual feedback).
    // 2. Pause the sim, tell the SimWorker to generate obstacles + re-seed.
    // 3. The SimWorker posts 'environmentApplied' when done (handled above).
    bus.on('applyEnvironment', ({ backgroundType, spec, seedDensityOverride }) => {
      // Switch background immediately so the user sees feedback while
      // the obstacle generator runs in the worker.
      const bgMsg: RenderWorkerInMsg = {
        type:             'backgroundChange',
        backgroundActive: backgroundType !== 'none',
        backgroundType,
        tint:             ENVIRONMENT_TINTS[backgroundType],
      };
      this._renderWorker.postMessage(bgMsg);

      // Pause the sim loop during environment generation to prevent races.
      appState.running = false;

      // Reset variant registry for the fresh life seed.
      variantRegistry.bootstrap();

      const density = seedDensityOverride ?? appState.initialDensity;
      const envMsg: SimWorkerInMsg = {
        type:          'applyEnvironment',
        spec,
        seedDensity:   density,
        initialEnergy: appState.config.initialEnergy,
      };
      this._simWorker.postMessage(envMsg);
    });
  }
}
