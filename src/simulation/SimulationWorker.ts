/**
 * @fileoverview Simulation Web Worker entry point for the What Simulator.
 *
 * This file runs entirely off the main thread in a dedicated `Worker`.
 * It owns:
 *   - A local double-buffered `GridState` used for per-tick computation.
 *   - A `SimulationEngine` instance (pure tick logic).
 *   - A `setInterval`-driven tick loop.
 *   - SharedArrayBuffer views (written after each tick via a seqlock).
 *
 * ## Message protocol
 *
 * The worker receives typed `SimWorkerInMsg` messages from the main thread
 * (see `workerBridge.ts`) and posts typed `SimWorkerOutMsg` messages back.
 *
 * ## Seqlock write protocol
 *
 * After each tick, the computed grid is written into the SAB's **back**
 * buffer set and the front pointer is atomically swapped:
 *
 * ```
 * backIdx = 1 - Atomics.load(ctrl, CTRL_FRONT_IDX)
 * Atomics.add(ctrl, CTRL_SEQ, 1)          // seq → odd  (write in progress)
 * sabViews[backIdx].*  ← local grid.front
 * Atomics.add(ctrl, CTRL_SEQ, 1)          // seq → even (write complete)
 * Atomics.store(ctrl, CTRL_FRONT_IDX, backIdx)  // swap front pointer
 * Atomics.add(ctrl, CTRL_TICK_COUNT, 1)   // publish tick number
 * ```
 *
 * The render worker reads from `sab[frontIdx]` and validates consistency
 * using the seqlock values around the read — see `RenderWorker.ts`.
 */

// Workers use `self` for the global scope instead of `window`.
// TypeScript's `lib.webworker.d.ts` provides the correct types when this
// file is bundled as a worker by Vite (via `new URL(…, import.meta.url)`).

import { GridState, CellType, type GridBuffers } from './GridState.js';
import { SimulationEngine }                      from './SimulationEngine.js';
import { defaultConfig, type SimulationConfig }  from './config/SimulationConfig.js';
import {
  makeControlView,
  makeBufferViews,
  CTRL_SEQ,
  CTRL_FRONT_IDX,
  CTRL_TICK_COUNT,
} from '../workers/sharedBuffers.js';
import { type SimWorkerInMsg, type SimWorkerOutMsg } from '../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

/** Local double-buffered grid used for tick computation. */
let grid: GridState;
/** Simulation tick engine — pure functions over TypedArrays. */
let engine: SimulationEngine;
/** Current simulation parameters. */
let config: SimulationConfig = defaultConfig();
/** Grid width in cells. */
let width  = 0;
/** Grid height in cells. */
let height = 0;

/** Int32Array control section of the SharedArrayBuffer. */
let ctrl: Int32Array;

/**
 * Two `GridBuffers` views into the SAB — one per buffer set.
 * `sabViews[0]` is buffer set 0; `sabViews[1]` is buffer set 1.
 */
const sabViews: [GridBuffers | null, GridBuffers | null] = [null, null];

/** Interval ID for the tick loop, or null when paused. */
let tickIntervalId: ReturnType<typeof setInterval> | null = null;

/** Monotonic tick number. */
let tickNum = 0;

// ---------------------------------------------------------------------------
// Seqlock write — publishes one tick's result to the SAB
// ---------------------------------------------------------------------------

/**
 * Copies the local `grid.front` buffers into the SAB back buffer set using
 * the seqlock protocol, then atomically swaps the front pointer.
 *
 * This is the ONLY place where the sim worker writes to the SAB.
 */
function publishToSab(): void {
  // Determine which SAB set is currently the "back" (not being displayed).
  const frontIdx = Atomics.load(ctrl, CTRL_FRONT_IDX);
  const backIdx  = (1 - frontIdx) as 0 | 1;
  const view     = sabViews[backIdx]!;
  const local    = grid.front;

  // --- Seqlock: mark write in progress (seq → odd) -------------------------
  Atomics.add(ctrl, CTRL_SEQ, 1);

  // Bulk-copy each TypedArray from the local grid into the SAB back set.
  // TypedArray.set() is essentially a memcpy — the fastest way to do this.
  view.cellType.set(local.cellType);
  view.energy.set(local.energy);
  view.age.set(local.age);
  view.flags.set(local.flags);

  // --- Seqlock: mark write complete (seq → even) ---------------------------
  Atomics.add(ctrl, CTRL_SEQ, 1);

  // Atomically swap the front pointer so the render worker reads the new data.
  Atomics.store(ctrl, CTRL_FRONT_IDX, backIdx);
  // Increment the global tick counter.
  Atomics.add(ctrl, CTRL_TICK_COUNT, 1);
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

/**
 * Executes one simulation tick:
 * 1. Copies front → back locally (so the engine has a clean back buffer).
 * 2. Runs `SimulationEngine.tick()`.
 * 3. Swaps local buffers.
 * 4. Publishes the result to the SAB via the seqlock.
 * 5. Posts tick statistics back to the main thread.
 */
function tick(): void {
  grid.copyFrontToBack();

  const stats = engine.tick(grid.front, grid.back, config);

  grid.swap();
  tickNum++;

  // Publish the new state to shared memory so the render worker sees it.
  publishToSab();

  // Post tick statistics to the main thread for the status bar / EventBus.
  const msg: SimWorkerOutMsg = {
    type:         'tick',
    tickNum,
    liveCells:    stats.liveCells,
    variantCells: stats.variantCells,
    births:       stats.births,
    deaths:       stats.deaths,
  };
  self.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Tick loop control
// ---------------------------------------------------------------------------

/**
 * Starts the simulation tick loop at `hz` ticks per second.
 * Cancels any existing interval first.
 *
 * @param hz - Target tick rate in Hz (1–60).
 */
function startLoop(hz: number): void {
  stopLoop();
  tickIntervalId = setInterval(tick, 1000 / hz);
}

/**
 * Stops the simulation tick loop.
 */
function stopLoop(): void {
  if (tickIntervalId !== null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
}

// ---------------------------------------------------------------------------
// editCmd helper — writes a cell edit to both local GridState and the SAB
// ---------------------------------------------------------------------------

/**
 * Paints a single cell on the local `GridState` AND immediately writes the
 * change to the SAB front buffer so the render worker sees it without
 * waiting for the next full tick.
 *
 * @param index    - Flat cell index.
 * @param cellType - New cell type.
 * @param energy   - New energy value.
 */
function applyEdit(index: number, cellType: number, energy: number): void {
  // Write to the local double-buffered grid.
  grid.paintCell(index, cellType as CellType, energy);

  // Immediately mirror the change in the SAB front buffer so the render
  // worker sees it on the very next animation frame (even while paused).
  const frontIdx = Atomics.load(ctrl, CTRL_FRONT_IDX) as 0 | 1;
  const view     = sabViews[frontIdx]!;
  view.cellType[index] = cellType;
  view.energy[index]   = energy;
  // Note: age and flags are zeroed by GridState.paintCell which also
  // wrote them into local grid.front.  Mirror that here too.
  view.age[index]   = 0;
  view.flags[index] = 0;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * Handles all typed messages from the main thread.
 */
self.onmessage = (event: MessageEvent<SimWorkerInMsg>): void => {
  const msg = event.data;

  switch (msg.type) {

    // --- init ---------------------------------------------------------------
    case 'init': {
      const p = msg.payload;
      width   = p.width;
      height  = p.height;
      config  = p.config;

      // Allocate the local double-buffered grid.
      grid   = new GridState(width, height);
      engine = new SimulationEngine(width, height);

      // Seed the local grid with life.
      grid.seed(p.density, p.initialEnergy);

      // Set up SAB views for both buffer sets.
      const totalCells = width * height;
      ctrl        = makeControlView(p.sab);
      sabViews[0] = makeBufferViews(p.sab, totalCells, 0);
      sabViews[1] = makeBufferViews(p.sab, totalCells, 1);

      // Publish the initial seeded state to the SAB front buffer (set 0).
      // We write directly to set 0 without the seqlock since no one is
      // reading yet (init happens before the render worker's first frame).
      const view = sabViews[0]!;
      const local = grid.front;
      view.cellType.set(local.cellType);
      view.energy.set(local.energy);
      view.age.set(local.age);
      view.flags.set(local.flags);
      // front pointer is already 0 (SAB is zero-initialised).

      const ready: SimWorkerOutMsg = { type: 'ready' };
      self.postMessage(ready);
      break;
    }

    // --- play ---------------------------------------------------------------
    case 'play':
      // Default tick rate if we haven't received a speedChange yet.
      startLoop(30);
      break;

    // --- pause --------------------------------------------------------------
    case 'pause':
      stopLoop();
      break;

    // --- step ---------------------------------------------------------------
    case 'step':
      // One tick, regardless of whether the loop is running.
      tick();
      break;

    // --- speedChange --------------------------------------------------------
    case 'speedChange':
      // Restart the loop at the new rate (no-op if currently paused).
      if (tickIntervalId !== null) {
        startLoop(msg.hz);
      }
      // Store the Hz so the next 'play' message uses the right rate.
      // Stored in a module-scoped variable below.
      currentHz = msg.hz;
      break;

    // --- configUpdate -------------------------------------------------------
    case 'configUpdate':
      config = msg.config;
      break;

    // --- editCmd ------------------------------------------------------------
    case 'editCmd':
      applyEdit(msg.index, msg.cellType, msg.energy);
      break;

    // --- reset --------------------------------------------------------------
    case 'reset': {
      stopLoop();
      tickNum = 0;
      grid.clear();
      grid.seed(msg.density, msg.initialEnergy);

      // Publish the fresh grid to the SAB using the seqlock.
      publishToSab();
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Module-level Hz storage (updated by speedChange, used by play)
// ---------------------------------------------------------------------------

/**
 * Most recently requested tick rate.  Defaults to 30 Hz until a
 * `speedChange` message is received.
 */
let currentHz = 30;

// Override 'play' to use currentHz.
// (The handler above calls startLoop(30) — patch that to use currentHz.)
// We do this by monkey-patching after the handler is defined, keeping the
// handler itself readable.
const _originalOnMessage = self.onmessage!.bind(self);
self.onmessage = (event: MessageEvent<SimWorkerInMsg>): void => {
  if (event.data.type === 'play') {
    stopLoop();
    startLoop(currentHz);
  } else {
    _originalOnMessage(event);
  }
};
