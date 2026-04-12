/**
 * @fileoverview Typed message-passing protocol for the What Simulator's
 * Web Worker architecture (Phase 4).
 *
 * All `postMessage` calls use one of the discriminated union types defined
 * here.  The `type` field narrows the union at handler call sites so the
 * compiler catches missing cases and incorrect payload shapes.
 *
 * ## Worker topology
 *
 * ```
 *                  ┌─────────────────────────┐
 *                  │        Main Thread       │
 *                  │  (DOM, EventBus, UI)     │
 *                  └───────┬─────────┬────────┘
 *       SimWorkerInMsg ▼   │         │  ▼ RenderWorkerInMsg
 *                  ┌───────┴──┐  ┌───┴──────────┐
 *                  │  Sim     │  │  Render      │
 *                  │  Worker  │  │  Worker      │
 *                  └───────┬──┘  └──────────────┘
 *       SimWorkerOutMsg ▲  │
 *                        └─ postMessage back to main
 * ```
 *
 * The render worker never needs to post messages back to the main thread
 * except for snapshot blobs (handled via a dedicated response message).
 */

import { type SimulationConfig } from '../simulation/config/SimulationConfig.js';

// ---------------------------------------------------------------------------
// Main thread → SimulationWorker
// ---------------------------------------------------------------------------

/**
 * One-time initialisation payload sent when the SimulationWorker starts.
 * Contains everything the worker needs to bootstrap without further messages.
 */
export interface SimInitPayload {
  /** SharedArrayBuffer for double-buffered grid state. */
  sab: SharedArrayBuffer;
  /** Grid width in cells. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** Initial simulation parameters. */
  config: SimulationConfig;
  /** Seed density [0, 1] — fraction of cells to seed as Life. */
  density: number;
  /** Starting energy for seeded Life cells. */
  initialEnergy: number;
}

/**
 * All messages the main thread can post to the SimulationWorker.
 *
 * Handling order: the worker must process `init` before any other message.
 */
export type SimWorkerInMsg =
  /** Bootstrap the worker with grid dimensions, SAB, and initial config. */
  | { type: 'init';         payload: SimInitPayload }
  /** Start the simulation tick loop. */
  | { type: 'play' }
  /** Pause the simulation tick loop (can be resumed with 'play'). */
  | { type: 'pause' }
  /** Advance exactly one tick (only meaningful while paused). */
  | { type: 'step' }
  /** Change the tick rate without stopping/starting the loop. */
  | { type: 'speedChange';  hz: number }
  /** Apply a new SimulationConfig (takes effect next tick). */
  | { type: 'configUpdate'; config: SimulationConfig }
  /**
   * Paint a single cell on the grid.
   * The worker writes the change to both its local GridState and the SAB
   * front buffer so the render worker sees it immediately.
   */
  | { type: 'editCmd';      index: number; cellType: number; energy: number }
  /** Clear the grid and re-seed with new density / energy settings. */
  | { type: 'reset';        density: number; initialEnergy: number };

// ---------------------------------------------------------------------------
// SimulationWorker → main thread
// ---------------------------------------------------------------------------

/**
 * All messages the SimulationWorker posts back to the main thread.
 */
export type SimWorkerOutMsg =
  /** Posted once after `init` is processed and the worker is ready. */
  | { type: 'ready' }
  /** Posted after every completed tick with up-to-date statistics. */
  | {
      type:         'tick';
      /** Monotonic tick number. */
      tickNum:      number;
      /** Surviving regular Life cell count. */
      liveCells:    number;
      /** Surviving LifeVariant cell count. */
      variantCells: number;
      /** Cells born this tick (both Life and LifeVariant). */
      births:       number;
      /** Cells that died this tick. */
      deaths:       number;
    };

// ---------------------------------------------------------------------------
// Main thread → RenderWorker
// ---------------------------------------------------------------------------

/**
 * Which rendering backend to use.
 *
 * - `'canvas2d'` — CPU-based `ImageData` pixel write (Phase 1–6, always works).
 * - `'webgl2'`   — GPU-based WebGL 2 fragment shader (Phase 7, requires WebGL 2).
 *
 * The render worker checks WebGL 2 availability when it receives a `webgl2`
 * request and falls back to `canvas2d` if the context cannot be acquired.
 */
export type RendererType = 'canvas2d' | 'webgl2';

/**
 * All messages the main thread can post to the RenderWorker.
 */
export type RenderWorkerInMsg =
  /**
   * Bootstrap the render worker with the OffscreenCanvas and SAB.
   * The `canvas` is transferred (not copied) so the main thread loses
   * direct control of the DOM canvas element.
   */
  | {
      type:         'init';
      /** Transferred OffscreenCanvas — must be in the transferable list. */
      canvas:       OffscreenCanvas;
      /** SharedArrayBuffer holding the double-buffered grid state. */
      sab:          SharedArrayBuffer;
      /** Grid width in cells. */
      width:        number;
      /** Grid height in cells. */
      height:       number;
      /** Initial pixels-per-cell zoom level. */
      cellSize:     number;
      /**
       * Which rendering backend to start with.
       * Phase 7: defaults to `'canvas2d'` for backwards compat if omitted.
       */
      rendererType?: RendererType;
    }
  /** Zoom level changed — renderer resizes and invalidates the pixel cache. */
  | { type: 'cellSizeChange'; cellSize: number }
  /** Force a full pixel-buffer rebuild (e.g. after a grid reset). */
  | { type: 'invalidate' }
  /** Request a PNG snapshot; worker responds with 'snapshotBlob'. */
  | { type: 'snapshot' }
  /**
   * Toggle the grid-line overlay drawn over the simulation canvas.
   * Phase 6.
   */
  | { type: 'gridLinesChange'; show: boolean }
  ;

// ---------------------------------------------------------------------------
// RenderWorker → main thread
// ---------------------------------------------------------------------------

/**
 * All messages the RenderWorker posts back to the main thread.
 */
export type RenderWorkerOutMsg =
  /** Snapshot PNG blob URL, in response to a 'snapshot' request. */
  | { type: 'snapshotBlob'; url: string };
