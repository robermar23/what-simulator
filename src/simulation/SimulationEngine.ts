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
    } = back;

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
    } = config;

    const useMoore = neighbourhoodMode === 'moore';
    const width    = this._width;
    const height   = this._height;
    const total    = this._total;

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

      // ---- Static cell types — skip immediately ---------------------------
      if (
        type === CellType.Empty      ||
        type === CellType.Wall       ||
        type === CellType.GravityWell||
        type === CellType.Drain      ||
        type === CellType.Ice
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
        // Effective spread rate = base config rate + per-cell genome bonus.
        const cellSpreadRate  = baseSpreadRate + cellSpreadBns;

        const nLen = this._fillNeighbors(i, width, height, useMoore);

        // Single-pass neighbour scan.
        let liveNeighbours   = 0;
        let adjacentToxin    = false;
        let adjacentNutrient = false;

        for (let n = 0; n < nLen; n++) {
          const nType = ftType[this._neighborBuf[n]];
          if (nType === CellType.Life || nType === CellType.LifeVariant) {
            liveNeighbours++;
          } else if (nType === CellType.Toxin) {
            if (!adjacentToxin) adjacentToxin = true;
          } else if (nType === CellType.Nutrient) {
            if (!adjacentNutrient) adjacentNutrient = true;
          }
        }

        // --- Ice dormancy override ----------------------------------------
        if (hasAdjacentIce(this._neighborBuf, nLen, ftType)) {
          bkFlags[i] = ftFlags[i] | CellFlags.DORMANT;
          if (isVariant) this._stats.variantCells++;
          else           this._stats.liveCells++;
          continue;
        }

        bkFlags[i] = ftFlags[i] & ~CellFlags.DORMANT;

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

        // --- Energy budget: per-cell resist/absorption (Phase 9) ----------
        let newEnergy = ftEnergy[i] - cellDecayRate;

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

        if (newEnergy > 1.0) newEnergy = 1.0;

        // --- Death checks ------------------------------------------------

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

        // --- Legacy Phase 3 mutation (Life → LifeVariant) -----------------
        if (!isVariant && mutationRate > 0 && Math.random() < mutationRate) {
          bkType[i]  = CellType.LifeVariant;
          bkFlags[i] = ftFlags[i] | CellFlags.MUTATED;
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
        const effectiveSpreadRate = adjacentDrain
          ? cellSpreadRate * 0.5
          : cellSpreadRate;

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
            pointMutationRate,
          );
        }

        continue;
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
   * @param pointMutationRate - Per-bit genome mutation probability per spread.
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
      } else if (isVariant && nType === CellType.Life) {
        // Phase 3: LifeVariant competes against regular Life.
        baseProb = competitionStrength;
      } else {
        continue; // impassable or same-type cell
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
        );

        // --- Write cell state to back buffer -------------------------------
        bkType[ni]   = lifeType;
        bkEnergy[ni] = spawnEnergy;
        bkAge[ni]    = 0;
        bkFlags[ni]  = 0; // clear any flags from the overwritten cell

        // --- Write genome inheritance to back buffer -----------------------
        bkGenome[ni]     = childGenome;
        // Phase 9: variantId inherited unchanged; Phase 11 will branch new IDs
        // when countBitDifferences(parentGenome, childGenome) >= 3.
        bkVariantId[ni]  = parentVariantId;
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
