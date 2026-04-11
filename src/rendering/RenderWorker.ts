/**
 * @fileoverview OffscreenCanvas Render Worker for the What Simulator.
 *
 * This worker runs entirely off the main thread.  It owns the `OffscreenCanvas`
 * that was transferred from the main thread at startup, and drives a
 * `requestAnimationFrame` loop that reads the simulation's latest committed
 * grid data from the SharedArrayBuffer.
 *
 * ## Message protocol
 *
 * Receives `RenderWorkerInMsg` from the main thread:
 *   - `init`           — receive canvas + SAB, start rAF loop
 *   - `cellSizeChange` — update renderer zoom, force full redraw
 *   - `invalidate`     — force full pixel-buffer rebuild (e.g. after grid reset)
 *   - `snapshot`       — export the current frame as a PNG blob URL
 *
 * Posts `RenderWorkerOutMsg` back to the main thread:
 *   - `snapshotBlob`   — URL to the PNG data blob
 *
 * ## Seqlock read protocol
 *
 * The sim worker writes using a seqlock (see `SimulationWorker.ts`).  We read
 * with a non-blocking check so the rAF loop never stalls:
 *
 * ```
 * const frontIdx = Atomics.load(ctrl, CTRL_FRONT_IDX);
 * const seq1     = Atomics.load(ctrl, CTRL_SEQ);
 * if (seq1 % 2 !== 0) return;   // write in progress — skip this frame
 * ...copy SAB front into ImageData...
 * const seq2 = Atomics.load(ctrl, CTRL_SEQ);
 * if (seq1 !== seq2) return;    // torn read — skip this frame
 * // data is consistent, render it
 * ```
 *
 * Skipping a frame (a few microseconds window) is far preferable to blocking.
 */

import { Renderer }                         from './Renderer.js';
import { type GridBuffers }                 from '../simulation/GridState.js';
import {
  makeControlView,
  makeBufferViews,
  CTRL_SEQ,
  CTRL_FRONT_IDX,
} from '../workers/sharedBuffers.js';
import {
  type RenderWorkerInMsg,
  type RenderWorkerOutMsg,
} from '../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

/** Canvas 2D renderer targeting the transferred OffscreenCanvas. */
let renderer: Renderer;

/** Grid width in cells. */
let width  = 0;
/** Grid height in cells. */
let height = 0;

/** Int32Array view over the SAB control section. */
let ctrl: Int32Array;

/**
 * Two sets of typed-array views into the SAB — one per buffer set.
 * We read from `sabViews[frontIdx]` each frame.
 */
const sabViews: [GridBuffers | null, GridBuffers | null] = [null, null];

/** rAF handle; null until init completes. */
let rafId: number | null = null;

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

/**
 * One animation frame:
 * 1. Non-blocking seqlock read — skip the frame if the sim is mid-write.
 * 2. Render from the front buffer if the read was consistent.
 */
function renderFrame(): void {
  // Read which buffer set is the current "front" (authoritative display data).
  const frontIdx = Atomics.load(ctrl, CTRL_FRONT_IDX) as 0 | 1;

  // Seqlock guard: read seq before touching data.
  const seq1 = Atomics.load(ctrl, CTRL_SEQ);

  // If seq is odd the sim is currently writing — skip this frame entirely.
  if (seq1 % 2 !== 0) {
    rafId = requestAnimationFrame(renderFrame);
    return;
  }

  // Render from the front buffer.
  renderer.render(sabViews[frontIdx]!, width, height);

  // Seqlock guard: read seq again after we finished reading data.
  const seq2 = Atomics.load(ctrl, CTRL_SEQ);

  if (seq1 !== seq2) {
    // A write started (and possibly completed) while we were reading.
    // The data may be torn — invalidate to force a full redraw next frame.
    renderer.invalidate();
  }

  rafId = requestAnimationFrame(renderFrame);
}

/**
 * Starts (or restarts) the render loop.
 * Safe to call multiple times — cancels the previous loop first.
 */
function startLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
  }
  rafId = requestAnimationFrame(renderFrame);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * Handles all typed messages from the main thread.
 */
self.onmessage = async (event: MessageEvent<RenderWorkerInMsg>): Promise<void> => {
  const msg = event.data;

  switch (msg.type) {

    // --- init ---------------------------------------------------------------
    case 'init': {
      width  = msg.width;
      height = msg.height;

      const totalCells = width * height;

      // Create SAB typed-array views for both buffer sets.
      ctrl        = makeControlView(msg.sab);
      sabViews[0] = makeBufferViews(msg.sab, totalCells, 0);
      sabViews[1] = makeBufferViews(msg.sab, totalCells, 1);

      // Instantiate the renderer using the transferred OffscreenCanvas.
      // The Renderer constructor accepts `HTMLCanvasElement | OffscreenCanvas`
      // — both implement the same Canvas 2D interface.
      renderer = new Renderer(msg.canvas, { cellSize: msg.cellSize });

      // Begin the render loop.
      startLoop();
      break;
    }

    // --- cellSizeChange -----------------------------------------------------
    case 'cellSizeChange':
      // Update zoom — triggers canvas resize + full redraw on next frame.
      renderer.cellSize = msg.cellSize;
      renderer.invalidate();
      break;

    // --- invalidate ---------------------------------------------------------
    case 'invalidate':
      // Force a full pixel-buffer rebuild (e.g. after a grid reset).
      renderer.invalidate();
      break;

    // --- snapshot -----------------------------------------------------------
    case 'snapshot': {
      // `convertToBlob` is available on OffscreenCanvas (not HTMLCanvasElement).
      // The renderer's canvas was constructed with the OffscreenCanvas from init.
      // We access it via the renderer's internal reference through a cast.
      // Because OffscreenCanvas is the only type we ever pass to this worker,
      // this cast is safe.
      const offscreen = (renderer as unknown as { _canvas: OffscreenCanvas })._canvas;

      const blob    = await offscreen.convertToBlob({ type: 'image/png' });
      const url     = URL.createObjectURL(blob);
      const reply: RenderWorkerOutMsg = { type: 'snapshotBlob', url };
      self.postMessage(reply);
      break;
    }
  }
};
