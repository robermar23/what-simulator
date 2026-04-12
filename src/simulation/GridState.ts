/**
 * @fileoverview Grid state management for the What Simulator.
 *
 * The entire simulation world is stored as 12 parallel TypedArray buffers
 * (Structure-of-Arrays layout) for maximum cache efficiency during the hot
 * inner tick loop.
 *
 * Double-buffering is used so each tick reads from one set of arrays (the
 * "front" buffer) and writes to the other (the "back" buffer), then the
 * pointers are swapped.  This eliminates read/write ordering dependencies
 * without ever copying data.
 *
 * ## Round 1 buffers (unchanged)
 *   cellType  Uint8Array    262 144 bytes  (~256 KB)   @ 512×512
 *   energy    Float32Array  1 048 576 bytes (~1 MB)    × 2 (double-buffered)
 *   age       Uint16Array   524 288 bytes  (~512 KB)
 *   flags     Uint8Array    262 144 bytes  (~256 KB)
 *
 * ## Round 2 genome buffers (NEW)
 *   genome         Uint16Array   524 288 bytes  (~512 KB)
 *   variantId      Uint8Array    262 144 bytes  (~256 KB)
 *   generation     Uint16Array   524 288 bytes  (~512 KB)
 *   toxinResist    Float32Array  1 048 576 bytes (~1 MB)  × 2
 *   nutrientAbs    Float32Array  1 048 576 bytes (~1 MB)  × 2
 *   heatResist     Float32Array  1 048 576 bytes (~1 MB)  × 2
 *   spreadBonus    Float32Array  1 048 576 bytes (~1 MB)  × 2
 *   signalStrength Float32Array  1 048 576 bytes (~1 MB)  × 2
 *
 * Total at 512×512: ~16.3 MB — well within browser constraints.
 */

import {
  GENOME_NEUTRAL,
  getToxinResist,
  getNutrientAbs,
  getSpreadBonus,
} from './genetics/GenomeEncoder.js';

// ---------------------------------------------------------------------------
// Cell type enum
// ---------------------------------------------------------------------------

/**
 * Every cell in the grid has exactly one of these types.
 * Stored as a Uint8 — values must remain in [0, 255].
 *
 * Round 1 types: Empty–LifeVariant (0–10).
 * Round 2 additions: Mutagen–Colony (11–15).
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
  /**
   * Second life variant produced by mutation in Round 1.
   * @deprecated Round 2 uses `Life + variantId` instead.
   *   Kept for save-file compatibility only.
   */
  LifeVariant = 10,

  // --- Round 2 additions -----------------------------------------------

  /**
   * Mutagen cell: dramatically increases mutation rate for Life cells within
   * range 3.  Depletes by `mutagenDecayRate` per tick; becomes Empty when
   * exhausted.  Visual: pulsing magenta.
   */
  Mutagen     = 11,

  /**
   * RadioWaste cell: permanently emits ionising radiation.  Adjacent Life
   * cells lose energy AND receive random genome bit-flips each tick.
   * Never decays.  Visual: green-yellow radioactive glow.
   */
  RadioWaste  = 12,

  /**
   * Antibiotic cell: adjacent Life cells roll a survival check each tick
   * (`Math.random() < cell.toxinResist`).  Life can spread INTO Antibiotic
   * cells only if `toxinResist > 0.5`.  Visual: white crystalline patches.
   */
  Antibiotic  = 13,

  /**
   * Rewinder cell: gradually shifts adjacent Life cell genome nibbles toward
   * tier 7 (neutral) by 1 per tick, simulating relaxed selection pressure.
   * Does not damage energy.  Visual: blue-silver clockwise spiral.
   */
  Rewinder    = 14,

  /**
   * Colony cell: cooperative infrastructure.  Life cells sharing the same
   * `variantId` as the adjacent Colony cell receive +`colonyBoost` energy
   * per tick.  Life cells sacrifice 0.01 energy/tick to sustain it.
   * Visual: warm amber honeycomb.
   */
  Colony      = 15,
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
  MUTATED:          0b0000_0001,
  /** Cell is dormant (frozen by Ice); no spread or death. */
  DORMANT:          0b0000_0010,
  /** Cell is scheduled to die at the end of this tick. */
  MARKED_FOR_DEATH: 0b0000_0100,
  /** NEW (Round 2): Cell is in the juvenile lifecycle stage (age < juvenileThreshold). */
  JUVENILE:         0b0000_1000,
  /** NEW (Round 2): Cell is in the senescent lifecycle stage (age > senescentThreshold). */
  SENESCENT:        0b0001_0000,
  /** NEW (Round 2): Cell is emitting a quorum signal (Pioneer mode) this tick. */
  SIGNALING:        0b0010_0000,
  /** NEW (Round 2): Cell has survived at least one obstacle stress event. */
  ADAPTED:          0b0100_0000,
} as const;

// ---------------------------------------------------------------------------
// Buffer pair type
// ---------------------------------------------------------------------------

/**
 * One complete set of simulation buffers for the entire grid.
 * The simulation maintains two of these (front + back) for double-buffering.
 *
 * All fields are `readonly` to prevent accidental pointer re-assignment;
 * the underlying TypedArray data is still mutable (as needed by the engine).
 */
export interface GridBuffers {
  // --- Round 1 fields (unchanged) -------------------------------------------

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

  // --- Round 2 genome fields (NEW) ------------------------------------------

  /**
   * 16-bit encoded heritable trait genome.
   *
   * Bit layout:
   *   Bits 15–12: nutrientTier (0–15)
   *   Bits 11–8:  toxinTier    (0–15)
   *   Bits 7–4:   decayTier    (0–15)
   *   Bits 3–0:   spreadTier   (0–15)
   *
   * Neutral genome = 0x7777 (all traits at tier 7).
   * Use {@link GenomeEncoder.unpackGenome} / {@link GenomeEncoder.packGenome}.
   */
  readonly genome: Uint16Array;

  /**
   * Variant lineage identifier.
   * 0 = base Life seed; 1–255 = evolved lineages created by significant
   * mutation (≥3 bits diverging from parent).
   */
  readonly variantId: Uint8Array;

  /**
   * Reproductive generation count — how many parent→child spreads have
   * occurred since the original seed cell.  Saturates at 65 535.
   */
  readonly generation: Uint16Array;

  /**
   * Per-cell evolved toxin damage resistance [0, 1].
   * Derived from genome toxinTier via GENOME_LUT; updated when the cell
   * survives a toxin stress event (adaptive immunity).
   */
  readonly toxinResist: Float32Array;

  /**
   * Per-cell evolved nutrient absorption efficiency [0, 1].
   * Higher values let the cell extract more energy from adjacent Nutrient cells.
   */
  readonly nutrientAbs: Float32Array;

  /**
   * Per-cell evolved fire/heat resistance [0, 1].
   * Reduces the instant-kill probability when adjacent to Fire or RadioWaste.
   */
  readonly heatResist: Float32Array;

  /**
   * Per-cell evolved spread rate delta [-0.5, +0.5].
   * Added to the global `config.spreadRate` to compute effective spread rate.
   */
  readonly spreadBonus: Float32Array;

  /**
   * Chemical signal concentration emitted by this cell [0, 1].
   * Doubles as a quorum-sensing broadcast (Pioneer mode) and a nutrient
   * chemotaxis diffusion field seeded by Nutrient cells.
   */
  readonly signalStrength: Float32Array;
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
 * grid.seed(0.3); // 30% random life with neutral genomes
 * // Per tick:
 * grid.copyFrontToBack(); // snapshot front → back
 * // ...engine writes back...
 * grid.swap();    // flip front ↔ back
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
   * @param width  - Grid width in cells.
   * @param height - Grid height in cells.
   */
  constructor(width: number, height: number) {
    this.width      = width;
    this.height     = height;
    this.totalCells = width * height;

    this.front = GridState._allocate(this.totalCells);
    this.back  = GridState._allocate(this.totalCells);
  }

  /**
   * Allocates a fresh set of zeroed grid buffers for all 12 arrays.
   *
   * @param totalCells - Total number of cells.
   * @returns A new {@link GridBuffers} instance.
   */
  private static _allocate(totalCells: number): GridBuffers {
    return {
      // Round 1 buffers
      cellType:      new Uint8Array(totalCells),
      energy:        new Float32Array(totalCells),
      age:           new Uint16Array(totalCells),
      flags:         new Uint8Array(totalCells),
      // Round 2 genome buffers
      genome:        new Uint16Array(totalCells),
      variantId:     new Uint8Array(totalCells),
      generation:    new Uint16Array(totalCells),
      toxinResist:   new Float32Array(totalCells),
      nutrientAbs:   new Float32Array(totalCells),
      heatResist:    new Float32Array(totalCells),
      spreadBonus:   new Float32Array(totalCells),
      signalStrength: new Float32Array(totalCells),
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
    // Round 1 buffers
    this.back.cellType.set(this.front.cellType);
    this.back.energy.set(this.front.energy);
    this.back.age.set(this.front.age);
    this.back.flags.set(this.front.flags);
    // Round 2 genome buffers
    this.back.genome.set(this.front.genome);
    this.back.variantId.set(this.front.variantId);
    this.back.generation.set(this.front.generation);
    this.back.toxinResist.set(this.front.toxinResist);
    this.back.nutrientAbs.set(this.front.nutrientAbs);
    this.back.heatResist.set(this.front.heatResist);
    this.back.spreadBonus.set(this.front.spreadBonus);
    this.back.signalStrength.set(this.front.signalStrength);
  }

  /**
   * Seeds the front buffer with randomly placed Life cells.
   *
   * All seeded Life cells receive:
   *  - `genome = GENOME_NEUTRAL` (0x7777) — all traits at mid tier so
   *    Round 1 behaviour is preserved until mutations accumulate.
   *  - `variantId = 0` — all cells start in the base lineage.
   *  - `generation = 0` — first generation.
   *  - Per-cell phenotype buffers (toxinResist, nutrientAbs, heatResist,
   *    spreadBonus) are zeroed; the engine will derive them from the genome
   *    on first tick in Phase 9.
   *
   * @param density       - Probability [0, 1] that each cell starts as Life.
   * @param initialEnergy - Starting energy for each seeded life cell [0, 1].
   */
  seed(density: number, initialEnergy = 1.0): void {
    // Pre-compute neutral-genome phenotype values once to avoid repeated LUT
    // lookups inside the loop (no object allocation, just scalar reads).
    const neutralToxinResist = getToxinResist(GENOME_NEUTRAL); // ≈ 0.42
    const neutralNutrientAbs = getNutrientAbs(GENOME_NEUTRAL); // ≈ 0.57
    const neutralSpreadBonus = getSpreadBonus(GENOME_NEUTRAL); // = 0.00
    const neutralHeatResist  = neutralToxinResist * 0.5;       // ≈ 0.21

    const {
      cellType, energy, genome, variantId, generation,
      toxinResist, nutrientAbs, heatResist, spreadBonus, signalStrength,
      age, flags,
    } = this.front;

    for (let i = 0; i < this.totalCells; i++) {
      if (Math.random() < density) {
        cellType[i]    = CellType.Life;
        energy[i]      = initialEnergy;
        genome[i]      = GENOME_NEUTRAL; // 0x7777 — neutral traits
        variantId[i]   = 0;              // base lineage
        generation[i]  = 0;              // first generation
        // Initialise per-cell phenotype from neutral genome so the engine
        // can read the buffer immediately without a separate derivation pass.
        toxinResist[i]  = neutralToxinResist;
        nutrientAbs[i]  = neutralNutrientAbs;
        heatResist[i]   = neutralHeatResist;
        spreadBonus[i]  = neutralSpreadBonus;
        signalStrength[i] = 0;
      } else {
        cellType[i]      = CellType.Empty;
        energy[i]        = 0;
        genome[i]        = 0;
        variantId[i]     = 0;
        generation[i]    = 0;
        toxinResist[i]   = 0;
        nutrientAbs[i]   = 0;
        heatResist[i]    = 0;
        spreadBonus[i]   = 0;
        signalStrength[i] = 0;
      }
      age[i]   = 0;
      flags[i] = 0;
    }
  }

  /**
   * Clears the entire grid to empty cells.
   * Zeros all buffers in both front and back.
   */
  clear(): void {
    for (const buf of [this.front, this.back]) {
      // Round 1 buffers
      buf.cellType.fill(0);
      buf.energy.fill(0);
      buf.age.fill(0);
      buf.flags.fill(0);
      // Round 2 genome buffers
      buf.genome.fill(0);
      buf.variantId.fill(0);
      buf.generation.fill(0);
      buf.toxinResist.fill(0);
      buf.nutrientAbs.fill(0);
      buf.heatResist.fill(0);
      buf.spreadBonus.fill(0);
      buf.signalStrength.fill(0);
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
   *   - `Fire`: fuel supply — always initialised to 1.0 (fully fuelled).
   *   - `Barrier`: fade factor — always initialised to 1.0 (fully opaque).
   *     The engine linearly reduces this to 0 over the barrier's lifetime.
   *   - `Mutagen`: potency stored in energy — initialised to 1.0.
   *   - All others: energy is unused; set to 0.
   *
   * When painting a Life cell, it receives the neutral genome (0x7777) and
   * variantId=0 so it behaves identically to a seeded cell.
   *
   * @param index  - Flat cell index (`y * width + x`).
   * @param type   - Cell type to set.
   * @param energy - Vitality for Life/LifeVariant cells [0, 1] (default 1.0).
   *   Ignored for all other cell types.
   */
  paintCell(index: number, type: CellType, energy = 1.0): void {
    if (index < 0 || index >= this.totalCells) return;
    this.front.cellType[index] = type;

    // Assign energy according to cell-type semantics.
    if (type === CellType.Life || type === CellType.LifeVariant) {
      this.front.energy[index] = energy;
    } else if (
      type === CellType.Nutrient ||
      type === CellType.Fire     ||
      type === CellType.Barrier  ||
      type === CellType.Mutagen
    ) {
      // These cell types use energy as a fuel/potency field, always start full.
      this.front.energy[index] = 1.0;
    } else {
      // Wall, Toxin, Drain, GravityWell, Ice, RadioWaste, Antibiotic,
      // Rewinder, Colony, Empty: energy field is unused.
      this.front.energy[index] = 0;
    }

    // Reset age and flags regardless of type.
    this.front.age[index]   = 0;
    this.front.flags[index] = 0;

    // Reset genome fields.
    if (type === CellType.Life || type === CellType.LifeVariant) {
      // Life cells start with neutral genome and phenotype derived from it,
      // matching seed() behaviour so painted cells are immediately usable.
      this.front.genome[index]      = GENOME_NEUTRAL; // 0x7777
      this.front.variantId[index]   = 0;
      this.front.generation[index]  = 0;
      this.front.toxinResist[index]  = getToxinResist(GENOME_NEUTRAL);
      this.front.nutrientAbs[index]  = getNutrientAbs(GENOME_NEUTRAL);
      this.front.heatResist[index]   = getToxinResist(GENOME_NEUTRAL) * 0.5;
      this.front.spreadBonus[index]  = getSpreadBonus(GENOME_NEUTRAL);
    } else {
      // Non-life cells carry no genome or phenotype.
      this.front.genome[index]      = 0;
      this.front.variantId[index]   = 0;
      this.front.generation[index]  = 0;
      this.front.toxinResist[index]  = 0;
      this.front.nutrientAbs[index]  = 0;
      this.front.heatResist[index]   = 0;
      this.front.spreadBonus[index]  = 0;
    }
    this.front.signalStrength[index] = 0;
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
