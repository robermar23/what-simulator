/**
 * @fileoverview OffscreenCanvas Render Worker for the What Simulator.
 *
 * This worker runs entirely off the main thread.  It owns the `OffscreenCanvas`
 * that was transferred from the main thread at startup, and drives a
 * `requestAnimationFrame` loop that reads the simulation's latest committed
 * grid data from the SharedArrayBuffer.
 *
 * ## Rendering backends (Phase 7)
 *
 * The worker supports two rendering backends selected at `init` time:
 *   - `Renderer`      — Canvas 2D `ImageData` pixel write (Phases 1–6).
 *   - `WebGLRenderer` — WebGL 2 fragment shader (Phase 7).
 *
 * The backend is chosen by the `rendererType` field in the `init` message,
 * which is read from `sessionStorage` by `AppState` on page load.  Switching
 * backends at runtime is not possible because an `OffscreenCanvas` can hold
 * only one context type; the user changes the renderer via the ControlPanel
 * toggle, which writes to `sessionStorage` and reloads the page.
 *
 * ## Message protocol
 *
 * Receives `RenderWorkerInMsg` from the main thread:
 *   - `init`            — receive canvas + SAB, start rAF loop
 *   - `cellSizeChange`  — update renderer zoom, force full redraw
 *   - `invalidate`      — force full pixel-buffer rebuild (e.g. after grid reset)
 *   - `snapshot`        — export the current frame as a PNG blob URL
 *   - `gridLinesChange` — toggle grid-line overlay
 *
 * Posts `RenderWorkerOutMsg` back to the main thread:
 *   - `snapshotBlob`    — URL to the PNG data blob
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
 * ...render from SAB front...
 * const seq2 = Atomics.load(ctrl, CTRL_SEQ);
 * if (seq1 !== seq2) return;    // torn read — skip this frame
 * // data is consistent, rendered
 * ```
 *
 * Skipping a frame (a few microseconds window) is far preferable to blocking.
 */

import { Renderer }                                   from './Renderer.js';
import { WebGLRenderer, isWebGL2Available }           from './WebGLRenderer.js';
import { createWebGLBackground }                      from './backgrounds/WebGLBackgrounds.js';
import { type GridBuffers }                           from '../simulation/GridState.js';
import {
  makeControlView,
  makeBufferViews,
  CTRL_SEQ,
  CTRL_FRONT_IDX,
} from '../workers/sharedBuffers.js';
import {
  type RenderWorkerInMsg,
  type RenderWorkerOutMsg,
  type RendererType,
} from '../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

/**
 * The active renderer — either Canvas 2D or WebGL 2.
 * Both expose an identical `render / invalidate / cellSize / showGridLines`
 * interface so the render loop never needs to branch on renderer type.
 */
let renderer: Renderer | WebGLRenderer;

/**
 * The `OffscreenCanvas` transferred from the main thread on `init`.
 * Kept so we can call `convertToBlob()` for snapshots and pass it to a new
 * renderer when switching backends.
 */
let offscreenCanvas: OffscreenCanvas;

/** Current pixels-per-cell setting (shared across renderer instances). */
let currentCellSize = 2;

/** Whether grid lines are currently shown (shared across renderer instances). */
let currentShowGridLines = false;

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

  // Render from the front buffer using whichever backend is active.
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
// Backend creation helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new Canvas 2D renderer targeting `offscreenCanvas`.
 *
 * @returns A fresh `Renderer` instance with the current cellSize and grid-line state.
 */
function makeCanvas2DRenderer(): Renderer {
  return new Renderer(offscreenCanvas, {
    cellSize:      currentCellSize,
    showGridLines: currentShowGridLines,
  });
}

/**
 * Creates the appropriate renderer for the requested type.
 *
 * If `'webgl2'` is requested but unavailable (no WebGL 2 support or shader
 * compile failure), falls back to Canvas 2D transparently.
 *
 * @param requested - The desired `RendererType` (`'canvas2d'` or `'webgl2'`).
 * @returns A `Renderer` or `WebGLRenderer` instance.
 */
function makeRenderer(requested: RendererType): Renderer | WebGLRenderer {
  if (requested === 'webgl2' && isWebGL2Available()) {
    try {
      return new WebGLRenderer(offscreenCanvas, {
        cellSize:      currentCellSize,
        showGridLines: currentShowGridLines,
      });
    } catch {
      // Shader compile/link failure — fall through to Canvas 2D.
    }
  }
  return makeCanvas2DRenderer();
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

      // Store the OffscreenCanvas so we can reference it for snapshots and
      // when switching renderer backends.
      offscreenCanvas = msg.canvas;

      // Persist initial settings so new renderer instances can inherit them.
      currentCellSize      = msg.cellSize;
      currentShowGridLines = false; // no showGridLines in init msg; set via gridLinesChange

      // Create SAB typed-array views for both buffer sets.
      ctrl        = makeControlView(msg.sab);
      sabViews[0] = makeBufferViews(msg.sab, totalCells, 0);
      sabViews[1] = makeBufferViews(msg.sab, totalCells, 1);

      // Instantiate the requested renderer (default: Canvas 2D for safety).
      renderer = makeRenderer(msg.rendererType ?? 'canvas2d');

      // Begin the render loop.
      startLoop();
      break;
    }

    // --- cellSizeChange -----------------------------------------------------
    case 'cellSizeChange':
      // Update zoom — triggers canvas resize + full redraw on next frame.
      currentCellSize  = msg.cellSize;
      renderer.cellSize = msg.cellSize;
      renderer.invalidate();
      break;

    // --- invalidate ---------------------------------------------------------
    case 'invalidate':
      // Force a full pixel-buffer rebuild (e.g. after a grid reset).
      renderer.invalidate();
      break;

    // --- gridLinesChange (Phase 6) -----------------------------------------
    case 'gridLinesChange':
      // Toggle the thin cell-boundary grid-line overlay.
      currentShowGridLines = msg.show;
      renderer.showGridLines = msg.show;
      // No invalidate needed — grid lines are drawn after each render.
      break;

    // --- renderModeChange (Phase 10/11/12) -----------------------------------
    case 'renderModeChange': {
      // All RenderMode values map directly to the renderer's renderMode setter.
      // The Canvas 2D Renderer supports the full set; WebGLRenderer falls back
      // to 'default' for modes it doesn't implement (genome/generation/fitness/signal).
      const fullMode = msg.mode as
        | 'default' | 'lifecycle' | 'variantId'
        | 'genome'  | 'generation' | 'fitness' | 'signal';
      renderer.renderMode = fullMode;
      renderer.invalidate();
      break;
    }

    // --- backgroundChange (Phase 14/16d) -------------------------------------
    case 'backgroundChange':
      if (renderer instanceof Renderer) {
        // Canvas 2D path: toggle transparent empty cells so the bg canvas shows.
        renderer.transparentEmpty = msg.backgroundActive;
      } else if (renderer instanceof WebGLRenderer) {
        // WebGL path: instantiate the matching GPU background shader and hand
        // it to the renderer so it composites behind the HDR scene each frame.
        const webGLBg = createWebGLBackground(msg.backgroundType);
        renderer.setWebGLBackground(webGLBg);
      }
      // Apply environment tint to all Life cell colours so cells visually
      // belong to the environment even when the grid is fully covered.
      renderer.envTint = msg.tint;
      break;

    // --- aliveDetailChange (Phase 18) ----------------------------------------
    case 'aliveDetailChange':
      // Only the WebGL renderer exposes the aliveDetail property; the Canvas 2D
      // renderer renders flat squares regardless, so we silently skip it.
      if (renderer instanceof WebGLRenderer) {
        renderer.aliveDetail = msg.value;
      }
      break;

    // --- predatorThresholdChange (Phase 21) ----------------------------------
    case 'predatorThresholdChange':
      // Only the WebGL renderer uses this; Canvas 2D ignores predator colouring.
      if (renderer instanceof WebGLRenderer) {
        renderer.predatorThreshold = msg.rawUint16;
      }
      break;

    // --- snapshot -----------------------------------------------------------
    case 'snapshot': {
      // `convertToBlob` is available on OffscreenCanvas.
      // We always use the stored `offscreenCanvas` reference rather than
      // going through the renderer so this works with both backends.
      const blob    = await offscreenCanvas.convertToBlob({ type: 'image/png' });
      const url     = URL.createObjectURL(blob);
      const reply: RenderWorkerOutMsg = { type: 'snapshotBlob', url };
      self.postMessage(reply);
      break;
    }
  }
};
