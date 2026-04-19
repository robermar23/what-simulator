/**
 * @fileoverview Unit tests for VariantRegistry (Phase 11).
 *
 * Scenarios covered:
 *   - bootstrap: registers variant 0 with correct initial state.
 *   - bootstrap: clears all records and resets livingCount on re-call.
 *   - bootstrap: accepts a custom initial genome.
 *   - registerVariant: creates a new record with the correct fields.
 *   - registerVariant: increments livingCount on a fresh ID.
 *   - registerVariant: re-registers an extinct ID and re-increments livingCount.
 *   - registerVariant: out-of-range IDs are silently ignored.
 *   - onCensus: updates peakPopulation when census count exceeds stored peak.
 *   - onCensus: does not decrease peakPopulation.
 *   - onCensus: ignores variants with no record.
 *   - markExtinct: sets extinctionTick and decrements livingCount.
 *   - markExtinct: updates peakPop if reported value is higher.
 *   - markExtinct: is idempotent (double-call does not double-decrement).
 *   - markExtinct: no-ops on an unknown id.
 *   - livingCount getter: reflects all mutations.
 *   - totalCount getter: includes extinct variants.
 *   - isAlive: correct for alive, extinct, and unknown variants.
 *   - getLivingVariants: only returns non-extinct records.
 *   - getAllVariants: sorted by firstSeenTick, includes extinct.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VariantRegistry }                    from './VariantRegistry.js';
import { type VariantCensus }                 from '../../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal VariantCensus with all counts set to the values in the
 * `counts` record.  Only the `counts` array matters for `onCensus` tests.
 *
 * @param counts - Object mapping variantId → count.
 * @param tick   - Census tick number.
 * @returns A {@link VariantCensus} suitable for `onCensus` testing.
 */
function makeCensus(counts: Record<number, number>, tick = 0): VariantCensus {
  const c = new Uint32Array(256);
  for (const [id, val] of Object.entries(counts)) {
    c[Number(id)] = val;
  }
  return {
    tick,
    counts:     c,
    meanGenome: new Uint16Array(256),
    meanAge:    new Float32Array(256),
    meanGen:    new Float32Array(256),
  };
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

describe('VariantRegistry — bootstrap', () => {
  let reg: VariantRegistry;

  beforeEach(() => {
    reg = new VariantRegistry();
  });

  it('registers variant 0 with correct initial fields', () => {
    reg.bootstrap();

    const rec = reg.getRecord(0);
    expect(rec).toBeDefined();
    expect(rec!.id).toBe(0);
    expect(rec!.firstSeenTick).toBe(0);
    expect(rec!.peakPopulation).toBe(0);
    expect(rec!.extinctionTick).toBeNull();
    expect(rec!.parentVariantId).toBe(0); // self-referential for the base seed
    expect(rec!.genomeSample).toBe(0x7777);  // default neutral genome
  });

  it('uses a custom initialGenome when provided', () => {
    reg.bootstrap(0xABCD);
    expect(reg.getRecord(0)!.genomeSample).toBe(0xABCD);
  });

  it('sets livingCount to 1 after bootstrap', () => {
    reg.bootstrap();
    expect(reg.livingCount).toBe(1);
  });

  it('clears all previously registered variants on re-call', () => {
    reg.bootstrap();
    reg.registerVariant(5, 0, 10, 0x1234);
    expect(reg.livingCount).toBe(2);

    // Re-bootstrap should wipe everything and start fresh.
    reg.bootstrap();
    expect(reg.getRecord(5)).toBeUndefined();
    expect(reg.livingCount).toBe(1);
  });

  it('returns isAlive(0) === true after bootstrap', () => {
    reg.bootstrap();
    expect(reg.isAlive(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerVariant
// ---------------------------------------------------------------------------

describe('VariantRegistry — registerVariant', () => {
  let reg: VariantRegistry;

  beforeEach(() => {
    reg = new VariantRegistry();
    reg.bootstrap();
  });

  it('creates a new record with all fields set correctly', () => {
    reg.registerVariant(3, 0, 42, 0xBEEF);

    const rec = reg.getRecord(3);
    expect(rec).toBeDefined();
    expect(rec!.id).toBe(3);
    expect(rec!.firstSeenTick).toBe(42);
    expect(rec!.parentVariantId).toBe(0);
    expect(rec!.genomeSample).toBe(0xBEEF);
    expect(rec!.peakPopulation).toBe(0);
    expect(rec!.extinctionTick).toBeNull();
  });

  it('increments livingCount when a fresh ID is registered', () => {
    const before = reg.livingCount;
    reg.registerVariant(7, 0, 10, 0x1111);
    expect(reg.livingCount).toBe(before + 1);
  });

  it('re-registers an extinct ID and increments livingCount again', () => {
    reg.registerVariant(7, 0, 10, 0x1111);
    reg.markExtinct(7, 20, 50);
    const afterExtinct = reg.livingCount;

    reg.registerVariant(7, 0, 30, 0x2222);
    expect(reg.livingCount).toBe(afterExtinct + 1);
    expect(reg.getRecord(7)!.extinctionTick).toBeNull();
    expect(reg.getRecord(7)!.firstSeenTick).toBe(30);
  });

  it('ignores IDs less than 0 silently', () => {
    const before = reg.livingCount;
    reg.registerVariant(-1, 0, 5, 0x0);
    expect(reg.livingCount).toBe(before);
  });

  it('ignores IDs greater than 255 silently', () => {
    const before = reg.livingCount;
    reg.registerVariant(256, 0, 5, 0x0);
    expect(reg.livingCount).toBe(before);
  });

  it('does not double-increment livingCount for an already-living ID', () => {
    reg.registerVariant(4, 0, 10, 0xAAAA);
    const afterFirst = reg.livingCount;

    // Registering the same alive ID again should not change the count.
    reg.registerVariant(4, 0, 15, 0xBBBB);
    expect(reg.livingCount).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// onCensus
// ---------------------------------------------------------------------------

describe('VariantRegistry — onCensus', () => {
  let reg: VariantRegistry;

  beforeEach(() => {
    reg = new VariantRegistry();
    reg.bootstrap();
  });

  it('updates peakPopulation when census count exceeds stored peak', () => {
    reg.onCensus(makeCensus({ 0: 500 }));
    expect(reg.getRecord(0)!.peakPopulation).toBe(500);
  });

  it('does not decrease peakPopulation when census shows fewer cells', () => {
    reg.onCensus(makeCensus({ 0: 500 }));
    reg.onCensus(makeCensus({ 0: 100 }));
    // Peak should remain at 500.
    expect(reg.getRecord(0)!.peakPopulation).toBe(500);
  });

  it('updates multiple variants in a single census', () => {
    reg.registerVariant(1, 0, 5, 0x1234);
    reg.registerVariant(2, 0, 8, 0x5678);

    reg.onCensus(makeCensus({ 0: 200, 1: 50, 2: 75 }));

    expect(reg.getRecord(0)!.peakPopulation).toBe(200);
    expect(reg.getRecord(1)!.peakPopulation).toBe(50);
    expect(reg.getRecord(2)!.peakPopulation).toBe(75);
  });

  it('silently ignores variants with no record entry', () => {
    // Variant 99 has no record — should not throw.
    expect(() => reg.onCensus(makeCensus({ 99: 1000 }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// markExtinct
// ---------------------------------------------------------------------------

describe('VariantRegistry — markExtinct', () => {
  let reg: VariantRegistry;

  beforeEach(() => {
    reg = new VariantRegistry();
    reg.bootstrap();
  });

  it('sets extinctionTick and decrements livingCount', () => {
    const before = reg.livingCount;
    reg.markExtinct(0, 99, 300);

    expect(reg.getRecord(0)!.extinctionTick).toBe(99);
    expect(reg.livingCount).toBe(before - 1);
  });

  it('updates peakPopulation if the reported peakPop is higher', () => {
    reg.onCensus(makeCensus({ 0: 100 }));
    reg.markExtinct(0, 50, 200);
    expect(reg.getRecord(0)!.peakPopulation).toBe(200);
  });

  it('does not decrease peakPopulation when reported peakPop is lower', () => {
    reg.onCensus(makeCensus({ 0: 500 }));
    reg.markExtinct(0, 50, 10);
    expect(reg.getRecord(0)!.peakPopulation).toBe(500);
  });

  it('is idempotent — double-calling does not double-decrement livingCount', () => {
    reg.markExtinct(0, 99, 100);
    const after = reg.livingCount;

    // Second call on an already-extinct variant should be a no-op.
    reg.markExtinct(0, 100, 200);
    expect(reg.livingCount).toBe(after);
  });

  it('is a no-op for an unknown variant ID', () => {
    const before = reg.livingCount;
    reg.markExtinct(42, 10, 0);
    expect(reg.livingCount).toBe(before);
  });

  it('isAlive returns false after markExtinct', () => {
    reg.markExtinct(0, 5, 0);
    expect(reg.isAlive(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// livingCount / totalCount / isAlive
// ---------------------------------------------------------------------------

describe('VariantRegistry — livingCount, totalCount, isAlive', () => {
  let reg: VariantRegistry;

  beforeEach(() => {
    reg = new VariantRegistry();
    reg.bootstrap();
  });

  it('livingCount tracks register/extinct lifecycle correctly', () => {
    expect(reg.livingCount).toBe(1); // variant 0

    reg.registerVariant(1, 0, 10, 0x1);
    expect(reg.livingCount).toBe(2);

    reg.registerVariant(2, 0, 20, 0x2);
    expect(reg.livingCount).toBe(3);

    reg.markExtinct(1, 30, 0);
    expect(reg.livingCount).toBe(2);

    reg.markExtinct(2, 40, 0);
    expect(reg.livingCount).toBe(1);

    reg.markExtinct(0, 50, 0);
    expect(reg.livingCount).toBe(0);
  });

  it('totalCount includes extinct variants', () => {
    reg.registerVariant(1, 0, 5, 0x1);
    reg.markExtinct(1, 10, 0);

    // Variant 0 (alive) + variant 1 (extinct) = 2 total.
    expect(reg.totalCount).toBe(2);
    expect(reg.livingCount).toBe(1);
  });

  it('isAlive returns false for an unregistered ID', () => {
    expect(reg.isAlive(99)).toBe(false);
  });

  it('isAlive returns true for a registered, non-extinct variant', () => {
    reg.registerVariant(5, 0, 10, 0xFFFF);
    expect(reg.isAlive(5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLivingVariants / getAllVariants
// ---------------------------------------------------------------------------

describe('VariantRegistry — getLivingVariants / getAllVariants', () => {
  let reg: VariantRegistry;

  beforeEach(() => {
    reg = new VariantRegistry();
    reg.bootstrap();
  });

  it('getLivingVariants returns only non-extinct records', () => {
    reg.registerVariant(1, 0, 5, 0x1);
    reg.registerVariant(2, 0, 10, 0x2);
    reg.markExtinct(1, 15, 0);

    const living = reg.getLivingVariants();
    const ids = living.map(r => r.id);
    expect(ids).not.toContain(1);   // extinct
    expect(ids).toContain(0);       // alive (base)
    expect(ids).toContain(2);       // alive
  });

  it('getAllVariants returns all records including extinct, sorted by firstSeenTick', () => {
    // Register in reverse tick order to verify sorting.
    reg.registerVariant(3, 0, 30, 0x3);
    reg.registerVariant(1, 0,  5, 0x1);
    reg.registerVariant(2, 0, 15, 0x2);
    reg.markExtinct(1, 20, 0);

    const all = reg.getAllVariants();
    // Should be sorted ascending by firstSeenTick.
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.firstSeenTick).toBeGreaterThanOrEqual(all[i - 1]!.firstSeenTick);
    }
    // All 4 variants (0, 1, 2, 3) should appear.
    expect(all.length).toBe(4);
    expect(all.map(r => r.id)).toContain(1);  // extinct but still listed
  });

  it('getLivingVariants returns an empty array when all variants are extinct', () => {
    reg.markExtinct(0, 10, 0);
    expect(reg.getLivingVariants()).toHaveLength(0);
  });
});
