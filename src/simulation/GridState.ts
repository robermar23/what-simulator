/**
 * @fileoverview Grid state management for the What Simulator.
 *
 * The entire simulation world is stored as four parallel TypedArray buffers
 * (Structure-of-Arrays layout) for maximum cache efficiency during the hot
 * inner tick loop.
 *
 * Double-buffering is used so each tick reads from one set of arrays (the
 * "front" buffer) and writes to the other (the "back" buffer), then the
 * pointers are swapped.  This eliminates read/write ordering dependencies
 * without ever copying data.
 *
 * Memory layout at 512×512:
 *   cellType  Uint8Array   262 144 bytes  (~256 KB)
 *   energy    Float32Array 1 048 576 bytes (~1 MB)  × 2 (double-buffered)
 *   age       Uint16Array  524 288 bytes  (~512 KB)
 *   flags     Uint8Array   262 144 bytes  (~256 KB)
 *   Total: ~2.3 MB per full grid set.
 */

// ---------------------------------------------------------------------------
// Cell type enum
// ---------------------------------------------------------------------------

/**
 * Every cell in the grid has exactly one of these types.
 * Stored as a Uint8 — values must remain in [0, 255].
 *
 * Phase 2 activates Wall, Toxin, and Nutrient.  Remaining types are Phase 5+.
 */
export const enum CellType {
  Empty       = 0,
  Life        = 1,
  Wall        = 2,
  Toxin       = 3,
  Nutrient    = 4,
  Drain       = 5,
  GravityWell = 6,
  Barrier     = 7,
  Fire        = 8,
  Ice         = 9,
  /** Second life variant produced by mutation. */
  LifeVariant = 10,
}

// ---------------------------------------------------------------------------
// Cell flag bitmask constants
// ---------------------------------------------------------------------------

/**
 * Bitmask flags stored in the `flags` Uint8Array.
 * Multiple flags may be set simultaneously on a single cell.
 */
export const CellFlags = {
  /** Cell has undergone at least one mutation event. */
  MUTATED:         0b0000_0001,
  /** Cell is dormant (frozen by ice); no spread or death. */
  DORMANT:         0b0000_0010,
  /** Cell is scheduled to die at the end of this tick. */
  MARKED_FOR_DEATH: 0b0000_0100,
} as const;

// ---------------------------------------------------------------------------
// Buffer pair type
// ---------------------------------------------------------------------------

/**
 * One complete set of simulation buffers for the entire grid.
 * The simulation maintains two of these (front + back) for double-buffering.
 */
export interface GridBuffers {
  /**
   * Cell type for each index — see {@link CellType}.
   * Index: `y * width + x`.
   */
  readonly cellType: Uint8Array;

  /**
   * Energy level in [0, 1] for each cell.
   * Life cells die when energy reaches 0.
   */
  readonly energy: Float32Array;

  /**
   * Age in simulation ticks for each cell (saturates at 65 535).
   * Useful for colouring older vs younger life differently.
   */
  readonly age: Uint16Array;

  /**
   * Bitmask flags — see {@link CellFlags}.
   */
  readonly flags: Uint8Array;
}

// ---------------------------------------------------------------------------
// GridState class
// ---------------------------------------------------------------------------

/**
 * Manages the double-buffered grid state for the whole simulation.
 *
 * Usage:
 * ```ts
 * const grid = new GridState(256, 256);
 * grid.seed(0.3); // 30% random life
 * // Per tick:
 * grid.swap();    // flip front ↔ back after each tick
 * ```
 */
export class GridState {
  /** Grid width in cells. */
  readonly width: number;

  /** Grid height in cells. */
  readonly height: number;

  /** Total number of cells (`width * height`). */
  readonly totalCells: number;

  /** The buffer the simulation reads from this tick. */
  front: GridBuffers;

  /** The buffer the simulation writes to this tick. */
  back: GridBuffers;

  /**
   * Allocates both front and back buffer sets.
   *
   * @param width - Grid width in cells.
   * @param height - Grid height in cells.
   */
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.totalCells = width * height;

    this.front = GridState._allocate(this.totalCells);
    this.back  = GridState._allocate(this.totalCells);
  }

  /**
   * Allocates a fresh set of zeroed grid buffers.
   *
   * @param totalCells - Total number of cells.
   * @returns A new {@link GridBuffers} instance.
   */
  private static _allocate(totalCells: number): GridBuffers {
    return {
      cellType: new Uint8Array(totalCells),
      energy:   new Float32Array(totalCells),
      age:      new Uint16Array(totalCells),
      flags:    new Uint8Array(totalCells),
    };
  }

  /**
   * Swaps front and back buffers.  Call this at the end of each tick so the
   * newly written back buffer becomes the authoritative front buffer.
   */
  swap(): void {
    const temp = this.front;
    this.front = this.back;
    this.back  = temp;
  }

  /**
   * Copies all front buffer contents into the back buffer so the back buffer
   * starts each tick as a faithful copy of the current world state.
   * The simulation then only needs to write cells that actually change.
   *
   * Call this BEFORE starting each tick loop iteration.
   */
  copyFrontToBack(): void {
    this.back.cellType.set(this.front.cellType);
    this.back.energy.set(this.front.energy);
    this.back.age.set(this.front.age);
    this.back.flags.set(this.front.flags);
  }

  /**
   * Seeds the front buffer with randomly placed Life cells.
   *
   * @param density - Probability [0, 1] that each cell starts as Life.
   * @param initialEnergy - Starting energy for each seeded life cell [0, 1].
   */
  seed(density: number, initialEnergy = 1.0): void {
    const { cellType, energy } = this.front;
    for (let i = 0; i < this.totalCells; i++) {
      if (Math.random() < density) {
        cellType[i] = CellType.Life;
        energy[i]   = initialEnergy;
      } else {
        cellType[i] = CellType.Empty;
        energy[i]   = 0;
      }
    }
    // Reset age and flags to zero.
    this.front.age.fill(0);
    this.front.flags.fill(0);
  }

  /**
   * Clears the entire grid to empty cells.
   * Zeros all buffers in both front and back.
   */
  clear(): void {
    for (const buf of [this.front, this.back]) {
      buf.cellType.fill(0);
      buf.energy.fill(0);
      buf.age.fill(0);
      buf.flags.fill(0);
    }
  }

  /**
   * Writes a single cell directly into the front buffer.
   * Used by the drawing tools to paint cells while the simulation runs.
   *
   * Energy semantics vary by cell type:
   *   - `Life` / `LifeVariant`: vitality — uses the caller-supplied `energy`.
   *   - `Nutrient`: durability / remaining potency — always initialised to
   *     1.0 (full) regardless of the `energy` argument.
   *   - All others (`Wall`, `Toxin`, `Empty`, etc.): energy is unused; set to 0.
   *
   * @param index - Flat cell index (`y * width + x`).
   * @param type - Cell type to set.
   * @param energy - Vitality for Life/LifeVariant cells [0, 1] (default 1.0).
   *   Ignored for all other cell types.
   */
  paintCell(index: number, type: CellType, energy = 1.0): void {
    if (index < 0 || index >= this.totalCells) return;
    this.front.cellType[index] = type;

    // Assign energy according to cell-type semantics.
    if (type === CellType.Life || type === CellType.LifeVariant) {
      // Life vitality — caller-controlled.
      this.front.energy[index] = energy;
    } else if (type === CellType.Nutrient) {
      // Nutrients always start at full potency (1.0) when painted.
      this.front.energy[index] = 1.0;
    } else {
      // Walls, Toxins, Empty, etc.: energy field is unused.
      this.front.energy[index] = 0;
    }

    this.front.age[index]   = 0;
    this.front.flags[index] = 0;
  }

  /**
   * Counts how many cells in the front buffer have a given {@link CellType}.
   * Used by the status bar to report live cell counts.
   *
   * @param type - Cell type to count.
   * @returns Number of cells with that type.
   */
  countCells(type: CellType): number {
    const arr = this.front.cellType;
    let count = 0;
    for (let i = 0; i < this.totalCells; i++) {
      if (arr[i] === type) count++;
    }
    return count;
  }
}
