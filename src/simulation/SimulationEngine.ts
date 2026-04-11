/**
 * @fileoverview Core simulation tick logic for the What Simulator.
 *
 * This module is intentionally **pure**: it takes pre-allocated TypedArray
 * buffers and a config object, mutates the back buffer, and returns
 * statistics.  It has zero DOM dependencies and is fully unit-testable without
 * a browser environment.
 *
 * Performance contract: the inner loop must allocate **zero** objects per
 * tick.  All helper arrays (neighbour lists) are allocated once per engine
 * instance and reused.
 *
 * Phase 1 scope:
 *   - Life spread into Empty cells (probabilistic).
 *   - Energy decay and death when energy ≤ 0.
 *   - Overpopulation / underpopulation culling.
 *   - Moore and Von Neumann neighbour modes.
 *
 * Phase 2 additions:
 *   - Wall cells block spread entirely.
 *   - Toxin cells damage adjacent Life cells each tick; Life CAN spread into
 *     Toxin cells (consuming them) but spawns with reduced initial energy.
 *   - Nutrient cells boost adjacent Life energy each tick; they deplete over
 *     time and are consumed when Life spreads into them.
 *   - A single neighbour scan per Life cell now serves triple duty:
 *     live-neighbour counting, toxin/nutrient detection, and spread targeting.
 */

import { CellType, CellFlags, type GridBuffers } from './GridState.js';
import { type SimulationConfig } from './config/SimulationConfig.js';
import { mooreNeighbors, vonNeumannNeighbors } from '../utils/math.js';
import { isEnterable, calcSpreadEnergy } from './rules/obstacleRules.js';

// ---------------------------------------------------------------------------
// Tick statistics
// ---------------------------------------------------------------------------

/**
 * Aggregate statistics returned after each simulation tick.
 * Populated by reusing the same object instance each tick — no allocation.
 */
export interface TickStats {
  /** Total living cells (Life + LifeVariant) after this tick. */
  liveCells: number;
  /** Number of new cells born this tick. */
  births: number;
  /** Number of cells that died this tick. */
  deaths: number;
}

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

  /** Reused stats object — mutated in place each tick. */
  private readonly _stats: TickStats = { liveCells: 0, births: 0, deaths: 0 };

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
    // Reset stats.
    this._stats.liveCells = 0;
    this._stats.births    = 0;
    this._stats.deaths    = 0;

    const {
      cellType:  ftType,  energy:  ftEnergy,  age:  ftAge,
    } = front;
    const {
      cellType:  bkType,  energy:  bkEnergy,  age:  bkAge,
    } = back;

    const {
      spreadRate,
      energyDecayRate,
      reproductionThreshold,
      initialEnergy,
      overpopulationLimit,
      underpopulationLimit,
      neighbourhoodMode,
      toxinStrength,
      toxinResistance,
      nutrientBoost,
      nutrientAbsorption,
      nutrientDecayRate,
    } = config;

    const useMoore = neighbourhoodMode === 'moore';
    const width    = this._width;
    const height   = this._height;
    const total    = this._total;

    for (let i = 0; i < total; i++) {
      const type = ftType[i];

      // ------------------------------------------------------------------
      // Empty and Wall cells: completely static — no updates ever.
      // (back was already pre-copied from front before this loop)
      // ------------------------------------------------------------------
      if (type === CellType.Empty || type === CellType.Wall) continue;

      // ------------------------------------------------------------------
      // Life cells (both variants)
      // ------------------------------------------------------------------
      if (type === CellType.Life || type === CellType.LifeVariant) {

        // Fill the neighbour buffer ONCE and use it for:
        //   1) live-neighbour counting (over/underpop)
        //   2) obstacle adjacency detection (toxin damage, nutrient boost)
        //   3) spread targeting
        const nLen = this._fillNeighbors(i, width, height, useMoore);

        // Single-pass neighbour scan — counts live neighbours AND checks for
        // adjacent obstacle types without a second loop.
        let liveNeighbours   = 0;
        let adjacentToxin    = false;
        let adjacentNutrient = false;

        for (let n = 0; n < nLen; n++) {
          const nType = ftType[this._neighborBuf[n]];
          if (nType === CellType.Life || nType === CellType.LifeVariant) {
            liveNeighbours++;
          } else if (nType === CellType.Toxin) {
            // Only record first toxin found (Phase 2: no stacking).
            if (!adjacentToxin) adjacentToxin = true;
          } else if (nType === CellType.Nutrient) {
            // Only record first nutrient found (Phase 2: no stacking).
            if (!adjacentNutrient) adjacentNutrient = true;
          }
        }

        // --- Energy budget: decay, toxin damage, nutrient boost ----------
        let newEnergy = ftEnergy[i] - energyDecayRate;

        if (adjacentToxin) {
          // Damage scaled by toxin strength, reduced by life's resistance.
          newEnergy -= toxinStrength * (1 - toxinResistance);
        }
        if (adjacentNutrient) {
          // Boost scaled by nutrient strength and life's absorption rate.
          newEnergy += nutrientBoost * nutrientAbsorption;
        }

        // Cap energy at 1.0 (nutrient cannot over-fill a cell).
        if (newEnergy > 1.0) newEnergy = 1.0;

        // --- Death checks ------------------------------------------------

        // Starvation / toxin overload.
        if (newEnergy <= 0) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          this._stats.deaths++;
          continue;
        }

        // Overpopulation: too many live neighbours.
        if (liveNeighbours > overpopulationLimit) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          this._stats.deaths++;
          continue;
        }

        // Underpopulation: too few live neighbours.
        if (liveNeighbours < underpopulationLimit) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Cell survives — update energy and age -----------------------
        bkEnergy[i] = newEnergy;
        // Age increments, capped at Uint16 max (65 535).
        bkAge[i] = ftAge[i] < 65535 ? ftAge[i] + 1 : 65535;
        this._stats.liveCells++;

        // --- Spread (reproduction) ----------------------------------------
        if (newEnergy >= reproductionThreshold) {
          this._trySpread(
            nLen, ftType, bkType, bkEnergy, bkAge,
            type, spreadRate, initialEnergy,
            toxinStrength, toxinResistance,
            nutrientBoost, nutrientAbsorption,
          );
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
      // Guard: if a Life cell spread INTO this Nutrient cell earlier this
      // same tick, `bkType[i]` will already be a Life type — skip the decay
      // update so the spread result wins without being overwritten.
      // ------------------------------------------------------------------
      if (type === CellType.Nutrient) {
        // Check if a Life cell claimed this cell via spread this tick.
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

      // Toxin: static in Phase 2 — no per-tick update.
      // (Phase 5 adds toxin durability / diffusion.)
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
   * Phase 2 spread targets:
   *   - Empty cells:    Life spawns at full `initialEnergy`.
   *   - Toxin cells:    Life spawns with reduced energy (entry damage).
   *                     Toxin is consumed (overwritten by Life type).
   *   - Nutrient cells: Life spawns with boosted energy.
   *                     Nutrient is consumed (overwritten by Life type).
   *   - Wall cells:     Impassable — spread never succeeds.
   *   - Life/LifeVariant: Already occupied — skipped.
   *
   * Each eligible slot is tried independently at probability `spreadRate`.
   * Reads always use the front buffer so spread order doesn't create bias.
   *
   * @param nLen - Number of valid entries in `_neighborBuf`.
   * @param ftType - Front cell type array (read-only).
   * @param bkType - Back cell type array (write).
   * @param bkEnergy - Back energy array (write).
   * @param bkAge - Back age array (write).
   * @param lifeType - The specific life type to propagate (Life or LifeVariant).
   * @param spreadRate - Per-neighbour spread probability [0, 1].
   * @param initialEnergy - Base energy assigned to newly born cells.
   * @param toxinStrength - Toxin entry damage parameter.
   * @param toxinResistance - Toxin resistance multiplier.
   * @param nutrientBoost - Nutrient entry boost parameter.
   * @param nutrientAbsorption - Nutrient absorption multiplier.
   */
  private _trySpread(
    nLen: number,
    ftType: Uint8Array,
    bkType: Uint8Array,
    bkEnergy: Float32Array,
    bkAge: Uint16Array,
    lifeType: CellType,
    spreadRate: number,
    initialEnergy: number,
    toxinStrength: number,
    toxinResistance: number,
    nutrientBoost: number,
    nutrientAbsorption: number,
  ): void {
    for (let k = 0; k < nLen; k++) {
      const ni     = this._neighborBuf[k];
      const nType  = ftType[ni];

      // Phase 2: isEnterable returns true for Empty, Toxin, and Nutrient.
      // Wall and Life/LifeVariant cells are skipped.
      if (!isEnterable(nType)) continue;

      if (Math.random() < spreadRate) {
        // Compute spawn energy based on the target cell's type.
        const spawnEnergy = calcSpreadEnergy(
          nType,
          initialEnergy,
          toxinStrength,
          toxinResistance,
          nutrientBoost,
          nutrientAbsorption,
        );

        bkType[ni]   = lifeType;
        bkEnergy[ni] = spawnEnergy;
        bkAge[ni]    = 0;
        this._stats.births++;
        this._stats.liveCells++;
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
