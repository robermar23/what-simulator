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
 *   - No obstacle types yet (Phase 2+).
 */

import { CellType, CellFlags, type GridBuffers } from './GridState.js';
import { type SimulationConfig } from './config/SimulationConfig.js';
import { mooreNeighbors, vonNeumannNeighbors } from '../utils/math.js';

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
      cellType:  bkType,  energy:  bkEnergy,  age:  bkAge,  flags: _bkFlags,
    } = back;

    const {
      spreadRate,
      energyDecayRate,
      reproductionThreshold,
      initialEnergy,
      overpopulationLimit,
      underpopulationLimit,
      neighbourhoodMode,
    } = config;

    const useMoore = neighbourhoodMode === 'moore';
    const width    = this._width;
    const height   = this._height;
    const total    = this._total;

    for (let i = 0; i < total; i++) {
      const type = ftType[i];

      if (type === CellType.Empty) {
        // Empty cells: carry forward unchanged (back was pre-copied from front
        // before this loop, so we only need to act when state changes).
        continue;
      }

      if (type === CellType.Life || type === CellType.LifeVariant) {
        // --- Energy decay -------------------------------------------------
        const newEnergy = ftEnergy[i] - energyDecayRate;

        if (newEnergy <= 0) {
          // Cell starves — kill it.
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Neighbour count (for over/underpopulation) -------------------
        const neighbourCount = this._fillNeighbors(i, width, height, useMoore);
        let liveNeighbours = 0;
        const nLen = neighbourCount;
        for (let n = 0; n < nLen; n++) {
          const nType = ftType[this._neighborBuf[n]];
          if (nType === CellType.Life || nType === CellType.LifeVariant) {
            liveNeighbours++;
          }
        }

        // --- Overpopulation death -----------------------------------------
        if (liveNeighbours > overpopulationLimit) {
          bkType[i]   = CellType.Empty;
          bkEnergy[i] = 0;
          bkAge[i]    = 0;
          this._stats.deaths++;
          continue;
        }

        // --- Underpopulation death ----------------------------------------
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
            i, nLen, ftType, bkType, bkEnergy, bkAge,
            type, spreadRate, initialEnergy,
          );
        }
      }
      // Phase 2+ will handle Toxin, Wall, Nutrient, etc. here.
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
   * Attempts to spread the life cell at index `i` into each empty neighbour.
   *
   * Each empty neighbour slot is tried independently at probability
   * `spreadRate`.  A successful spread writes the new cell into the back
   * buffer only — reading always uses the front buffer so spread order doesn't
   * create bias.
   *
   * @param i - Flat index of the spreading cell.
   * @param nLen - Number of valid entries in `_neighborBuf`.
   * @param ftType - Front cell type array (read-only).
   * @param bkType - Back cell type array (write).
   * @param bkEnergy - Back energy array (write).
   * @param bkAge - Back age array (write).
   * @param lifeType - The specific life type to propagate (Life or LifeVariant).
   * @param spreadRate - Per-neighbour spread probability.
   * @param initialEnergy - Energy assigned to newly born cells.
   */
  private _trySpread(
    _i: number,
    nLen: number,
    ftType: Uint8Array,
    bkType: Uint8Array,
    bkEnergy: Float32Array,
    bkAge: Uint16Array,
    lifeType: CellType,
    spreadRate: number,
    initialEnergy: number,
  ): void {
    for (let k = 0; k < nLen; k++) {
      const ni = this._neighborBuf[k];
      // Only spread into Empty cells — the FRONT buffer is authoritative for
      // what was there at the start of this tick.
      if (ftType[ni] === CellType.Empty && Math.random() < spreadRate) {
        bkType[ni]   = lifeType;
        bkEnergy[ni] = initialEnergy;
        bkAge[ni]    = 0;
        this._stats.births++;
        this._stats.liveCells++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Unused flag helper — kept for Phase 2 when flags become meaningful
  // -------------------------------------------------------------------------

  /**
   * Checks whether a specific bitmask flag is set for cell `i` in the given
   * flags buffer.
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
   * Sets a specific bitmask flag for cell `i` in the given flags buffer.
   *
   * @param flags - Flags buffer.
   * @param i - Cell index.
   * @param flag - Bitmask to set (see {@link CellFlags}).
   */
  static setFlag(flags: Uint8Array, i: number, flag: number): void {
    flags[i] |= flag;
  }

  /**
   * Clears a specific bitmask flag for cell `i` in the given flags buffer.
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
