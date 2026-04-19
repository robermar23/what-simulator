/**
 * @fileoverview Unit tests for MutationEngine.
 *
 * Scenarios covered:
 *   - computeChildGenome: no mutation when rate = 0.
 *   - computeChildGenome: always mutates when rate = 1 and stress = 0.
 *   - computeChildGenome: stays within 16-bit range [0, 0xFFFF].
 *   - computeChildGenome: stress mode triggers up to 3 bit-flips.
 *   - countBitDifferences: Hamming distance for known pairs.
 *   - countBitDifferences: identical genomes → 0 difference.
 *   - countBitDifferences: complementary genomes → 16 differences.
 *   - applyPhenotypeFromGenome: writes correct LUT values to buffers.
 *   - applyPhenotypeFromGenome: only writes to the specified index.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  computeChildGenome,
  countBitDifferences,
  applyPhenotypeFromGenome,
  assignVariantId,
} from './MutationEngine.js';
import {
  packGenome,
  getToxinResist,
  getNutrientAbs,
  getSpreadBonus,
  GENOME_NEUTRAL,
} from './GenomeEncoder.js';

// ---------------------------------------------------------------------------
// computeChildGenome
// ---------------------------------------------------------------------------

describe('MutationEngine — computeChildGenome', () => {
  it('returns parent genome unchanged when pointMutationRate = 0', () => {
    const parent = packGenome(3, 5, 2, 14);
    const child  = computeChildGenome(parent, 0.0, 0);
    expect(child).toBe(parent);
  });

  it('always flips one bit when pointMutationRate = 1 and stressLevel = 0', () => {
    // With rate=1 every call must mutate.  Run several times to confirm.
    const parent = packGenome(7, 7, 7, 7); // GENOME_NEUTRAL
    for (let i = 0; i < 20; i++) {
      const child = computeChildGenome(parent, 1.0, 0);
      // Exactly one bit flipped → Hamming distance = 1.
      expect(countBitDifferences(parent, child)).toBe(1);
    }
  });

  it('child genome stays within [0, 0xFFFF] for any parent and rate', () => {
    const candidates = [0x0000, 0xFFFF, 0x7777, 0x1234, 0xABCD];
    for (const parent of candidates) {
      const child = computeChildGenome(parent, 0.5, 0);
      expect(child).toBeGreaterThanOrEqual(0);
      expect(child).toBeLessThanOrEqual(0xFFFF);
    }
  });

  it('child genome is a valid integer (no fractional bits)', () => {
    const parent = 0x1234;
    for (let i = 0; i < 10; i++) {
      const child = computeChildGenome(parent, 0.5, 0);
      expect(Number.isInteger(child)).toBe(true);
    }
  });

  it('stress mode (stressLevel > 0) can produce up to 3 bit-flips per call', () => {
    // With stressRate = 1 (rate × 3, capped at 1) all 3 attempts fire.
    // The maximum Hamming distance in one call is 3.
    const parent     = GENOME_NEUTRAL;
    // rate = 1/3 → stressRate = min(1, 1/3 × 3) = 1 → all 3 attempts succeed.
    const stressRate = 1 / 3;
    let maxSeen = 0;
    for (let i = 0; i < 50; i++) {
      const child = computeChildGenome(parent, stressRate, 1);
      const diff  = countBitDifferences(parent, child);
      if (diff > maxSeen) maxSeen = diff;
    }
    // Over 50 trials we should observe at least 2 simultaneous flips.
    expect(maxSeen).toBeGreaterThanOrEqual(2);
  });

  it('no stress: stressLevel = 0 produces at most 1 bit-flip per call', () => {
    // With stressLevel = 0 the engine makes only one flip attempt.
    // Even with rate = 1 we can only flip one bit.
    const parent = GENOME_NEUTRAL;
    for (let i = 0; i < 30; i++) {
      const child = computeChildGenome(parent, 1.0, 0);
      expect(countBitDifferences(parent, child)).toBeLessThanOrEqual(1);
    }
  });

  it('stress rate is capped at 1.0 even when pointMutationRate × 3 > 1', () => {
    // With pointMutationRate = 0.5, stressRate = min(1, 1.5) = 1.
    // All 3 attempts must fire → each flips exactly 1 bit → Hamming ≤ 3.
    const parent = GENOME_NEUTRAL;
    for (let i = 0; i < 20; i++) {
      const child = computeChildGenome(parent, 0.5, 1);
      expect(countBitDifferences(parent, child)).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// countBitDifferences
// ---------------------------------------------------------------------------

describe('MutationEngine — countBitDifferences', () => {
  it('identical genomes have Hamming distance 0', () => {
    expect(countBitDifferences(0x7777, 0x7777)).toBe(0);
    expect(countBitDifferences(0x0000, 0x0000)).toBe(0);
    expect(countBitDifferences(0xFFFF, 0xFFFF)).toBe(0);
  });

  it('one-bit difference returns 1', () => {
    // Flip bit 0: 0x0000 vs 0x0001.
    expect(countBitDifferences(0x0000, 0x0001)).toBe(1);
    // Flip bit 15: 0x0000 vs 0x8000.
    expect(countBitDifferences(0x0000, 0x8000)).toBe(1);
  });

  it('complementary 16-bit genomes have Hamming distance 16', () => {
    // 0x0000 XOR 0xFFFF = 0xFFFF — all 16 bits differ.
    expect(countBitDifferences(0x0000, 0xFFFF)).toBe(16);
  });

  it('known multi-bit difference', () => {
    // 0b0000_0000_0000_0111 has 3 set bits → Hamming(0, 7) = 3.
    expect(countBitDifferences(0x0000, 0x0007)).toBe(3);
  });

  it('is symmetric: order of arguments does not matter', () => {
    expect(countBitDifferences(0x1234, 0xABCD))
      .toBe(countBitDifferences(0xABCD, 0x1234));
  });
});

// ---------------------------------------------------------------------------
// applyPhenotypeFromGenome
// ---------------------------------------------------------------------------

describe('MutationEngine — applyPhenotypeFromGenome', () => {
  it('writes toxinResist, nutrientAbs, heatResist, spreadBonus matching LUT', () => {
    const SIZE       = 4;
    const idx        = 2; // write to slot 2, not slot 0, to catch off-by-one
    const toxinResist = new Float32Array(SIZE);
    const nutrientAbs = new Float32Array(SIZE);
    const heatResist  = new Float32Array(SIZE);
    const spreadBonus = new Float32Array(SIZE);

    const genome = packGenome(10, 4, 12, 3); // arbitrary tiers

    applyPhenotypeFromGenome(genome, toxinResist, nutrientAbs, heatResist, spreadBonus, idx);

    expect(toxinResist[idx]).toBeCloseTo(getToxinResist(genome), 5);
    expect(nutrientAbs[idx]).toBeCloseTo(getNutrientAbs(genome), 5);
    expect(spreadBonus[idx]).toBeCloseTo(getSpreadBonus(genome), 5);
    // heatResist = toxinResist × 0.5 (Phase 9 simplification).
    expect(heatResist[idx]).toBeCloseTo(getToxinResist(genome) * 0.5, 5);
  });

  it('does not write to any index other than the specified one', () => {
    const SIZE       = 6;
    const idx        = 3;
    const toxinResist = new Float32Array(SIZE);
    const nutrientAbs = new Float32Array(SIZE);
    const heatResist  = new Float32Array(SIZE);
    const spreadBonus = new Float32Array(SIZE);

    applyPhenotypeFromGenome(GENOME_NEUTRAL, toxinResist, nutrientAbs, heatResist, spreadBonus, idx);

    // All slots other than idx must remain zero.
    for (let i = 0; i < SIZE; i++) {
      if (i === idx) continue;
      expect(toxinResist[i]).toBe(0);
      expect(nutrientAbs[i]).toBe(0);
      expect(heatResist[i]).toBe(0);
      expect(spreadBonus[i]).toBe(0);
    }
  });

  it('GENOME_NEUTRAL yields mid-range phenotype values', () => {
    const toxinResist = new Float32Array(1);
    const nutrientAbs = new Float32Array(1);
    const heatResist  = new Float32Array(1);
    const spreadBonus = new Float32Array(1);

    applyPhenotypeFromGenome(GENOME_NEUTRAL, toxinResist, nutrientAbs, heatResist, spreadBonus, 0);

    // GENOME_NEUTRAL = 0x7777 — all nibbles at tier 7 (mid-scale).
    // Exact LUT values: toxinResist ~ 0.42, nutrientAbs ~ 0.57, spreadBonus = 0.0.
    expect(toxinResist[0]).toBeGreaterThan(0.0);
    expect(toxinResist[0]).toBeLessThan(1.0);
    expect(nutrientAbs[0]).toBeGreaterThan(0.0);
    expect(nutrientAbs[0]).toBeLessThanOrEqual(1.0);
    expect(spreadBonus[0]).toBeCloseTo(0.0, 2); // tier 7 of 15 is near-zero bonus
    expect(heatResist[0]).toBeCloseTo(toxinResist[0] * 0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// assignVariantId (Phase 11)
// ---------------------------------------------------------------------------

describe('MutationEngine — assignVariantId', () => {
  // NOTE: `parentGenome` here represents the *lineage reference genome*
  // (the founding genome of the parent's variant lineage), not the
  // immediate parent cell's genome.  The engine passes _variantRefGenomes[id].

  it('returns parentId unchanged when Hamming distance < 3 (1 bit)', () => {
    const refGenome   = 0x7777;
    const childGenome = refGenome ^ 0x0001; // 1-bit difference
    expect(countBitDifferences(refGenome, childGenome)).toBe(1);
    expect(assignVariantId(5, refGenome, childGenome, 10)).toBe(5);
  });

  it('returns parentId unchanged when Hamming distance < 3 (2 bits)', () => {
    const refGenome   = 0x7777;
    const childGenome = refGenome ^ 0x0003; // 2-bit difference — still below threshold
    expect(countBitDifferences(refGenome, childGenome)).toBe(2);
    expect(assignVariantId(3, refGenome, childGenome, 20)).toBe(3);
  });

  it('returns parentId unchanged when genomes are identical (0-bit difference)', () => {
    expect(assignVariantId(4, 0x1234, 0x1234, 50)).toBe(4);
  });

  it('returns nextVariantId when Hamming distance is exactly 3', () => {
    const refGenome   = 0x7777;
    const childGenome = refGenome ^ 0x0007; // 3-bit difference — at threshold
    expect(countBitDifferences(refGenome, childGenome)).toBe(3);
    expect(assignVariantId(3, refGenome, childGenome, 20)).toBe(20);
  });

  it('returns nextVariantId when Hamming distance > 3', () => {
    const refGenome   = 0x0000;
    const childGenome = 0x00FF; // 8-bit difference
    expect(countBitDifferences(refGenome, childGenome)).toBe(8);
    expect(assignVariantId(2, refGenome, childGenome, 7)).toBe(7);
  });

  it('returns nextVariantId when genomes are maximally different (16 bits)', () => {
    expect(assignVariantId(0, 0x0000, 0xFFFF, 99)).toBe(99);
  });

  it('parentId 0 and nextVariantId 1 — creates first derived lineage', () => {
    const refGenome   = 0x7777;
    const childGenome = refGenome ^ 0x0007; // 3 bits differ — triggers speciation
    expect(assignVariantId(0, refGenome, childGenome, 1)).toBe(1);
  });

  it('returns parentId 0 when child has only 1-bit drift from neutral reference', () => {
    const refGenome   = 0x7777;
    const childGenome = refGenome ^ 0x0001; // 1-bit mutation — well below threshold
    expect(assignVariantId(0, refGenome, childGenome, 1)).toBe(0);
  });
});
