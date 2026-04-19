/**
 * @fileoverview Variant lineage registry for the Round 2 multi-species system.
 *
 * Runs on the **main thread** — never in the simulation or render worker.
 *
 * The registry records the complete evolutionary history of every variant
 * lineage that has ever existed: when it first appeared, its peak population,
 * when it went extinct, which variant it branched from, and a genome sample
 * from its founding cell.
 *
 * ## Data flow
 *
 * ```
 * SimulationWorker (hot loop)
 *   ↓ variantCreated   message  →  VariantRegistry.registerVariant()
 *   ↓ variantCensus    message  →  VariantRegistry.onCensus()
 *   ↓ variantExtinct   message  →  VariantRegistry.markExtinct()
 *   ↓  (also used by)           →  PhylogeneticTree, PopulationChart, etc.
 * ```
 *
 * ## Variant 0
 *
 * Variant 0 (the base Life seed) is pre-registered at startup via
 * {@link VariantRegistry.bootstrap}.  Its `firstSeenTick = 0`,
 * `parentVariantId = 0` (self-parent), and `genomeSample = 0x7777`
 * (the neutral genome).
 *
 * ## Thread safety
 *
 * The registry is main-thread-only and is mutated synchronously inside the
 * `onmessage` handler.  No locking is required.
 */

import { type VariantCensus } from '../../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// VariantRecord — one entry per lineage
// ---------------------------------------------------------------------------

/**
 * Complete historical record for one variant lineage.
 *
 * All fields are filled in when the lineage is first created and updated
 * as the simulation progresses.  `extinctionTick` is `null` while the
 * variant is alive.
 */
export interface VariantRecord {
  /** Unique variant ID (0 = base seed, 1–255 = evolved lineages). */
  id: number;

  /** Tick on which the first cell of this variant appeared. */
  firstSeenTick: number;

  /** Peak live cell count ever recorded for this variant. */
  peakPopulation: number;

  /**
   * Tick on which the last cell of this variant died, or `null` if the
   * variant is currently alive.
   */
  extinctionTick: number | null;

  /**
   * `variantId` of the parent lineage this variant branched from.
   * For variant 0 (the original seed) this is 0 (self-referential).
   */
  parentVariantId: number;

  /**
   * 16-bit genome of the founding cell that started this lineage.
   * Used to display the initial trait values in the Phylogenetic Tree panel.
   */
  genomeSample: number;
}

// ---------------------------------------------------------------------------
// VariantRegistry class
// ---------------------------------------------------------------------------

/**
 * Maintains the complete evolutionary history for all variant lineages.
 *
 * Usage:
 * ```ts
 * const registry = new VariantRegistry();
 * registry.bootstrap();   // register variant 0 (base seed)
 *
 * // On 'variantCreated' worker message:
 * registry.registerVariant(msg.variantId, msg.parentId, msg.tick, msg.genome);
 *
 * // On 'variantCensus' worker message:
 * registry.onCensus(msg.data);
 *
 * // On 'variantExtinct' worker message:
 * registry.markExtinct(msg.variantId, msg.tick, msg.peakPop);
 *
 * // For the UI:
 * const living = registry.getLivingVariants();
 * const all    = registry.getAllVariants();
 * ```
 */
export class VariantRegistry {
  /**
   * Sparse array of variant records indexed by `variantId` (0–255).
   * Entries are `undefined` for IDs that have never been assigned.
   */
  private readonly _records: (VariantRecord | undefined)[] = new Array(256);

  /**
   * Count of living (non-extinct) variants, cached for fast UI reads.
   * Updated on every `registerVariant`, `onCensus`, and `markExtinct` call.
   */
  private _livingCount = 0;

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  /**
   * Pre-registers variant 0 (the original seeded Life lineage).
   *
   * Must be called once at simulation startup before any worker messages
   * arrive.  Safe to call again after a grid reset — it replaces the variant 0
   * record with fresh values.
   *
   * @param initialGenome - Genome sample for the seed cells (default 0x7777,
   *   the neutral genome used by {@link GridState.seed}).
   */
  bootstrap(initialGenome = 0x7777): void {
    // Clear all records before bootstrapping (handles grid resets).
    this._records.fill(undefined);
    this._livingCount = 0;

    // Register the base Life variant (variant 0).
    this._records[0] = {
      id:              0,
      firstSeenTick:   0,
      peakPopulation:  0,
      extinctionTick:  null,
      parentVariantId: 0,
      genomeSample:    initialGenome,
    };
    this._livingCount = 1;
  }

  // -------------------------------------------------------------------------
  // Mutation (called from worker message handlers)
  // -------------------------------------------------------------------------

  /**
   * Records the creation of a new variant lineage.
   *
   * Called when a `variantCreated` message is received from the simulation
   * worker.  If a record already exists for `id` (from a previous simulation
   * cycle that reused the ID after extinction), it is replaced.
   *
   * @param id       - Newly assigned variant ID (1–255).
   * @param parentId - Variant ID of the parent lineage.
   * @param tick     - Simulation tick when the variant appeared.
   * @param genome   - 16-bit genome of the founding cell.
   */
  registerVariant(id: number, parentId: number, tick: number, genome: number): void {
    if (id < 0 || id > 255) return; // guard against malformed messages

    // If the ID was previously extinct, decrement the old living count before
    // checking whether to increment (we'll add 1 for the new record below).
    const existing = this._records[id];
    if (existing !== undefined && existing.extinctionTick === null) {
      // ID still alive — do not double-count; just overwrite the record.
      // This shouldn't happen in practice but guards against message races.
    } else if (existing === undefined) {
      this._livingCount++;
    } else {
      // Was extinct — reusing the ID for a new lineage.
      this._livingCount++;
    }

    this._records[id] = {
      id,
      firstSeenTick:   tick,
      peakPopulation:  0,
      extinctionTick:  null,
      parentVariantId: parentId,
      genomeSample:    genome,
    };
  }

  /**
   * Updates peak population stats from a census snapshot.
   *
   * Call this once per `variantCensus` worker message.  For each variant, if
   * the census count exceeds the stored peak, the peak is updated.
   *
   * @param census - Population snapshot from the simulation worker.
   */
  onCensus(census: VariantCensus): void {
    for (let v = 0; v < 256; v++) {
      const count = census.counts[v];
      const rec   = this._records[v];
      if (rec !== undefined && count > rec.peakPopulation) {
        rec.peakPopulation = count;
      }
    }
  }

  /**
   * Marks a variant as extinct.
   *
   * Called when a `variantExtinct` message is received from the simulation
   * worker.  The record is updated with the extinction tick and the peak
   * population is refreshed if the reported value is higher than the stored
   * one.
   *
   * @param id      - Variant ID that went extinct.
   * @param tick    - Tick on which the last cell died.
   * @param peakPop - Peak population reported by the worker.
   */
  markExtinct(id: number, tick: number, peakPop: number): void {
    const rec = this._records[id];
    if (rec === undefined || rec.extinctionTick !== null) return;

    rec.extinctionTick = tick;
    if (peakPop > rec.peakPopulation) {
      rec.peakPopulation = peakPop;
    }
    this._livingCount = Math.max(0, this._livingCount - 1);
  }

  // -------------------------------------------------------------------------
  // Queries (called by UI components)
  // -------------------------------------------------------------------------

  /**
   * Returns the record for a specific variant ID, or `undefined` if it has
   * never been assigned.
   *
   * @param id - Variant ID (0–255).
   * @returns The {@link VariantRecord} or `undefined`.
   */
  getRecord(id: number): VariantRecord | undefined {
    return this._records[id];
  }

  /**
   * Returns all known variant records (including extinct variants) as a
   * flat array, sorted by `firstSeenTick` ascending.
   *
   * @returns Sorted array of all variant records that have ever existed.
   */
  getAllVariants(): readonly VariantRecord[] {
    const result: VariantRecord[] = [];
    for (let v = 0; v < 256; v++) {
      const rec = this._records[v];
      if (rec !== undefined) result.push(rec);
    }
    result.sort((a, b) => a.firstSeenTick - b.firstSeenTick);
    return result;
  }

  /**
   * Returns all currently living (non-extinct) variant records.
   *
   * @returns Array of live variant records.
   */
  getLivingVariants(): readonly VariantRecord[] {
    const result: VariantRecord[] = [];
    for (let v = 0; v < 256; v++) {
      const rec = this._records[v];
      if (rec !== undefined && rec.extinctionTick === null) result.push(rec);
    }
    return result;
  }

  /**
   * Returns the number of variant lineages currently alive (not extinct).
   *
   * Cached — O(1).  Used by the status bar and Evolution panel badge.
   *
   * @returns Living variant count (≥ 1 while any Life cells exist).
   */
  get livingCount(): number {
    return this._livingCount;
  }

  /**
   * Returns the total number of variant lineages ever created (including
   * extinct ones).
   *
   * @returns Total variant count (cumulative historical).
   */
  get totalCount(): number {
    let count = 0;
    for (let v = 0; v < 256; v++) {
      if (this._records[v] !== undefined) count++;
    }
    return count;
  }

  /**
   * Checks whether a variant is currently alive (not extinct).
   *
   * @param id - Variant ID to query.
   * @returns `true` if the variant exists and has not gone extinct.
   */
  isAlive(id: number): boolean {
    const rec = this._records[id];
    return rec !== undefined && rec.extinctionTick === null;
  }
}

/** Singleton variant registry shared across all main-thread components. */
export const variantRegistry = new VariantRegistry();
