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
   * @param front - Source buffers for this tick (read-only by convention).
   * @param back  - Destination buffers for this tick (written).
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

    const {
      cellType:  ftType,  energy:  ftEnergy,  age:  ftAge, flags: ftFlags,
    } = front;
    const {
      cellType:  bkType,  energy:  bkEnergy,  age:  bkAge, flags: bkFlags,
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
      toxinResistance,
      nutrientBoost,
      nutrientAbsorption,
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
    } = config;

    const useMoore = neighbourhoodMode === 'moore';
    const width    = this._width;
    const height   = this._height;
    const total    = this._total;

    // -----------------------------------------------------------------------
    // Phase 5: Pre-scan for GravityWell positions.
    //
    // We do one cheap O(N) scan of the entire grid to collect all well indices
    // into `_wellBuf`.  This avoids an inner O(N) scan for every Life cell
    // spread attempt, giving us O(N + W * L) where W = wells and L = life.
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
    //
    // Walk every cell index.  We copied front → back before the loop so every
    // cell's back-buffer value starts as a faithful snapshot; we only write
    // cells that actually change.
    // -----------------------------------------------------------------------
    for (let i = 0; i < total; i++) {
      const type = ftType[i];

      // ---- Empty / Wall / GravityWell / Drain / Ice: no per-tick change ---
      // These cell types are fully static — their state never changes unless
      // the user paints over them.  Skip immediately for performance.
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
      //
      // A Barrier is an impassable wall that decays over time.
      //   - Age increments each tick (from the pre-copied back buffer).
      //   - Energy is set to the linear fade factor (1 → 0 over lifetime).
      //   - When age ≥ barrierLifetime, the cell becomes Empty.
      //
      // Guard: if a non-Barrier cell overwrote this Barrier (e.g. via fire
      // spread in the same tick), skip the barrier update.
      // ------------------------------------------------------------------
      if (type === CellType.Barrier) {
        // Check if something already overwrote this cell this tick.
        if (bkType[i] !== CellType.Barrier) continue;

        const newAge = ftAge[i] + 1;

        if (isBarrierExpired(newAge, barrierLifetime)) {
          // Barrier has crumbled.
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
        } else {
          // Still standing — update fade energy and increment age.
          bkAge[i]    = newAge < 65535 ? newAge : 65535;
          bkEnergy[i] = calcBarrierEnergy(newAge, barrierLifetime);
        }
        continue;
      }

      // ------------------------------------------------------------------
      // Fire cells (Phase 5)
      //
      // Fire is a spreading, burning obstacle:
      //   1. Spreads to adjacent Life, LifeVariant, and Nutrient cells.
      //   2. Burns down by `fireBurnRate` each tick.
      //   3. Becomes Empty when fuel is exhausted.
      //
      // Guard: if something already claimed this cell this tick (e.g. a
      // newly-spread fire from another fire cell), skip.
      // ------------------------------------------------------------------
      if (type === CellType.Fire) {
        if (bkType[i] !== CellType.Fire) continue;

        // Step 1: spread to adjacent flammable cells.
        const nLen = this._fillNeighbors(i, width, height, useMoore);
        spreadFire(nLen, this._neighborBuf, ftType, bkType, bkEnergy);

        // Step 2: burn down fuel.
        const newFuel = calcFireBurndown(ftEnergy[i], fireBurnRate);
        if (newFuel <= 0) {
          // Fire has burned out.
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
      // Nutrient cells — deplete over time (Phase 2).
      //
      // A Nutrient cell's energy represents its remaining potency (starts
      // at 1.0 when painted).  It decays by `nutrientDecayRate` each tick.
      // When depleted it becomes Empty.
      //
      // Guard: if a Life cell spread INTO this Nutrient cell (or Fire
      // converted it) earlier this tick, `bkType[i]` will already be a
      // different type — skip the decay update so the spread result wins.
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
      // Toxin cells: static in Phase 5 (no per-tick depletion yet).
      // ------------------------------------------------------------------
      if (type === CellType.Toxin) {
        // Nothing to update — Toxin adjacency damage is applied to adjacent
        // Life cells during the Life cell's own update, not here.
        continue;
      }

      // ------------------------------------------------------------------
      // Life cells (both variants)
      //
      // Phase 3: LifeVariant uses separate config values for decay and
      // spread, but shares the same neighbour scanning, death checks, and
      // obstacle interaction logic as regular Life.
      //
      // Phase 5 additions:
      //   - Adjacent Ice   → dormant (no decay, no spread, no death).
      //   - Adjacent Fire  → instant death.
      //   - Adjacent Drain → extra energy loss + halved spread rate.
      //   - GravityWell    → spread bias toward well centres.
      // ------------------------------------------------------------------
      if (type === CellType.Life || type === CellType.LifeVariant) {
        // Determine which set of parameters to use based on cell type.
        const isVariant = type === CellType.LifeVariant;
        const cellDecayRate   = isVariant ? variantEnergyDecayRate        : energyDecayRate;
        const cellSpreadRate  = isVariant ? variantSpreadRate              : spreadRate;
        const cellReproThresh = isVariant ? variantReproductionThreshold   : reproductionThreshold;
        const cellInitEnergy  = isVariant ? variantInitialEnergy           : initialEnergy;

        // Fill the neighbour buffer ONCE and use it for:
        //   1) live-neighbour counting (over/underpop)
        //   2) obstacle adjacency detection (all Phase 2 + Phase 5 types)
        //   3) spread targeting
        const nLen = this._fillNeighbors(i, width, height, useMoore);

        // Single-pass neighbour scan — counts live neighbours AND checks for
        // all adjacent obstacle types without a second loop.
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

        // --- Phase 5: Ice check — dormancy overrides ALL other processing --
        // A cell frozen by Ice does not decay, spread, or die.
        // It just sits there; we copy its current state unchanged.
        if (hasAdjacentIce(this._neighborBuf, nLen, ftType)) {
          // Frozen: energy and age are preserved from front → back (already
          // pre-copied).  Set the DORMANT flag so the renderer can visually
          // distinguish frozen cells if desired.
          bkFlags[i] = ftFlags[i] | CellFlags.DORMANT;
          if (isVariant) this._stats.variantCells++;
          else           this._stats.liveCells++;
          continue;
        }

        // Clear dormant flag if no longer adjacent to Ice.
        bkFlags[i] = ftFlags[i] & ~CellFlags.DORMANT;

        // --- Phase 5: Fire check — life consumed by fire ------------------
        // A Life cell adjacent to Fire is instantly consumed and BECOMES a
        // new Fire cell (full fuel).  "Instant death; fire spreads" per the
        // plan interaction matrix.  We write Fire here so that if the Fire
        // cell is processed after this Life cell in the same tick, its own
        // spreadFire() will write the same value — no conflict.
        if (hasAdjacentFire(this._neighborBuf, nLen, ftType)) {
          bkType[i]   = CellType.Fire;
          bkEnergy[i] = 1.0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Phase 5: Drain adjacency — extra energy loss -----------------
        const adjacentDrain = hasAdjacentDrain(this._neighborBuf, nLen, ftType);

        // --- Energy budget: decay, toxin damage, nutrient boost, drain ----
        let newEnergy = ftEnergy[i] - cellDecayRate;

        if (adjacentToxin) {
          // Damage scaled by toxin strength, reduced by life's resistance.
          newEnergy -= toxinStrength * (1 - toxinResistance);
        }
        if (adjacentNutrient) {
          // Boost scaled by nutrient strength and life's absorption rate.
          newEnergy += nutrientBoost * nutrientAbsorption;
        }
        if (adjacentDrain) {
          // Drain sucks additional energy each tick.
          newEnergy -= drainRate;
        }

        // Cap energy at 1.0 (nutrient cannot over-fill a cell).
        if (newEnergy > 1.0) newEnergy = 1.0;

        // --- Death checks ------------------------------------------------

        // Starvation / toxin / drain overload.
        if (newEnergy <= 0) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        // Overpopulation: too many live neighbours.
        if (liveNeighbours > overpopulationLimit) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        // Underpopulation: too few live neighbours.
        if (liveNeighbours < underpopulationLimit) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          bkFlags[i]  = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Cell survives — update energy and age -----------------------
        bkEnergy[i] = newEnergy;
        // Age increments, capped at Uint16 max (65 535).
        bkAge[i] = ftAge[i] < 65535 ? ftAge[i] + 1 : 65535;

        // --- Mutation (Phase 3): regular Life may mutate to LifeVariant --
        // This runs AFTER survival is confirmed so dying cells cannot
        // mutate.  Mutation is written to the back buffer so it takes
        // effect next tick.
        if (!isVariant && mutationRate > 0 && Math.random() < mutationRate) {
          // Transform this cell into LifeVariant B.
          bkType[i]  = CellType.LifeVariant;
          bkFlags[i] = ftFlags[i] | CellFlags.MUTATED;
          this._stats.variantCells++;
        } else {
          // Cell type and flags remain as they were (already pre-copied).
          // Just update the stats counter.
          if (isVariant) {
            this._stats.variantCells++;
          } else {
            this._stats.liveCells++;
          }
        }

        // --- Spread (reproduction) ----------------------------------------
        // Phase 5: Drain halves the effective spread rate for adjacent cells.
        const effectiveSpreadRate = adjacentDrain
          ? cellSpreadRate * 0.5
          : cellSpreadRate;

        if (newEnergy >= cellReproThresh) {
          this._trySpread(
            nLen,
            ftType,
            bkType,
            bkEnergy,
            bkAge,
            type,
            effectiveSpreadRate,
            cellInitEnergy,
            competitionStrength,
            toxinStrength,
            toxinResistance,
            nutrientBoost,
            nutrientAbsorption,
            gravityStrength,
            gravityResponse,
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
   * This is the tight inner-loop function — it avoids any array allocation by
   * writing directly into the pre-allocated `_neighborBuf`.
   *
   * @param i - Flat index of the source cell.
   * @param width - Grid width.
   * @param height - Grid height.
   * @param useMoore - True for Moore (8-cell); false for Von Neumann (4-cell).
   * @returns Number of valid neighbours written into `_neighborBuf`.
   */
  private _fillNeighbors(
    i: number,
    width: number,
    height: number,
    useMoore: boolean,
  ): number {
    // Get neighbours from utils — these functions don't allocate on every call
    // because we delegate allocation there.  For Phase 4 we can inline this
    // loop entirely but for now clarity > micro-optimisation.
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
   * Attempts to spread the life cell at index `i` into eligible neighbours.
   *
   * ## Spread targets (Phase 2 + Phase 5)
   *   - Empty cells:    Life spawns at full `cellInitEnergy`.
   *   - Toxin cells:    Life spawns with reduced energy (entry damage).
   *                     Toxin is consumed (overwritten by Life type).
   *   - Nutrient cells: Life spawns with boosted energy.
   *                     Nutrient is consumed (overwritten by Life type).
   *   - Wall / Drain / GravityWell / Barrier / Fire / Ice: Impassable — blocked.
   *   - Life/LifeVariant: Normally occupied — skipped.
   *
   * ## Phase 3 addition — LifeVariant competition
   *   - LifeVariant cells MAY spread into regular Life cells with probability
   *     `competitionStrength`.  Regular Life cannot spread into LifeVariant.
   *
   * ## Phase 5 addition — GravityWell bias
   *   - For each candidate target neighbour, the spread probability is boosted
   *     by the sum of inverse-square pull from all active GravityWell cells.
   *     This creates a directional bias toward well centres without blocking.
   *
   * @param nLen - Number of valid entries in `_neighborBuf`.
   * @param ftType - Front cell type array (read-only).
   * @param bkType - Back cell type array (write).
   * @param bkEnergy - Back energy array (write).
   * @param bkAge - Back age array (write).
   * @param lifeType - The specific life type to propagate (Life or LifeVariant).
   * @param cellSpreadRate - Per-neighbour base spread probability [0, 1].
   * @param cellInitEnergy - Base energy assigned to newly born cells.
   * @param competitionStrength - Probability LifeVariant captures a Life cell.
   * @param toxinStrength - Toxin entry damage parameter.
   * @param toxinResistance - Toxin resistance multiplier.
   * @param nutrientBoost - Nutrient entry boost parameter.
   * @param nutrientAbsorption - Nutrient absorption multiplier.
   * @param gravityStrength - GravityWell pull force.
   * @param gravityResponse - Life's sensitivity to gravity wells.
   */
  private _trySpread(
    nLen: number,
    ftType: Uint8Array,
    bkType: Uint8Array,
    bkEnergy: Float32Array,
    bkAge: Uint16Array,
    lifeType: CellType,
    cellSpreadRate: number,
    cellInitEnergy: number,
    competitionStrength: number,
    toxinStrength: number,
    toxinResistance: number,
    nutrientBoost: number,
    nutrientAbsorption: number,
    gravityStrength: number,
    gravityResponse: number,
  ): void {
    const isVariant = lifeType === CellType.LifeVariant;
    const width     = this._width;
    const height    = this._height;

    for (let k = 0; k < nLen; k++) {
      const ni     = this._neighborBuf[k];
      const nType  = ftType[ni];

      // Determine whether this neighbour is a valid spread target and which
      // base probability applies.
      let baseProb: number;

      if (isEnterable(nType)) {
        // Normal spread into Empty / Toxin / Nutrient cells.
        baseProb = cellSpreadRate;
      } else if (isVariant && nType === CellType.Life) {
        // Phase 3: LifeVariant can compete against regular Life cells.
        baseProb = competitionStrength;
      } else {
        // Impassable (Wall, Drain, GravityWell, Barrier, Fire, Ice) or
        // same-type/opponent variant — cannot spread here.
        continue;
      }

      // --- Phase 5: GravityWell spread bias --------------------------------
      // For each active well, add its directional pull bonus to `prob`.
      // The pull is computed from the well centre to the CANDIDATE TARGET
      // (ni), not the source cell, so the bias attracts spread toward the
      // well rather than the cell itself.
      let prob = baseProb;

      if (this._wellCount > 0) {
        const { x: targetX, y: targetY } = indexToXY(ni, width, height);

        for (let w = 0; w < this._wellCount; w++) {
          const wellIdx = this._wellBuf[w];
          const { x: wellX, y: wellY } = indexToXY(wellIdx, width, height);
          prob += calcGravityBias(
            wellX, wellY,
            targetX, targetY,
            gravityStrength, gravityResponse,
          );
        }
        // Cap at 1.0 so we don't pass > 1 to Math.random() comparison.
        if (prob > 1.0) prob = 1.0;
      }

      if (Math.random() < prob) {
        // Compute spawn energy based on the target cell's type.
        // Competition targets are treated as Empty for energy purposes
        // (the variant takes over at its own initial energy).
        const targetForEnergy = (nType === CellType.Life) ? CellType.Empty : nType;
        const spawnEnergy = calcSpreadEnergy(
          targetForEnergy,
          cellInitEnergy,
          toxinStrength,
          toxinResistance,
          nutrientBoost,
          nutrientAbsorption,
        );

        bkType[ni]   = lifeType;
        bkEnergy[ni] = spawnEnergy;
        bkAge[ni]    = 0;
        this._stats.births++;
        // Track spread result in the right counter.
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
   * @param i - Cell index.
   * @param flag - Bitmask to test (see {@link CellFlags}).
   * @returns True if the flag is set.
   */
  static hasFlag(flags: Uint8Array, i: number, flag: number): boolean {
    return (flags[i] & flag) !== 0;
  }

  /**
   * Sets a specific bitmask flag for cell `i`.
   *
   * @param flags - Flags buffer.
   * @param i - Cell index.
   * @param flag - Bitmask to set (see {@link CellFlags}).
   */
  static setFlag(flags: Uint8Array, i: number, flag: number): void {
    flags[i] |= flag;
  }

  /**
   * Clears a specific bitmask flag for cell `i`.
   *
   * @param flags - Flags buffer.
   * @param i - Cell index.
   * @param flag - Bitmask to clear (see {@link CellFlags}).
   */
  static clearFlag(flags: Uint8Array, i: number, flag: number): void {
    flags[i] &= ~flag;
  }
}

// Re-export CellFlags so consumers of SimulationEngine don't need a separate
// import from GridState for the flag constants.
export { CellFlags };
