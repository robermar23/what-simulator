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
import { type BackgroundType }   from '../rendering/BackgroundRenderer.js';
import { type ObstacleSpec }     from '../simulation/generators/types.js';

// ---------------------------------------------------------------------------
// Phase 23 — Economy & Crisis Events
// ---------------------------------------------------------------------------

/**
 * All crisis event types that can sweep the simulation.
 *
 * Each type maps to a distinct set of per-tick engine effects and/or
 * SimulationConfig overrides applied for the duration of the crisis.
 *
 * | Type              | Primary Mechanic                                     |
 * |-------------------|------------------------------------------------------|
 * | solarFlare        | Grid-wide genome bit-flips; radiation storm          |
 * | desiccation       | Energy decay tripled; water evaporates               |
 * | antibioticFlood   | Grid-wide antibiotic kill checks per tick            |
 * | nutrientDrought   | Nutrient emission suppressed; starvation pressure    |
 * | predatorSurge     | Predator genome threshold halved; more predators     |
 * | iceAge            | Spread rate collapsed 70%; motility halted           |
 * | fireStorm         | Random fire cells placed at crisis onset             |
 * | plagueSweep       | Point mutation rate × 10; hypermutation epoch        |
 */
export type CrisisType =
  | 'solarFlare'
  | 'desiccation'
  | 'antibioticFlood'
  | 'nutrientDrought'
  | 'predatorSurge'
  | 'iceAge'
  | 'fireStorm'
  | 'plagueSweep';

/**
 * Phase 23: milestone categories that award ATP bonuses when reached.
 *
 * Milestones are detected on the main thread from incoming worker messages
 * (tick stats, variantCreated, etc.) and converted to ATP rewards by the
 * ATPSystem.
 */
export type MilestoneKind =
  | 'newVariant'          // a new genetic lineage has speciated (+50 ATP)
  | 'populationBoom'      // population exceeds 10 000 cells for the first time (+25 ATP)
  | 'survivedCrisis'      // colony persists through a full crisis duration (+100 ATP)
  | 'longLivedVariant';   // a variant lineage passes 1 000 ticks alive (+75 ATP)

// ---------------------------------------------------------------------------
// Round 2 — Population genetics types
// ---------------------------------------------------------------------------

/**
 * Compact population snapshot broadcast by the SimulationWorker every
 * `censusInterval` ticks (default: 10).
 *
 * Uses parallel typed arrays indexed by `variantId` (0–255) so the payload
 * stays small: 256 × (4 + 2 + 4 + 4) = ~3.5 KB per census.
 *
 * Consumed by the main thread's `PopulationGenetics` module and the three
 * evolution visualisation panels (PopulationChart, GenomeHeatmap,
 * PhylogeneticTree).
 */
export interface VariantCensus {
  /** Monotonic tick number when this snapshot was taken. */
  tick: number;
  /**
   * Live cell count per variant (index = variantId, length = 256).
   * Entries are 0 for variants that are extinct or have never existed.
   */
  counts: Uint32Array;
  /**
   * Modal (most-common) genome per variant (index = variantId, length = 256).
   * Approximated as the genome of the most-recently-counted cell of each
   * variant — sufficient for heatmap rendering without a full census scan.
   */
  meanGenome: Uint16Array;
  /**
   * Mean cell age per variant (index = variantId, length = 256).
   * Reported as a Float32 tick count.
   */
  meanAge: Float32Array;
  /**
   * Mean reproductive generation depth per variant (index = variantId, length = 256).
   * Higher values indicate deeper ancestry from the original seed.
   */
  meanGen: Float32Array;
}

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
  | { type: 'reset';        density: number; initialEnergy: number }
  /**
   * Round 2: switch the active render mode used by both the Canvas 2D and
   * WebGL renderers.  The worker forwards this to the RenderWorker.
   */
  | { type: 'setRenderMode';    mode: RenderMode }
  /**
   * Round 2: highlight all cells belonging to the given variantId on the
   * main canvas (dims all other life cells).  Pass `null` to clear.
   */
  | { type: 'highlightVariant'; variantId: number | null }
  /**
   * Round 5: apply an environment preset to the grid.
   *
   * The worker:
   *   1. Clears all non-life obstacle cells.
   *   2. Runs `generateObstacles(spec, ...)` to place the new obstacle layout.
   *   3. Re-seeds life at `seedDensity`.
   *   4. Posts an `environmentApplied` response when complete.
   *
   * `backgroundType` is forwarded by `app.ts` to the RenderWorker via a
   * separate `backgroundChange` message — the SimulationWorker does not own
   * the renderer.
   */
  | {
      type:            'applyEnvironment';
      spec:            ObstacleSpec;
      seedDensity:     number;
      initialEnergy:   number;
    };

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
      /**
       * Phase 21: predator Life cells alive this tick.
       * 0 when predatorGenomeThreshold === 0 (mechanics disabled).
       */
      predatorCells: number;
      /**
       * Phase 21: dormant Spore cells alive this tick.
       * 0 when predator-prey mechanics are disabled.
       */
      sporeCells:    number;
    }
  /**
   * Round 2: population genetics census, posted every `censusInterval` ticks.
   * Consumed by PopulationGenetics, PopulationChart, GenomeHeatmap, etc.
   */
  | { type: 'variantCensus';  data: VariantCensus }
  /**
   * Round 2: a new variant lineage has been created by significant mutation.
   * Consumed by VariantRegistry and PhylogeneticTree.
   */
  | {
      type:          'variantCreated';
      /** Newly assigned variant ID (1–255). */
      variantId:     number;
      /** Parent variant ID that this lineage branched from. */
      parentId:      number;
      /** Tick on which the first cell of this variant appeared. */
      tick:          number;
      /** Genome of the founding cell of this variant. */
      genome:        number;
    }
  /**
   * Round 2: a variant has gone extinct (population reached 0).
   * Consumed by VariantRegistry and PhylogeneticTree.
   */
  | {
      type:          'variantExtinct';
      /** Variant ID that has gone extinct. */
      variantId:     number;
      /** Tick on which the last cell of this variant died. */
      tick:          number;
      /** Peak population this variant ever reached. */
      peakPop:       number;
    }
  /**
   * Round 5: posted by the SimulationWorker once an `applyEnvironment`
   * request has been fully processed (obstacles placed, life re-seeded,
   * SAB updated).  The main thread uses this to re-enable the UI and
   * trigger an `invalidate` on the RenderWorker.
   */
  | { type: 'environmentApplied' }

  /**
   * Phase 23: posted when the simulation crosses a significant milestone
   * that rewards the player with ATP.
   *
   * Milestones are detected inside the SimulationWorker's tick/census logic
   * and posted once per milestone event.  The main thread's {@link ATPSystem}
   * converts each `milestoneKind` to an ATP reward and emits a UI notification.
   *
   * @example
   * { type: 'milestone', kind: 'newVariant', tick: 342 }
   */
  | {
      type:  'milestone';
      /** Which milestone category was reached. */
      kind:  MilestoneKind;
      /** Tick on which the milestone occurred. */
      tick:  number;
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
 * Round 2: which data dimension the main simulation canvas visualises.
 *
 * | Mode        | Colour encodes                                           |
 * |-------------|----------------------------------------------------------|
 * | `variantId` | Hue from VARIANT_PALETTE, brightness from energy (default)|
 * | `genome`    | Hue from spread tier, saturation from toxin tier         |
 * | `lifecycle` | Green = juvenile, bright = mature, purple = senescent    |
 * | `generation`| Heat ramp cool (gen 0) → hot (deep ancestry)             |
 * | `fitness`   | Computed local fitness score — higher = brighter         |
 * | `signal`    | Cyan glow intensity = signalStrength (chemotaxis field)  |
 */
export type RenderMode =
  | 'variantId'
  | 'genome'
  | 'lifecycle'
  | 'generation'
  | 'fitness'
  | 'signal'
  /** Phase 18: fixed green base + full sub-cell morphology anatomy. */
  | 'morphology'
  /** Phase 21: predators red / prey teal / spores brown. */
  | 'predprey';

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
  /**
   * Phase 7: switch the rendering backend at runtime.
   * The worker checks WebGL 2 availability and falls back to canvas2d if needed,
   * then responds with a `rendererChanged` message confirming the active type.
   */
  | { type: 'rendererChange'; rendererType: RendererType }
  /**
   * Round 2: switch the active render mode (which dimension is visualised).
   * Takes effect on the next rendered frame.
   */
  | { type: 'renderModeChange'; mode: RenderMode }
  /**
   * Phase 14/16d: notify the render worker that the background type has changed.
   * When `backgroundActive` is true, empty cells are rendered as transparent
   * so the procedural background shows through.  `backgroundType` lets the
   * WebGL render worker instantiate the matching `WebGLBackground` shader.
   */
  | {
      type: 'backgroundChange';
      backgroundActive: boolean;
      /** Which background environment is now active (Phase 16d). */
      backgroundType: BackgroundType;
      /** Environment tint `[r, g, b, alpha]` — blended into Life cell colours. */
      tint: readonly [number, number, number, number];
    }
  /**
   * Phase 18: set the morphology detail level on the WebGL renderer.
   * 0 = flat squares, 1 = full sub-cell anatomy.
   * Ignored by the Canvas 2D renderer.
   */
  | { type: 'aliveDetailChange'; value: number }
  /**
   * Phase 21: update the predator genome threshold on the WebGL renderer.
   * Passed as the raw Uint16 value from SimulationConfig.predatorGenomeThreshold.
   * The renderer normalises to [0, 1] internally.
   * Ignored by the Canvas 2D renderer.
   */
  | { type: 'predatorThresholdChange'; rawUint16: number }
  /**
   * Phase 22: toggle individual cinematic post-processing effects on the
   * WebGL renderer.  All six flags are sent together so the renderer can
   * update all uniforms atomically in one message handler.
   * Ignored by the Canvas 2D renderer.
   */
  | {
      type: 'cinematicChange';
      /** AO — darken interior cluster cells by live-neighbour occupancy. */
      ambientOcclusion: boolean;
      /** Trail glow — motile cells leave a decaying variant-coloured wake. */
      trails: boolean;
      /** Particle system — emission at division/death/quorum events. */
      particles: boolean;
      /** Depth of field — hexagonal blur growing toward canvas edges. */
      depthOfField: boolean;
      /** Chromatic aberration — RGB fringing at canvas edges. */
      chromaticAberration: boolean;
      /** Vignette — radial darkening at canvas perimeter. */
      vignette: boolean;
    }
  ;

// ---------------------------------------------------------------------------
// RenderWorker → main thread
// ---------------------------------------------------------------------------

/**
 * All messages the RenderWorker posts back to the main thread.
 */
export type RenderWorkerOutMsg =
  /** Snapshot PNG blob URL, in response to a 'snapshot' request. */
  | { type: 'snapshotBlob'; url: string }
  /**
   * Phase 7: confirmation that the renderer backend has been switched.
   * The `rendererType` field reflects the backend that is now active (may
   * differ from the request if WebGL 2 was unavailable and fell back to
   * canvas2d).
   */
  | { type: 'rendererChanged'; rendererType: RendererType };
