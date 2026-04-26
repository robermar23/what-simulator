/**
 * @fileoverview Core simulation tick logic for the What Simulator.
 *
 * This module is intentionally **pure**: it takes pre-allocated TypedArray
 * buffers and a config object, mutates the back buffer, and returns
 * statistics.  It has zero DOM dependencies and is fully unit-testable without
 * a browser environment.
 *
 * Performance contract: the inner loop must allocate **zero** objects per
 * tick.  All helper arrays (neighbour lists, gravity-well cache) are allocated
 * once per engine instance and reused.
 *
 * ## Phase 1 scope
 *   - Life spread into Empty cells (probabilistic).
 *   - Energy decay and death when energy ≤ 0.
 *   - Overpopulation / underpopulation culling.
 *   - Moore and Von Neumann neighbour modes.
 *
 * ## Phase 2 additions
 *   - Wall cells block spread entirely.
 *   - Toxin cells damage adjacent Life cells each tick; Life CAN spread into
 *     Toxin cells (consuming them) but spawns with reduced initial energy.
 *   - Nutrient cells boost adjacent Life energy each tick; they deplete over
 *     time and are consumed when Life spreads into them.
 *   - A single neighbour scan per Life cell now serves triple duty:
 *     live-neighbour counting, toxin/nutrient detection, and spread targeting.
 *
 * ## Phase 3 additions
 *   - Mutation: Life cells can randomly mutate into LifeVariant (Variant B)
 *     each tick with probability `mutationRate`.
 *   - LifeVariant cells use their own independent config parameters
 *     (variantSpreadRate, variantEnergyDecayRate, etc.).
 *   - Competition: LifeVariant cells can spread INTO adjacent regular Life
 *     cells with probability `competitionStrength`, killing the Life cell.
 *   - TickStats now tracks `variantCells` separately from `liveCells`.
 *
 * ## Phase 5 additions
 *   - **Drain**: Impassable cell; adjacent Life loses `drainRate` energy/tick
 *     and its spread probability is halved.
 *   - **GravityWell**: Impassable; pulls Life spread toward the well center via
 *     inverse-square directional bias.  Wells are pre-scanned once per tick
 *     into a compact index buffer to avoid repeated full-grid scans.
 *   - **Barrier**: Impassable wall that crumbles to Empty after `barrierLifetime`
 *     ticks.  Energy field stores a linear fade factor for visual feedback.
 *   - **Fire**: Impassable; kills adjacent Life on contact (no spread chance —
 *     instant death); spreads deterministically to adjacent Life, LifeVariant,
 *     and Nutrient cells (converting them to Fire); burns down by
 *     `fireBurnRate` per tick, becoming Empty when fuel runs out.
 *   - **Ice**: Impassable; adjacent Life cells become dormant — no energy
 *     decay, no spread, no death checks — until the Ice cell is removed.
 *
 * ## Phase 9 additions (Round 2)
 *   - Per-cell phenotype buffers (`toxinResist`, `nutrientAbs`, `spreadBonus`)
 *     are now read from the front buffer instead of global config, giving each
 *     cell its own evolved trait values.
 *   - Genome inheritance: when a cell spreads, the child receives the parent's
 *     16-bit genome plus a stochastic point mutation (see {@link MutationEngine}).
 *   - Per-cell phenotype (`toxinResist`, `nutrientAbs`, `heatResist`,
 *     `spreadBonus`) is derived from the child's genome via {@link GENOME_LUT}
 *     and written to the back buffer.
 *   - Effective spread rate = `config.spreadRate + front.spreadBonus[i]`.
 *   - Effective toxin resist = `front.toxinResist[i]` (per-cell).
 *   - Effective nutrient absorption = `front.nutrientAbs[i]` (per-cell).
 *
 * ## Phase 12 additions (Genome-Aware Obstacles)
 *   - **Mutagen**: Passable cell that boosts adjacent Life mutation rate by
 *     `config.mutagenBoost` multiplier.  Depletes each tick and becomes Empty.
 *   - **RadioWaste**: Impassable; permanent radiation source — damages adjacent
 *     Life energy and applies random genome bit flips each tick.
 *   - **Antibiotic**: Passable; per-tick kill chance for adjacent Life cells,
 *     reduced by the cell's `toxinResist` phenotype.  Depletes over time.
 *   - **Rewinder**: Impassable; nudges adjacent Life genome nibbles toward the
 *     neutral baseline (0x7777) each tick, eroding genetic drift.
 *   - **Colony**: Impassable; provides `colonyBoost` energy to adjacent Life
 *     cells and emits a `signalStrength` pulse each tick for signal render mode.
 *
 * ## Phase 10 additions (Lifecycle Stages and Senescence)
 *   - Life cells age through three stages tracked in the `flags` buffer:
 *       - **Juvenile** (`age < juvenileThreshold`): spread × 0.4, decay × 0.8,
 *         no genome mutation.  {@link CellFlags.JUVENILE} is set.
 *       - **Mature** (`juvenileThreshold ≤ age ≤ senescentThreshold`): full
 *         phenotype, normal mutation.  Neither lifecycle flag is set.
 *       - **Senescent** (`age > senescentThreshold`): spread × 0.1,
 *         decay × 1.5, mutation rate × 2.  {@link CellFlags.SENESCENT} is set.
 *   - **Apoptosis**: a senescent cell whose energy drops below 0.05 undergoes
 *     planned death — it sets `signalStrength = 1.0`, boosts each live
 *     neighbour by `apoptosisBoost` energy, and becomes Empty.  This feeds
 *     the next generation and drives colony turnover.
 */

import { CellType, CellFlags, type GridBuffers } from './GridState.js';
import { type SimulationConfig } from './config/SimulationConfig.js';
import { mooreNeighbors, vonNeumannNeighbors, indexToXY } from '../utils/math.js';
import {
  isEnterable,
  calcSpreadEnergy,
  hasAdjacentDrain,
  hasAdjacentIce,
  hasAdjacentFire,
  calcGravityBias,
} from './rules/obstacleRules.js';
import {
  calcBarrierEnergy,
  isBarrierExpired,
  calcFireBurndown,
  spreadFire,
} from './rules/environmentRules.js';
import {
  computeChildGenome,
  applyPhenotypeFromGenome,
  getToxinResist,
  getNutrientAbs,
  assignVariantId,
  MAX_VARIANT_ID,
} from './genetics/MutationEngine.js';

// ---------------------------------------------------------------------------
// Tick statistics
// ---------------------------------------------------------------------------

/**
 * Aggregate statistics returned after each simulation tick.
 * Populated by reusing the same object instance each tick — no allocation.
 */
export interface TickStats {
  /** Total surviving regular Life cells (excluding Variant B) this tick. */
  liveCells: number;
  /** Total surviving LifeVariant (Variant B) cells this tick. */
  variantCells: number;
  /** Number of new cells born this tick (both Life and LifeVariant). */
  births: number;
  /** Number of cells that died this tick. */
  deaths: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of GravityWell cells that can be tracked per tick.
 * 64 wells is far more than any practical scenario — pre-allocated to
 * avoid per-tick heap allocation.
 */
const MAX_WELLS = 64;

/**
 * Maximum number of new variant creation events that can be buffered per tick.
 *
 * In practice, very few new variants emerge each tick (requires ≥3 genome bits
 * to diverge in a single spread event).  512 is a generous upper bound that
 * covers even the most mutation-heavy configurations without heap allocation.
 */
const MAX_VARIANT_EVENTS = 512;

// ---------------------------------------------------------------------------
// SimulationEngine
// ---------------------------------------------------------------------------

/**
 * Runs one simulation tick, reading from `front` buffers and writing results
 * to `back` buffers.
 *
 * Designed to be instantiated once and reused every tick.  Pre-allocates all
 * scratch data structures at construction time.
 */
export class SimulationEngine {
  /** Grid width in cells. */
  private readonly _width: number;
  /** Grid height in cells. */
  private readonly _height: number;
  /** Total cell count — cached to avoid multiplication in the hot loop. */
  private readonly _total: number;

  /**
   * Pre-allocated neighbour index array.
   * Maximum 8 neighbours (Moore), reused every cell every tick.
   */
  private readonly _neighborBuf: Int32Array = new Int32Array(8);

  /**
   * Pre-allocated GravityWell index cache.
   * Filled once per tick during a pre-scan; avoids repeated full-grid scans
   * when computing spread bias for each Life cell.
   * Stores flat cell indices of all active GravityWell cells.
   */
  private readonly _wellBuf: Int32Array = new Int32Array(MAX_WELLS);

  /** Number of valid entries currently in `_wellBuf`. */
  private _wellCount = 0;

  /** Reused stats object — mutated in place each tick. */
  private readonly _stats: TickStats = {
    liveCells: 0, variantCells: 0, births: 0, deaths: 0,
  };

  // -------------------------------------------------------------------------
  // Phase 11 — Variant event queue
  // -------------------------------------------------------------------------

  /**
   * Maximum number of new variant lineages that can be spawned in a single
   * simulation tick.
   *
   * Without this cap, a large grid (1024×1024+) with a non-zero mutation rate
   * can generate thousands of speciation events per tick, cycling through all
   * 256 variant IDs in one frame and rendering every cell a different colour.
   *
   * A cap of 2 means at most 2 new lineages emerge per tick, giving smooth
   * visual divergence at any grid size.  The cap also acts as a global mutation
   * pressure governor — higher values allow faster saturation.
   */
  private static readonly _MAX_NEW_VARIANTS_PER_TICK = 2;

  /**
   * Counter of new variants created so far this tick.
   * Reset to 0 at the start of each {@link tick} call.
   */
  private _newVariantsThisTick: number = 0;

  /**
   * Next variant ID to assign when a genome diverges by ≥3 bits.
   * Cycles from 1 to 255 (wraps on overflow).  0 is reserved for the base
   * Life seed and is never assigned here.
   */
  private _nextVariantId: number = 1;

  /**
   * Reference genome for each variant lineage (indexed by variantId, 0–255).
   *
   * Divergence for speciation is measured against this founding genome rather
   * than the immediate parent cell's genome.  Without this, a single spread
   * (which flips at most 1 bit) could never reach the ≥3-bit threshold.
   *
   * With lineage references, a child that has inherited several point mutations
   * will eventually differ from its lineage founder by ≥3 bits, at which point
   * it is considered a new species and receives a fresh variant ID.
   *
   * Initialised to `GENOME_NEUTRAL (0x7777)` at construction and reset.
   * Updated in `_trySpread` each time a new lineage is spawned.
   */
  private readonly _variantRefGenomes: Uint16Array = new Uint16Array(256).fill(0x7777);

  /**
   * Flat pre-allocated buffer for variant-creation events this tick.
   *
   * Layout per event (3 Int32 entries):
   *   [k*3+0] = new childVariantId  (1–255)
   *   [k*3+1] = parentVariantId     (0–255)
   *   [k*3+2] = childGenome         (16-bit unsigned)
   *
   * Filled by `_trySpread`; drained by `drainVariantEvents` which the
   * SimulationWorker calls once per tick.
   */
  private readonly _variantEventsBuf: Int32Array = new Int32Array(MAX_VARIANT_EVENTS * 3);

  /** Number of valid events currently in `_variantEventsBuf`. */
  private _variantEventCount: number = 0;

  /**
   * @param width - Grid width in cells.
   * @param height - Grid height in cells.
   */
  constructor(width: number, height: number) {
    this._width  = width;
    this._height = height;
    this._total  = width * height;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Advances the simulation by one tick.
   *
   * Reads from `front`, writes to `back`.  The caller must swap the buffers
   * after this call (see {@link GridState.swap}).
   *
   * The caller must also call {@link GridState.copyFrontToBack} before this
   * function so that back starts as a faithful copy of the current world state.
   *
   * ## Phase 9 changes
   *
   * For Life / LifeVariant cells, per-cell phenotype buffers now take
   * precedence over the global config:
   *   - `toxinResist[i]`  replaces `config.toxinResistance`
   *   - `nutrientAbs[i]`  replaces `config.nutrientAbsorption`
   *   - `spreadBonus[i]`  is added to `config.spreadRate` (delta)
   *
   * Cells seeded via {@link GridState.seed} or painted via
   * {@link GridState.paintCell} start with phenotype derived from the neutral
   * genome (0x7777), which preserves Round 1 behaviour for unmodified grids.
   *
   * @param front  - Source buffers for this tick (read-only by convention).
   * @param back   - Destination buffers for this tick (written).
   * @param config - Current simulation parameters.
   * @returns Tick statistics (same object reference each call).
   */
  /**
   * Returns all variant-creation events that occurred during the last tick
   * and clears the internal buffer for the next tick.
   *
   * The SimulationWorker calls this once after each `tick()` to pick up any
   * new variant IDs and post `variantCreated` messages to the main thread.
   *
   * Events are returned as a flat tuple array:
   *   `[childId, parentId, genome, childId, parentId, genome, …]`
   *
   * The returned view is only valid until the next `tick()` call; callers
   * must read (and copy if needed) before the next tick.
   *
   * @returns Read-only view of the event buffer and the event count.
   */
  drainVariantEvents(): { buf: Int32Array; count: number } {
    const count = this._variantEventCount;
    this._variantEventCount = 0;
    return { buf: this._variantEventsBuf, count };
  }

  /**
   * Resets the next-variant-ID counter back to 1.
   *
   * Called by the SimulationWorker on grid reset so the new simulation starts
   * assigning variant IDs from 1 again, matching the freshly bootstrapped
   * {@link VariantRegistry}.
   */
  resetVariantCounter(): void {
    this._nextVariantId     = 1;
    this._variantEventCount = 0;
    // Reset reference genomes so divergence is measured fresh from the neutral
    // baseline after a grid reset.
    this._variantRefGenomes.fill(0x7777);
  }

  tick(
    front: GridBuffers,
    back: GridBuffers,
    config: SimulationConfig,
  ): TickStats {
    // Reset stats each tick.
    this._stats.liveCells    = 0;
    this._stats.variantCells = 0;
    this._stats.births       = 0;
    this._stats.deaths       = 0;

    // Reset variant event queue and per-tick creation cap for this tick.
    this._variantEventCount    = 0;
    this._newVariantsThisTick  = 0;

    // --- Round 1 buffer destructuring ---
    const {
      cellType:  ftType,
      energy:    ftEnergy,
      age:       ftAge,
      flags:     ftFlags,
      // --- Round 2 genome buffers (Phase 9) ---
      genome:         ftGenome,
      variantId:      ftVariantId,
      generation:     ftGeneration,
      toxinResist:    ftToxinResist,
      nutrientAbs:    ftNutrientAbs,
      spreadBonus:    ftSpreadBonus,
    } = front;

    const {
      cellType:  bkType,
      energy:    bkEnergy,
      age:       bkAge,
      flags:     bkFlags,
      // --- Round 2 genome buffers (Phase 9) ---
      genome:         bkGenome,
      variantId:      bkVariantId,
      generation:     bkGeneration,
      toxinResist:    bkToxinResist,
      nutrientAbs:    bkNutrientAbs,
      heatResist:     bkHeatResist,
      spreadBonus:    bkSpreadBonus,
      // --- Phase 10: signal used for apoptosis burst ---
      signalStrength: bkSignalStrength,
      // --- Phase 19: motility velocity buffers ---
      vx: bkVx,
      vy: bkVy,
      // --- Phase 20: chemical ecology buffers (write target) ---
      chemNutrient:  bkChemNutrient,
      chemWaste:     bkChemWaste,
      chemPheromone: bkChemPheromone,
      chemAlarm:     bkChemAlarm,
    } = back;

    // Phase 19: read front velocity buffers for the post-loop motility pass.
    const { vx: ftVx, vy: ftVy } = front;

    // Phase 20: read front chem buffers for diffusion source and gradient reads.
    const {
      chemNutrient:  ftChemNutrient,
      chemWaste:     ftChemWaste,
      chemPheromone: ftChemPheromone,
      chemAlarm:     ftChemAlarm,
    } = front;

    const {
      // Regular Life params
      spreadRate,
      energyDecayRate,
      reproductionThreshold,
      initialEnergy,
      mutationRate,
      overpopulationLimit,
      underpopulationLimit,
      neighbourhoodMode,
      toxinStrength,
      nutrientBoost,
      nutrientDecayRate,
      drainRate,
      barrierLifetime,
      fireBurnRate,
      gravityStrength,
      gravityResponse,
      // Variant B params (Phase 3)
      variantSpreadRate,
      variantEnergyDecayRate,
      variantReproductionThreshold,
      variantInitialEnergy,
      competitionStrength,
      // Round 2 genome mutation (Phase 9)
      pointMutationRate,
      // Phase 10: lifecycle stage parameters
      juvenileThreshold,
      senescentThreshold,
      apoptosisBoost,
      // Phase 12: genome-aware obstacle parameters
      mutagenBoost,
      mutagenDecayRate,
      radioWasteDamage,
      antibioticStrength,
      antibioticDecayRate,
      rewinderStrength,
      colonyBoost,
      // Phase 15: evolution behaviour parameters
      signalDiffusion,
      // Phase 20: chemical ecology parameters
      wasteSecretionRate,
      pheromoneSecretionRate,
      nutrientChemotaxis,
      pheromoneChemotaxis,
      wasteAvoidance,
      alarmFlight,
      chemicalDiffusionRate,
      chemicalDecayRate,
      chemQuorumThreshold,
      quorumActivationEnergy,
    } = config;

    const useMoore = neighbourhoodMode === 'moore';
    const width    = this._width;
    const height   = this._height;
    const total    = this._total;

    // -----------------------------------------------------------------------
    // Phase 12: Decay all signal strengths from the previous tick.
    // Colony cells overwrite their own and adjacent cells' signal each tick,
    // so decay must run first to clear stale non-colony signal residue.
    // Retain `signalDiffusion` fraction of signal each tick (configurable).
    // Default 0.85 → ~6-cell propagation range from a colony or nutrient source.
    // -----------------------------------------------------------------------
    const { signalStrength: ftSignal } = front;
    for (let i = 0; i < total; i++) {
      const s = ftSignal[i];
      if (s > 0) {
        bkSignalStrength[i] = s * signalDiffusion;
      }
    }

    // -----------------------------------------------------------------------
    // Phase 5: Pre-scan for GravityWell positions.
    // -----------------------------------------------------------------------
    this._wellCount = 0;
    if (gravityStrength > 0 && gravityResponse > 0) {
      for (let i = 0; i < total && this._wellCount < MAX_WELLS; i++) {
        if (ftType[i] === CellType.GravityWell) {
          this._wellBuf[this._wellCount++] = i;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Main cell update loop.
    // -----------------------------------------------------------------------
    for (let i = 0; i < total; i++) {
      const type = ftType[i];

      // ---- Static / impassable cell types — skip immediately ---------------
      // These cells have no per-tick update of their own; their effects on
      // Life cells are handled inside the Life branch below.
      // Phase 12 additions: RadioWaste (permanent), Rewinder (permanent) are
      // fully static.  Colony, Mutagen, Antibiotic have per-tick behaviour and
      // fall through to their own dedicated branches further below.
      if (
        type === CellType.Empty      ||
        type === CellType.Wall       ||
        type === CellType.GravityWell||
        type === CellType.Drain      ||
        type === CellType.Ice        ||
        type === CellType.RadioWaste ||
        type === CellType.Rewinder
      ) {
        continue;
      }

      // ------------------------------------------------------------------
      // Barrier cells (Phase 5)
      // ------------------------------------------------------------------
      if (type === CellType.Barrier) {
        if (bkType[i] !== CellType.Barrier) continue;

        const newAge = ftAge[i] + 1;

        if (isBarrierExpired(newAge, barrierLifetime)) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
        } else {
          bkAge[i]    = newAge < 65535 ? newAge : 65535;
          bkEnergy[i] = calcBarrierEnergy(newAge, barrierLifetime);
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Fire cells (Phase 5)
      // ------------------------------------------------------------------
      if (type === CellType.Fire) {
        if (bkType[i] !== CellType.Fire) continue;

        const nLen = this._fillNeighbors(i, width, height, useMoore);
        spreadFire(nLen, this._neighborBuf, ftType, bkType, bkEnergy);

        const newFuel = calcFireBurndown(ftEnergy[i], fireBurnRate);
        if (newFuel <= 0) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
        } else {
          bkEnergy[i] = newFuel;
          bkAge[i]    = ftAge[i] < 65535 ? ftAge[i] + 1 : 65535;
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Nutrient cells — deplete over time (Phase 2)
      // ------------------------------------------------------------------
      if (type === CellType.Nutrient) {
        if (bkType[i] !== CellType.Nutrient) continue;

        const newEn = ftEnergy[i] - nutrientDecayRate;
        if (newEn <= 0) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
        } else {
          bkEnergy[i] = newEn;
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Phase 12: Mutagen cells — deplete over time (like Nutrient)
      // ------------------------------------------------------------------
      if (type === CellType.Mutagen) {
        if (bkType[i] !== CellType.Mutagen) continue;

        const newEn = ftEnergy[i] - mutagenDecayRate;
        if (newEn <= 0) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
        } else {
          bkEnergy[i] = newEn;
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Phase 12: Antibiotic cells — deplete over time
      // ------------------------------------------------------------------
      if (type === CellType.Antibiotic) {
        if (bkType[i] !== CellType.Antibiotic) continue;

        const newEn = ftEnergy[i] - antibioticDecayRate;
        if (newEn <= 0) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
        } else {
          bkEnergy[i] = newEn;
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Phase 12: Colony cells — emit signal to adjacent Life cells;
      // Colony is permanent (no energy decay of the colony structure itself)
      // ------------------------------------------------------------------
      if (type === CellType.Colony) {
        if (bkType[i] !== CellType.Colony) continue;

        // Emit signal strength to adjacent cells — the signal render mode
        // reads bkSignalStrength to visualise chemical gradients.
        const nLen = this._fillNeighbors(i, width, height, useMoore);
        for (let k = 0; k < nLen; k++) {
          const ni = this._neighborBuf[k];
          // Signal radiates outward; cap at 1.0 so multiple colonies don't
          // overflow the Float32 buffer.
          if (bkSignalStrength[ni] < 0.8) {
            bkSignalStrength[ni] = 0.8;
          }
        }
        // Decay existing signal toward 0 each tick (Colony re-emits each tick
        // so its direct neighbours stay at 0.8; further cells from previous
        // tick decay naturally).
        bkSignalStrength[i] = 1.0; // Colony cell itself always at max signal.
        continue;
      }

      // ------------------------------------------------------------------
      // Toxin cells: static per tick (damage applied via the Life branch)
      // ------------------------------------------------------------------
      if (type === CellType.Toxin) {
        continue;
      }

      // ------------------------------------------------------------------
      // Life cells (both variants) — Phase 9: per-cell phenotype
      //
      // Per-cell phenotype buffers replace global config values for:
      //   - toxin resist  → front.toxinResist[i]
      //   - nutrient abs  → front.nutrientAbs[i]
      //   - spread bonus  → added to base cellSpreadRate
      //
      // Cells initialised by seed() or paintCell() carry phenotype values
      // derived from GENOME_NEUTRAL so behaviour is identical to Phase 8
      // for unmodified grids.
      // ------------------------------------------------------------------
      if (type === CellType.Life || type === CellType.LifeVariant) {
        const isVariant = type === CellType.LifeVariant;
        const cellDecayRate   = isVariant ? variantEnergyDecayRate      : energyDecayRate;
        const baseSpreadRate  = isVariant ? variantSpreadRate            : spreadRate;
        const cellReproThresh = isVariant ? variantReproductionThreshold : reproductionThreshold;
        const cellInitEnergy  = isVariant ? variantInitialEnergy         : initialEnergy;

        // --- Phase 9: read per-cell phenotype from front buffers ----------
        const cellToxinResist = ftToxinResist[i];
        const cellNutrientAbs = ftNutrientAbs[i];
        const cellSpreadBns   = ftSpreadBonus[i];

        // --- Phase 10: lifecycle stage detection ---------------------------
        // Life cells (not LifeVariant) age through three stages based on how
        // long they have existed.  LifeVariant cells use the mature-stage
        // modifiers unconditionally so Round 1 behaviour is preserved.
        const cellAge = ftAge[i];
        const isJuvenile  = !isVariant && cellAge < juvenileThreshold;
        const isSenescent = !isVariant && cellAge > senescentThreshold;

        // Stage multipliers applied to the per-cell spread and decay rates.
        //   Juvenile  → slow spread (× 0.4), reduced metabolic cost (× 0.8)
        //   Mature    → unmodified (× 1.0 both)
        //   Senescent → minimal spread (× 0.1), high metabolic cost (× 1.5)
        let stageSpreadMult = 1.0;
        let stageDecayMult  = 1.0;
        if (isJuvenile) {
          stageSpreadMult = 0.4;
          stageDecayMult  = 0.8;
        } else if (isSenescent) {
          stageSpreadMult = 0.1;
          stageDecayMult  = 1.5;
        }

        // Effective spread rate = (base + genome bonus) × stage multiplier.
        const cellSpreadRate = (baseSpreadRate + cellSpreadBns) * stageSpreadMult;

        // Effective decay rate = base decay × stage multiplier.
        const stageCellDecayRate = cellDecayRate * stageDecayMult;

        const nLen = this._fillNeighbors(i, width, height, useMoore);

        // Single-pass neighbour scan — detect all relevant adjacent types.
        let liveNeighbours    = 0;
        let adjacentToxin     = false;
        let adjacentNutrient  = false;
        let adjacentMutagen   = false; // Phase 12
        let adjacentRadWaste  = false; // Phase 12
        let adjacentAntibiotic = false; // Phase 12
        let adjacentRewinder  = false; // Phase 12
        let adjacentColony    = false; // Phase 12

        for (let n = 0; n < nLen; n++) {
          const nType = ftType[this._neighborBuf[n]];
          if (nType === CellType.Life || nType === CellType.LifeVariant) {
            liveNeighbours++;
          } else if (nType === CellType.Toxin) {
            if (!adjacentToxin) adjacentToxin = true;
          } else if (nType === CellType.Nutrient) {
            if (!adjacentNutrient) adjacentNutrient = true;
          } else if (nType === CellType.Mutagen) {
            if (!adjacentMutagen) adjacentMutagen = true;
          } else if (nType === CellType.RadioWaste) {
            if (!adjacentRadWaste) adjacentRadWaste = true;
          } else if (nType === CellType.Antibiotic) {
            if (!adjacentAntibiotic) adjacentAntibiotic = true;
          } else if (nType === CellType.Rewinder) {
            if (!adjacentRewinder) adjacentRewinder = true;
          } else if (nType === CellType.Colony) {
            if (!adjacentColony) adjacentColony = true;
          }
        }

        // --- Ice dormancy override ----------------------------------------
        if (hasAdjacentIce(this._neighborBuf, nLen, ftType)) {
          bkFlags[i] = ftFlags[i] | CellFlags.DORMANT;
          if (isVariant) this._stats.variantCells++;
          else           this._stats.liveCells++;
          continue;
        }

        // Clear DORMANT, lifecycle flags, and the one-tick JUST_DIVIDED flash.
        let newFlags = ftFlags[i] & ~(
          CellFlags.DORMANT | CellFlags.JUVENILE | CellFlags.SENESCENT | CellFlags.JUST_DIVIDED
        );
        bkFlags[i] = newFlags;

        // --- Fire: instant death ------------------------------------------
        if (hasAdjacentFire(this._neighborBuf, nLen, ftType)) {
          bkType[i]   = CellType.Fire;
          bkEnergy[i] = 1.0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Drain adjacency -----------------------------------------------
        const adjacentDrain = hasAdjacentDrain(this._neighborBuf, nLen, ftType);

        // --- Energy budget: per-cell resist/absorption (Phase 9 + 10) ------
        // Phase 10: use stage-aware decay rate (stageCellDecayRate) instead of
        // the raw cellDecayRate so juvenile / senescent modifiers apply.
        let newEnergy = ftEnergy[i] - stageCellDecayRate;

        if (adjacentToxin) {
          // Per-cell toxin resistance (Phase 9 replaces config.toxinResistance).
          newEnergy -= toxinStrength * (1 - cellToxinResist);
        }
        if (adjacentNutrient) {
          // Per-cell nutrient absorption (Phase 9 replaces config.nutrientAbsorption).
          newEnergy += nutrientBoost * cellNutrientAbs;
        }
        if (adjacentDrain) {
          newEnergy -= drainRate;
        }

        // --- Phase 12: genome-aware obstacle energy effects -------------------

        if (adjacentRadWaste) {
          // Radiation damage (partial resistance from toxinResist).
          newEnergy -= radioWasteDamage * (1 - cellToxinResist * 0.5);
        }
        if (adjacentColony) {
          // Colony energy subsidy — reward Life cells that cluster near Colony.
          newEnergy += colonyBoost;
        }

        if (newEnergy > 1.0) newEnergy = 1.0;

        // --- Phase 10: Apoptosis -------------------------------------------
        // A senescent cell that has fallen below the apoptosis energy threshold
        // undergoes planned death: it emits a signal burst, donates a small
        // energy bonus to each live neighbour, then becomes Empty.
        //
        // This is checked BEFORE the generic energy-starvation check so the
        // apoptosis side-effects (signal + neighbour boost) are always applied
        // to senescent cells, even those that would have died anyway.
        if (isSenescent && newEnergy < 0.05) {
          // Signal burst — maximum signal for exactly one tick.
          bkSignalStrength[i] = 1.0;
          // Feed adjacent live cells (best-effort: neighbours already processed
          // this tick have their bkEnergy updated; those not yet processed are
          // boosted here and their own processing overwrites from ftEnergy, so
          // the boost is visible only in next-tick's front buffer).
          for (let n = 0; n < nLen; n++) {
            const ni    = this._neighborBuf[n];
            const nType = bkType[ni];
            if (nType === CellType.Life || nType === CellType.LifeVariant) {
              const boosted = bkEnergy[ni] + apoptosisBoost;
              bkEnergy[ni] = boosted > 1.0 ? 1.0 : boosted;
            }
          }
          // Cell completes apoptosis — becomes Empty.
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Phase 12: Antibiotic kill check ---------------------------------
        // Adjacent Antibiotic cells roll a per-tick kill chance, reduced by
        // the cell's toxinResist phenotype (genetic selection pressure).
        if (adjacentAntibiotic) {
          const killChance = antibioticStrength * (1 - cellToxinResist);
          if (killChance > 0 && Math.random() < killChance) {
            bkType[i]   = CellType.Empty;
            bkEnergy[i] = 0;
            bkAge[i]    = 0;
            bkFlags[i]  = 0;
            this._stats.deaths++;
            continue;
          }
        }

        // --- Generic death checks -----------------------------------------

        if (newEnergy <= 0) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        if (liveNeighbours > overpopulationLimit) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        if (liveNeighbours < underpopulationLimit) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Cell survives ------------------------------------------------
        bkEnergy[i] = newEnergy;
        bkAge[i] = ftAge[i] < 65535 ? ftAge[i] + 1 : 65535;

        // --- Phase 10: update lifecycle flags in back buffer ---------------
        // Flags are already stripped of JUVENILE/SENESCENT above; reapply
        // based on the updated age (ftAge[i] + 1 = bkAge[i]).
        if (isJuvenile) {
          newFlags |= CellFlags.JUVENILE;
        } else if (isSenescent) {
          newFlags |= CellFlags.SENESCENT;
        }
        bkFlags[i] = newFlags;

        // --- Phase 12: Rewinder — nudge genome nibbles toward neutral --------
        // Each nibble (4 bits) of the 16-bit genome is compared to tier 7
        // (0x7 = neutral).  With probability `rewinderStrength`, one nibble
        // that differs from 7 is shifted one step toward 7 in the back buffer.
        if (adjacentRewinder && rewinderStrength > 0 && Math.random() < rewinderStrength) {
          let g = bkGenome[i];
          // Pick a random nibble (0–3) and nudge it one step toward 0x7.
          const nibbleIdx = (Math.random() * 4) | 0;
          const shift     = nibbleIdx * 4;
          const nibble    = (g >> shift) & 0xF;
          if (nibble !== 7) {
            const step       = nibble < 7 ? 1 : -1;
            const newNibble  = nibble + step;
            const mask       = ~(0xF << shift);
            g = (g & mask) | (newNibble << shift);
            bkGenome[i] = g;
            // Re-derive phenotype from the nudged genome so it takes effect.
            applyPhenotypeFromGenome(
              g,
              bkToxinResist,
              bkNutrientAbs,
              bkHeatResist,
              bkSpreadBonus,
              i,
            );
          }
        }

        // --- Legacy Phase 3 mutation (Life → LifeVariant) -----------------
        // Juvenile cells cannot mutate (lifecycle spec).
        if (!isJuvenile && !isVariant && mutationRate > 0 && Math.random() < mutationRate) {
          bkType[i]  = CellType.LifeVariant;
          bkFlags[i] = bkFlags[i] | CellFlags.MUTATED; // preserve lifecycle flags
          this._stats.variantCells++;
        } else {
          if (isVariant) {
            this._stats.variantCells++;
          } else {
            this._stats.liveCells++;
          }
        }

        // --- Spread (reproduction) ----------------------------------------
        // Phase 5: Drain halves the effective spread rate.
        // Phase 10: stageSpreadMult already applied to cellSpreadRate above.
        // Phase 20: QUORUM_ACTIVE (set last tick) suppresses spread to 10% —
        //   biofilm cells invest energy in the colony rather than expansion.
        const isInQuorum = (ftFlags[i] & CellFlags.QUORUM_ACTIVE) !== 0;
        const effectiveSpreadRate = adjacentDrain
          ? cellSpreadRate * 0.5
          : isInQuorum
            ? cellSpreadRate * 0.1
            : cellSpreadRate;

        // Phase 10: genome point-mutation rate is stage-dependent.
        //   Juvenile   → 0        (cannot mutate while establishing)
        //   Mature     → pointMutationRate (normal)
        //   Senescent  → pointMutationRate × 2 (last-ditch diversity burst)
        // Phase 12: Mutagen adjacency multiplies the effective rate further.
        const mutagenMult     = adjacentMutagen ? mutagenBoost : 1.0;
        const stageMutationRate = isJuvenile
          ? 0
          : Math.min(1.0, (isSenescent
            ? pointMutationRate * 2
            : pointMutationRate) * mutagenMult);

        if (newEnergy >= cellReproThresh) {
          this._trySpread(
            i,
            nLen,
            ftType,
            ftGenome,
            ftVariantId,
            ftGeneration,
            bkType,
            bkEnergy,
            bkAge,
            bkFlags,
            bkGenome,
            bkVariantId,
            bkGeneration,
            bkToxinResist,
            bkNutrientAbs,
            bkHeatResist,
            bkSpreadBonus,
            type,
            effectiveSpreadRate,
            cellInitEnergy,
            competitionStrength,
            toxinStrength,
            nutrientBoost,
            gravityStrength,
            gravityResponse,
            stageMutationRate,
            antibioticStrength, // Phase 12
          );
        }

        continue;
      }
    }

    // -----------------------------------------------------------------------
    // Phase 19: Motility & Chemotaxis pass.
    //
    // Runs AFTER the main loop so every cell's survival/death decision is
    // already committed to the back buffer.  Two sequential sub-passes:
    //
    //   Sub-pass 1 — Velocity update (all surviving Life cells):
    //     new_v = old_v × (1 − damping) blended with chemical-gradient bias.
    //
    //   Sub-pass 2 — Migration (motile cells only, first-writer-wins):
    //     A cell whose spreadBonus > motilityThreshold and that passes a
    //     motilityRate probability check attempts to move one step toward its
    //     velocity vector.  The target must be Empty in BOTH front and back to
    //     prevent overwriting newly-born children or cells migrating into it
    //     from an earlier index.
    //
    // No heap allocation: x/y coordinates computed inline with % and |0.
    // -----------------------------------------------------------------------
    const { motilityRate, motilityThreshold, motilityDamping, chemotaxisMotilityFraction } = config;

    if (motilityRate > 0) {

      // Sub-pass 1: Update velocities for all surviving Life cells.
      for (let i = 0; i < total; i++) {
        if (bkType[i] !== CellType.Life) {
          // Zero velocity for dead cells, empty cells, and non-Life types.
          bkVx[i] = 0;
          bkVy[i] = 0;
          continue;
        }

        // Carry forward velocity with exponential damping (drag / cytoskeletal reset).
        let vx = ftVx[i] * (1.0 - motilityDamping);
        let vy = ftVy[i] * (1.0 - motilityDamping);

        // Chemotaxis: bias velocity toward high-signal (nutrient) cells and
        // away from toxin cells.  Uses front cellType and signalStrength so
        // the chemical gradient is the one that was visible to the cell this tick.
        if (chemotaxisMotilityFraction > 0) {
          const nLen = this._fillNeighbors(i, width, height, useMoore);
          const ix = i % width;
          const iy = (i / width) | 0;
          let bx = 0.0;
          let by = 0.0;

          for (let k = 0; k < nLen; k++) {
            const ni    = this._neighborBuf[k];
            const ntype = ftType[ni];
            const nx = ni % width;
            const ny = (ni / width) | 0;
            const dx = nx - ix;
            const dy = ny - iy;
            let weight = 0.0;

            if (ntype === CellType.Nutrient) {
              // Strong positive attraction — move toward nutrients.
              weight = 1.0;
            } else if (ntype === CellType.Toxin) {
              // Negative — flee toxin cells.
              weight = -0.8;
            } else {
              // Gentle signal-gradient following (e.g. Colony-emitted signals).
              weight = ftSignal[ni] * 0.3;
            }
            bx += dx * weight;
            by += dy * weight;
          }

          // Blend persisted momentum with the chemical gradient.
          vx = vx * (1.0 - chemotaxisMotilityFraction) + bx * chemotaxisMotilityFraction;
          vy = vy * (1.0 - chemotaxisMotilityFraction) + by * chemotaxisMotilityFraction;
        }

        // Phase 20: multi-channel chemical gradient bias.
        // Uses cardinal-direction finite differences on front chem buffers (one-tick lag
        // is physically realistic — cells respond to the gradient they sensed last tick).
        // Only computed when any Phase 20 chemotaxis coefficient is non-zero.
        if (nutrientChemotaxis !== 0 || pheromoneChemotaxis !== 0 || wasteAvoidance !== 0 || alarmFlight !== 0) {
          const ix = i % width;
          const iy = (i / width) | 0;
          const r  = ix < width  - 1 ? i + 1     : i;
          const l  = ix > 0          ? i - 1     : i;
          const dn = iy < height - 1 ? i + width : i;
          const up = iy > 0          ? i - width : i;

          // Nutrient gradient attracts; waste + alarm gradients repel; pheromone attracts kin.
          const dNx = ftChemNutrient[r]  - ftChemNutrient[l];
          const dNy = ftChemNutrient[dn] - ftChemNutrient[up];
          const dWx = ftChemWaste[r]     - ftChemWaste[l];
          const dWy = ftChemWaste[dn]    - ftChemWaste[up];
          const dPx = ftChemPheromone[r] - ftChemPheromone[l];
          const dPy = ftChemPheromone[dn] - ftChemPheromone[up];
          const dAx = ftChemAlarm[r]     - ftChemAlarm[l];
          const dAy = ftChemAlarm[dn]    - ftChemAlarm[up];

          vx += nutrientChemotaxis * dNx + pheromoneChemotaxis * dPx
              - wasteAvoidance * dWx     - alarmFlight * dAx;
          vy += nutrientChemotaxis * dNy + pheromoneChemotaxis * dPy
              - wasteAvoidance * dWy     - alarmFlight * dAy;
        }

        bkVx[i] = vx;
        bkVy[i] = vy;
      }

      // Sub-pass 2: Migrate motile cells one step toward their velocity vector.
      for (let i = 0; i < total; i++) {
        // Only cells that:
        //   a) Survived the main tick as Life in both front and back (not newborn).
        //   b) Have a motile phenotype (spreadBonus above the threshold).
        //   c) Pass the per-tick migration probability check.
        if (
          bkType[i]            !== CellType.Life ||
          ftType[i]            !== CellType.Life ||
          ftSpreadBonus[i]     <= motilityThreshold ||
          Math.random()        >= motilityRate
        ) {
          continue;
        }

        const vx   = bkVx[i];
        const vy   = bkVy[i];
        const vMag = Math.sqrt(vx * vx + vy * vy);

        // Below this threshold the cell is considered effectively stationary.
        if (vMag < 0.1) continue;

        const invMag = 1.0 / vMag;
        const nLen   = this._fillNeighbors(i, width, height, useMoore);
        const ix     = i % width;
        const iy     = (i / width) | 0;
        let bestNi   = -1;
        let bestDot  = -Infinity;

        for (let k = 0; k < nLen; k++) {
          const ni    = this._neighborBuf[k];
          const ntype = ftType[ni];

          // Impassable obstacles: reflect velocity off the cell boundary normal.
          // Normal points from the obstacle back toward us (negated approach direction).
          if (
            ntype === CellType.Wall       ||
            ntype === CellType.Drain      ||
            ntype === CellType.GravityWell||
            ntype === CellType.Barrier    ||
            ntype === CellType.Ice        ||
            ntype === CellType.RadioWaste ||
            ntype === CellType.Rewinder   ||
            ntype === CellType.Colony
          ) {
            const nx = ni % width;
            const ny = (ni / width) | 0;
            const dx = nx - ix;
            const dy = ny - iy;
            // Axis-aligned reflection: flip the velocity component matching the
            // blocked axis.  Diagonal (dx≠0 and dy≠0): negate both components.
            if (dx !== 0 && dy === 0) {
              bkVx[i] = -vx;
            } else if (dy !== 0 && dx === 0) {
              bkVy[i] = -vy;
            } else {
              bkVx[i] = -vx;
              bkVy[i] = -vy;
            }
            continue;
          }

          // Target must be Empty in BOTH front and back (first-writer-wins):
          //   - front Empty: not occupied before this tick.
          //   - back  Empty: not claimed by a spread or an earlier migration.
          if (ntype !== CellType.Empty || bkType[ni] !== CellType.Empty) {
            continue;
          }

          // Choose the neighbour whose direction best aligns with the velocity.
          const nx  = ni % width;
          const ny  = (ni / width) | 0;
          const dx  = nx - ix;
          const dy  = ny - iy;
          const dot = (dx * vx + dy * vy) * invMag;
          if (dot > bestDot) {
            bestDot = dot;
            bestNi  = ni;
          }
        }

        // No valid target in the velocity direction — skip this cell.
        if (bestNi < 0 || bestDot <= 0) continue;

        // Migrate: copy all cell state to the target and clear the source.
        bkType[bestNi]        = CellType.Life;
        bkEnergy[bestNi]      = bkEnergy[i];
        bkAge[bestNi]         = bkAge[i];
        bkFlags[bestNi]       = bkFlags[i];
        bkGenome[bestNi]      = bkGenome[i];
        bkVariantId[bestNi]   = bkVariantId[i];
        bkGeneration[bestNi]  = bkGeneration[i];
        bkToxinResist[bestNi] = bkToxinResist[i];
        bkNutrientAbs[bestNi] = bkNutrientAbs[i];
        bkHeatResist[bestNi]  = bkHeatResist[i];
        bkSpreadBonus[bestNi] = bkSpreadBonus[i];
        // Carry velocity to the destination so motion persists next tick.
        bkVx[bestNi]          = bkVx[i];
        bkVy[bestNi]          = bkVy[i];

        // Erase source.
        bkType[i]        = CellType.Empty;
        bkEnergy[i]      = 0;
        bkAge[i]         = 0;
        bkFlags[i]       = 0;
        bkGenome[i]      = 0;
        bkVariantId[i]   = 0;
        bkGeneration[i]  = 0;
        bkToxinResist[i] = 0;
        bkNutrientAbs[i] = 0;
        bkHeatResist[i]  = 0;
        bkSpreadBonus[i] = 0;
        bkVx[i]          = 0;
        bkVy[i]          = 0;
      }
    } else {
      // Motility disabled — zero all velocity buffers so SAB stays clean for
      // the render worker (flagellum rendering won't draw stale vectors).
      for (let i = 0; i < total; i++) {
        bkVx[i] = 0;
        bkVy[i] = 0;
      }
    }

    // -----------------------------------------------------------------------
    // Phase 20: Chemical Ecology passes.
    //
    // Three sequential sub-passes run AFTER Phase 19 so they see the final
    // cell-type layout (post-migration) for this tick.
    //
    //   Sub-pass 1 — Diffusion + decay (all four channels):
    //     Reads front chem buffers (previous tick state) and applies a
    //     discrete Laplacian diffusion + exponential decay, writing to the
    //     back chem buffers.  Using front as the source avoids read/write
    //     aliasing — the front is stable for the whole tick.
    //
    //   Sub-pass 2 — Secretion:
    //     Adds new chemical material to back chem buffers based on the
    //     final cell types/energies committed to back by the main loop.
    //
    //   Sub-pass 3 — Quorum sensing:
    //     Samples local pheromone (5×5 neighbourhood, scaled to [0,1]),
    //     sets/clears QUORUM_ACTIVE flag, and applies the cooperative
    //     energy bonus for quorum-active cells.
    //
    // All three sub-passes are skipped when all secretion rates are zero
    // (default) so pre-Phase 20 configs pay zero cost.
    // -----------------------------------------------------------------------

    const hasPhase20Chem = wasteSecretionRate > 0 || pheromoneSecretionRate > 0;

    if (hasPhase20Chem || chemicalDiffusionRate > 0) {
      const retain = 1.0 - chemicalDecayRate; // fraction of chem that persists

      // Sub-pass 1: Diffusion + decay — reads ftChem, writes bkChem.
      for (let i = 0; i < total; i++) {
        const ix = i % width;
        const iy = (i / width) | 0;

        // Cardinal neighbour indices (clamped at grid edges — no wrap-around).
        const r  = ix < width  - 1 ? i + 1     : i;
        const l  = ix > 0          ? i - 1     : i;
        const dn = iy < height - 1 ? i + width : i;
        const up = iy > 0          ? i - width : i;

        // Discrete Laplacian: L(f) = f(r) + f(l) + f(d) + f(u) − 4·f(i).
        // Scaled by diffRate so the update is: f_new = f × retain + diffRate × L(f).
        const dN = ftChemNutrient[r]  + ftChemNutrient[l]  + ftChemNutrient[dn]  + ftChemNutrient[up]  - 4 * ftChemNutrient[i];
        const dW = ftChemWaste[r]     + ftChemWaste[l]      + ftChemWaste[dn]     + ftChemWaste[up]     - 4 * ftChemWaste[i];
        const dP = ftChemPheromone[r] + ftChemPheromone[l]  + ftChemPheromone[dn] + ftChemPheromone[up] - 4 * ftChemPheromone[i];
        const dA = ftChemAlarm[r]     + ftChemAlarm[l]      + ftChemAlarm[dn]     + ftChemAlarm[up]     - 4 * ftChemAlarm[i];

        bkChemNutrient[i]  = ftChemNutrient[i]  * retain + chemicalDiffusionRate * dN;
        bkChemWaste[i]     = ftChemWaste[i]      * retain + chemicalDiffusionRate * dW;
        bkChemPheromone[i] = ftChemPheromone[i]  * retain + chemicalDiffusionRate * dP;
        bkChemAlarm[i]     = ftChemAlarm[i]      * retain + chemicalDiffusionRate * dA;
      }

      // Sub-pass 2: Secretion — adds new chemical to back buffers based on
      // the committed cell layout.  Clamped to [0, 1] to prevent runaway.
      for (let i = 0; i < total; i++) {
        const cellType = bkType[i];

        if (cellType === CellType.Nutrient) {
          // Nutrient cells are point sources for the N channel.
          const v = bkChemNutrient[i] + 0.15; // fixed strong emission
          bkChemNutrient[i] = v > 1.0 ? 1.0 : v;
        }

        if (cellType === CellType.Life) {
          const e = bkEnergy[i];

          // Waste: proportional to energy consumed (active metabolism = more waste).
          const newW = bkChemWaste[i] + e * wasteSecretionRate;
          bkChemWaste[i] = newW > 1.0 ? 1.0 : newW;

          // Pheromone: kin signal proportional to energy (healthy cells broadcast more).
          const newP = bkChemPheromone[i] + e * pheromoneSecretionRate;
          bkChemPheromone[i] = newP > 1.0 ? 1.0 : newP;

          // Alarm: dying cells (energy < 0.1) broadcast danger.
          if (e < 0.1) {
            const alarmEmit = (0.1 - e) * 2.0; // stronger the lower the energy
            const newA = bkChemAlarm[i] + alarmEmit;
            bkChemAlarm[i] = newA > 1.0 ? 1.0 : newA;
          }
        }

        // Clamp all channels to [0, 1] — diffusion can produce small negatives at edges.
        if (bkChemNutrient[i]  < 0) bkChemNutrient[i]  = 0;
        if (bkChemWaste[i]     < 0) bkChemWaste[i]     = 0;
        if (bkChemPheromone[i] < 0) bkChemPheromone[i] = 0;
        if (bkChemAlarm[i]     < 0) bkChemAlarm[i]     = 0;
      }

      // Sub-pass 3: Quorum sensing — samples local pheromone in a 5×5
      // neighbourhood (25 cells max, scaled by 1/25 → [0, 1]).
      // Sets QUORUM_ACTIVE on the cell's back flags and applies the cooperative
      // energy bonus for this tick.
      if (pheromoneSecretionRate > 0 && chemQuorumThreshold < 1.0) {
        for (let i = 0; i < total; i++) {
          if (bkType[i] !== CellType.Life) {
            // Clear QUORUM_ACTIVE for non-Life cells.
            bkFlags[i] &= ~CellFlags.QUORUM_ACTIVE;
            continue;
          }

          // Sum pheromone in 5×5 Moore neighbourhood (radius 2).
          const ix = i % width;
          const iy = (i / width) | 0;
          let localP = 0.0;
          let sampleCount = 0;

          for (let dy = -2; dy <= 2; dy++) {
            const ny = iy + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -2; dx <= 2; dx++) {
              const nx = ix + dx;
              if (nx < 0 || nx >= width) continue;
              localP += bkChemPheromone[ny * width + nx];
              sampleCount++;
            }
          }

          // Scale to [0, 1] by dividing by sample count (accounts for edge cells).
          const avgP = sampleCount > 0 ? localP / sampleCount : 0;

          if (avgP >= chemQuorumThreshold) {
            // Quorum detected: set flag, apply cooperative energy bonus.
            bkFlags[i] |= CellFlags.QUORUM_ACTIVE;
            const bonus = bkEnergy[i] + quorumActivationEnergy * 0.01;
            bkEnergy[i] = bonus > 1.0 ? 1.0 : bonus;
          } else {
            // Below quorum: clear flag.
            bkFlags[i] &= ~CellFlags.QUORUM_ACTIVE;
          }
        }
      }
    } else {
      // Phase 20 chemistry inactive — zero all chem buffers each tick so the
      // render worker sees clean fields (render modes 8–11 show nothing).
      for (let i = 0; i < total; i++) {
        bkChemNutrient[i]  = 0;
        bkChemWaste[i]     = 0;
        bkChemPheromone[i] = 0;
        bkChemAlarm[i]     = 0;
        // Also clear QUORUM_ACTIVE since there is no chemistry driving it.
        bkFlags[i] &= ~CellFlags.QUORUM_ACTIVE;
      }
    }

    return this._stats;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fills `_neighborBuf` with the flat indices of cell `i`'s neighbours and
   * returns the count.  Uses Moore or Von Neumann based on `useMoore`.
   *
   * @param i        - Flat index of the source cell.
   * @param width    - Grid width.
   * @param height   - Grid height.
   * @param useMoore - True for Moore (8-cell); false for Von Neumann (4-cell).
   * @returns Number of valid neighbours written into `_neighborBuf`.
   */
  private _fillNeighbors(
    i: number,
    width: number,
    height: number,
    useMoore: boolean,
  ): number {
    const neighbors = useMoore
      ? mooreNeighbors(i, width, height)
      : vonNeumannNeighbors(i, width, height);

    const len = neighbors.length;
    for (let k = 0; k < len; k++) {
      this._neighborBuf[k] = neighbors[k];
    }
    return len;
  }

  /**
   * Attempts to spread the life cell at `parentIdx` into eligible neighbours.
   *
   * ## Phase 9 genome inheritance
   *
   * When a spread succeeds:
   * 1. The child's genome = parent's genome + stochastic point mutation via
   *    {@link computeChildGenome}.
   * 2. The child's per-cell phenotype (`toxinResist`, `nutrientAbs`,
   *    `heatResist`, `spreadBonus`) is derived from the child's genome
   *    via {@link applyPhenotypeFromGenome}.
   * 3. Spawn energy for Toxin / Nutrient targets uses the **child's** derived
   *    resistance/absorption — the newly born cell faces the environment with
   *    its own evolved traits, not the parent's.
   * 4. `variantId` is inherited unchanged (Phase 11 will assign new IDs when
   *    ≥3 bits diverge).
   * 5. `generation` = parent generation + 1 (capped at 65 535).
   *
   * ## Spread targets (Phase 2 + Phase 5)
   *   - Empty cells:    Life spawns at full `cellInitEnergy`.
   *   - Toxin cells:    Life spawns with reduced energy (entry damage).
   *                     Toxin is consumed (overwritten by Life type).
   *   - Nutrient cells: Life spawns with boosted energy.
   *                     Nutrient is consumed (overwritten by Life type).
   *   - Wall / Drain / GravityWell / Barrier / Fire / Ice: Impassable.
   *   - Life/LifeVariant: Normally occupied — skipped.
   *
   * ## Phase 3 — LifeVariant competition
   *   - LifeVariant cells MAY spread into regular Life cells with probability
   *     `competitionStrength`.  Regular Life cannot spread into LifeVariant.
   *
   * ## Phase 5 — GravityWell bias
   *   - Each candidate target's probability is boosted by the inverse-square
   *     pull from all active GravityWell cells toward the target position.
   *
   * @param parentIdx         - Flat index of the spreading parent cell.
   * @param nLen              - Number of valid entries in `_neighborBuf`.
   * @param ftType            - Front cell type array (read-only).
   * @param ftGenome          - Front genome array (read-only).
   * @param ftVariantId       - Front variant ID array (read-only).
   * @param ftGeneration      - Front generation array (read-only).
   * @param bkType            - Back cell type array (write).
   * @param bkEnergy          - Back energy array (write).
   * @param bkAge             - Back age array (write).
   * @param bkFlags           - Back flags array (write).
   * @param bkGenome          - Back genome array (write).
   * @param bkVariantId       - Back variant ID array (write).
   * @param bkGeneration      - Back generation array (write).
   * @param bkToxinResist     - Back toxin resist array (write).
   * @param bkNutrientAbs     - Back nutrient abs array (write).
   * @param bkHeatResist      - Back heat resist array (write).
   * @param bkSpreadBonus     - Back spread bonus array (write).
   * @param lifeType          - The specific life type propagating (Life or LifeVariant).
   * @param cellSpreadRate    - Effective per-neighbour spread probability (already includes spreadBonus).
   * @param cellInitEnergy    - Base energy assigned to newly born cells.
   * @param competitionStrength - Probability LifeVariant captures a Life cell.
   * @param toxinStrength     - Toxin entry damage parameter.
   * @param nutrientBoost     - Nutrient entry boost parameter.
   * @param gravityStrength   - GravityWell pull force.
   * @param gravityResponse   - Life's sensitivity to gravity wells.
   * @param pointMutationRate - Effective per-bit genome mutation probability for
   *   this spread event.  The caller passes a stage-adjusted value:
   *   0 for juvenile cells, `pointMutationRate × 2` for senescent cells,
   *   and `config.pointMutationRate` for mature cells (Phase 10).
   * @param antibioticStrength - Phase 12: antibiotic entry penalty for cells
   *   spreading into Antibiotic cells (passed to {@link calcSpreadEnergy}).
   */
  private _trySpread(
    parentIdx:         number,
    nLen:              number,
    ftType:            Uint8Array,
    ftGenome:          Uint16Array,
    ftVariantId:       Uint8Array,
    ftGeneration:      Uint16Array,
    bkType:            Uint8Array,
    bkEnergy:          Float32Array,
    bkAge:             Uint16Array,
    bkFlags:           Uint8Array,
    bkGenome:          Uint16Array,
    bkVariantId:       Uint8Array,
    bkGeneration:      Uint16Array,
    bkToxinResist:     Float32Array,
    bkNutrientAbs:     Float32Array,
    bkHeatResist:      Float32Array,
    bkSpreadBonus:     Float32Array,
    lifeType:          CellType,
    cellSpreadRate:    number,
    cellInitEnergy:    number,
    competitionStrength: number,
    toxinStrength:     number,
    nutrientBoost:     number,
    gravityStrength:   number,
    gravityResponse:   number,
    pointMutationRate: number,
    antibioticStrength: number,
  ): void {
    const isVariant = lifeType === CellType.LifeVariant;
    const width     = this._width;
    const height    = this._height;

    // Read parent genome fields once — shared across all children this tick.
    const parentGenome     = ftGenome[parentIdx];
    const parentVariantId  = ftVariantId[parentIdx];
    const parentGeneration = ftGeneration[parentIdx];

    for (let k = 0; k < nLen; k++) {
      const ni    = this._neighborBuf[k];
      const nType = ftType[ni];

      // Determine whether this neighbour is a valid spread target.
      let baseProb: number;

      if (isEnterable(nType)) {
        baseProb = cellSpreadRate;
      } else if (nType === CellType.Life || nType === CellType.LifeVariant) {
        // Phase 3 / Phase 11: inter-cell competition.
        //
        // When a LifeVariant cell spreads into a plain Life cell (cross-species),
        // the original Phase 3 `competitionStrength` applies directly — these
        // are different species so kin-selection does not reduce aggression.
        //
        // When two LifeVariant cells of the SAME species compete, kin-selection
        // modulates the probability based on variant ID distance:
        //
        //   - Same variantId  → no competition (kin — treated as occupied).
        //   - ΔvariantId ≤ 5  → 50% competition strength (near-kin).
        //   - ΔvariantId > 20 → 150% competition strength (stranger aggression).
        //   - Otherwise       → normal competition strength.
        const targetVariantId = ftVariantId[ni];

        if (lifeType === CellType.LifeVariant && nType === CellType.LifeVariant) {
          // Intra-species competition: apply kin-selection.
          if (targetVariantId === parentVariantId) {
            continue; // same lineage — treated as occupied
          }
          const idDelta = Math.abs((targetVariantId - parentVariantId + 256) % 256);
          let kinFactor: number;
          if (idDelta <= 5) {
            kinFactor = 0.5;   // near-kin: reduced aggression
          } else if (idDelta > 20) {
            kinFactor = 1.5;   // stranger: elevated aggression
          } else {
            kinFactor = 1.0;   // neutral relationship
          }
          baseProb = competitionStrength * kinFactor;
        } else if (lifeType === CellType.LifeVariant && nType === CellType.Life) {
          // Cross-species competition: LifeVariant invades base Life.
          // Use original Phase 3 strength with no kin-selection penalty.
          baseProb = competitionStrength;
        } else {
          // Base Life cannot spread into occupied cells.
          continue;
        }
      } else {
        continue; // impassable cell
      }

      // --- Phase 5: GravityWell spread bias --------------------------------
      let prob = baseProb;

      if (this._wellCount > 0) {
        const { x: targetX, y: targetY } = indexToXY(ni, width, height);

        for (let w = 0; w < this._wellCount; w++) {
          const wellIdx = this._wellBuf[w];
          const { x: wellX, y: wellY } = indexToXY(wellIdx, width, height);
          prob += calcGravityBias(
            wellX, wellY, targetX, targetY, gravityStrength, gravityResponse,
          );
        }
        if (prob > 1.0) prob = 1.0;
      }

      if (Math.random() < prob) {
        // -----------------------------------------------------------------
        // Phase 9: compute child genome via point mutation.
        // stressLevel = 0 here; stress hypermutation is added in Phase 10.
        // -----------------------------------------------------------------
        const childGenome = computeChildGenome(parentGenome, pointMutationRate, 0);

        // Derive child's phenotype from child's genome for use in spawn
        // energy calculation (child faces the environment with its own traits).
        const childToxinResist = getToxinResist(childGenome);
        const childNutrientAbs = getNutrientAbs(childGenome);

        // Compute spawn energy using child's resistance/absorption.
        // Competition targets are treated as Empty for energy purposes.
        const targetForEnergy = (nType === CellType.Life) ? CellType.Empty : nType;
        const spawnEnergy = calcSpreadEnergy(
          targetForEnergy,
          cellInitEnergy,
          toxinStrength,
          childToxinResist,
          nutrientBoost,
          childNutrientAbs,
          antibioticStrength, // Phase 12: entry penalty when spreading into Antibiotic
        );

        // --- Write cell state to back buffer -------------------------------
        bkType[ni]   = lifeType;
        bkEnergy[ni] = spawnEnergy;
        bkAge[ni]    = 0;
        bkFlags[ni]  = 0; // clear any flags from the overwritten cell

        // --- Write genome inheritance to back buffer -----------------------
        bkGenome[ni]     = childGenome;

        // --- Phase 11: assign variantId based on genome divergence ----------
        // Speciation is measured against the LINEAGE REFERENCE genome
        // (_variantRefGenomes[parentVariantId]), not the immediate parent
        // cell's genome.  A single spread can only flip ≤1 bit, so comparing
        // parent→child would never reach the ≥3-bit threshold.  By comparing
        // against the lineage founder's genome, accumulated point mutations
        // across many generations eventually trigger speciation.
        const lineageRefGenome = this._variantRefGenomes[parentVariantId];
        const childVariantId   = assignVariantId(
          parentVariantId,
          lineageRefGenome,
          childGenome,
          this._nextVariantId,
        );
        bkVariantId[ni] = childVariantId;

        // When a new lineage was spawned, advance the next-ID counter,
        // record its founding genome as the new lineage reference, and
        // queue the creation event for the SimulationWorker.
        if (childVariantId !== parentVariantId) {
          // Guard: cap at _MAX_NEW_VARIANTS_PER_TICK to prevent large grids
          // from cycling through all 256 IDs in a single tick and rendering
          // every cell a different colour.
          if (this._newVariantsThisTick >= SimulationEngine._MAX_NEW_VARIANTS_PER_TICK) {
            // Cap reached — treat child as same lineage as parent this tick.
            bkVariantId[ni] = parentVariantId;
          } else {
            this._newVariantsThisTick++;

            // Record this genome as the reference for the newly diverged lineage.
            this._variantRefGenomes[childVariantId] = childGenome;

            // Advance counter, wrapping 255 → 1 (0 reserved for base seed).
            this._nextVariantId = (this._nextVariantId >= MAX_VARIANT_ID) ? 1 : this._nextVariantId + 1;

            // Queue the event if buffer space remains.
            if (this._variantEventCount < MAX_VARIANT_EVENTS) {
              const base = this._variantEventCount * 3;
              this._variantEventsBuf[base]     = childVariantId;
              this._variantEventsBuf[base + 1] = parentVariantId;
              this._variantEventsBuf[base + 2] = childGenome;
              this._variantEventCount++;
            }
          }
        }

        bkGeneration[ni] = parentGeneration < 65535 ? parentGeneration + 1 : 65535;

        // --- Derive and write per-cell phenotype ---------------------------
        // applyPhenotypeFromGenome writes all 4 phenotype buffers in O(1).
        applyPhenotypeFromGenome(
          childGenome,
          bkToxinResist,
          bkNutrientAbs,
          bkHeatResist,
          bkSpreadBonus,
          ni,
        );

        this._stats.births++;
        if (isVariant) {
          this._stats.variantCells++;
        } else {
          this._stats.liveCells++;
        }

        // Phase 18: mark parent as "just divided" so the shader flashes it
        // white for one tick.  OR-assign so other flags are preserved.
        bkFlags[parentIdx] |= CellFlags.JUST_DIVIDED;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cell flag static helpers — used by tests and future phases
  // -------------------------------------------------------------------------

  /**
   * Checks whether a specific bitmask flag is set for cell `i`.
   *
   * @param flags - Flags buffer.
   * @param i     - Cell index.
   * @param flag  - Bitmask to test (see {@link CellFlags}).
   * @returns True if the flag is set.
   */
  static hasFlag(flags: Uint8Array, i: number, flag: number): boolean {
    return (flags[i] & flag) !== 0;
  }

  /**
   * Sets a specific bitmask flag for cell `i`.
   *
   * @param flags - Flags buffer.
   * @param i     - Cell index.
   * @param flag  - Bitmask to set (see {@link CellFlags}).
   */
  static setFlag(flags: Uint8Array, i: number, flag: number): void {
    flags[i] |= flag;
  }

  /**
   * Clears a specific bitmask flag for cell `i`.
   *
   * @param flags - Flags buffer.
   * @param i     - Cell index.
   * @param flag  - Bitmask to clear (see {@link CellFlags}).
   */
  static clearFlag(flags: Uint8Array, i: number, flag: number): void {
    flags[i] &= ~flag;
  }
}

// Re-export CellFlags so consumers of SimulationEngine don't need a separate
// import from GridState for the flag constants.
export { CellFlags };
