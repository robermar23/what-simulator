/**
 * @fileoverview Unit tests for GenomeEncoder.
 *
 * Tests cover:
 *   - packGenome / unpackGenome roundtrip fidelity.
 *   - GENOME_LUT phenotype boundary values for all four traits.
 *   - Individual phenotype helpers (getSpreadBonus, etc.).
 *   - Well-known genome constants (GENOME_NEUTRAL, GENOME_MAX, GENOME_MIN).
 *   - Clamping behaviour for out-of-range tier inputs.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  packGenome,
  unpackGenome,
  GENOME_LUT,
  GENOME_NEUTRAL,
  GENOME_MAX,
  GENOME_MIN,
  TRAIT_SPREAD,
  TRAIT_DECAY,
  TRAIT_TOXIN,
  TRAIT_NUTRIENT,
  TIER_COUNT,
  getSpreadBonus,
  getDecayModifier,
  getToxinResist,
  getNutrientAbs,
} from './GenomeEncoder.js';

// ---------------------------------------------------------------------------
// packGenome / unpackGenome roundtrip
// ---------------------------------------------------------------------------

describe('GenomeEncoder — packGenome / unpackGenome roundtrip', () => {
  it('roundtrips the neutral genome (7, 7, 7, 7)', () => {
    const g = packGenome(7, 7, 7, 7);
    const t = unpackGenome(g);
    expect(t.spreadTier).toBe(7);
    expect(t.decayTier).toBe(7);
    expect(t.toxinTier).toBe(7);
    expect(t.nutrientTier).toBe(7);
  });

  it('roundtrips minimum tiers (0, 0, 0, 0)', () => {
    const g = packGenome(0, 0, 0, 0);
    const t = unpackGenome(g);
    expect(t.spreadTier).toBe(0);
    expect(t.decayTier).toBe(0);
    expect(t.toxinTier).toBe(0);
    expect(t.nutrientTier).toBe(0);
    expect(g).toBe(GENOME_MIN);
  });

  it('roundtrips maximum tiers (15, 15, 15, 15)', () => {
    const g = packGenome(15, 15, 15, 15);
    const t = unpackGenome(g);
    expect(t.spreadTier).toBe(15);
    expect(t.decayTier).toBe(15);
    expect(t.toxinTier).toBe(15);
    expect(t.nutrientTier).toBe(15);
    expect(g).toBe(GENOME_MAX);
  });

  it('roundtrips all four traits independently', () => {
    const g = packGenome(3, 9, 1, 14);
    const t = unpackGenome(g);
    expect(t.spreadTier).toBe(3);
    expect(t.decayTier).toBe(9);
    expect(t.toxinTier).toBe(1);
    expect(t.nutrientTier).toBe(14);
  });

  it('produces a 16-bit result that fits in Uint16Array', () => {
    const g = packGenome(15, 15, 15, 15);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(0xFFFF);
  });

  it('clamps tier values above 15 to 15', () => {
    const g = packGenome(99, 99, 99, 99);
    const t = unpackGenome(g);
    expect(t.spreadTier).toBe(15);
    expect(t.decayTier).toBe(15);
    expect(t.toxinTier).toBe(15);
    expect(t.nutrientTier).toBe(15);
  });

  it('clamps negative tier values to 0', () => {
    const g = packGenome(-5, -5, -5, -5);
    const t = unpackGenome(g);
    expect(t.spreadTier).toBe(0);
    expect(t.decayTier).toBe(0);
    expect(t.toxinTier).toBe(0);
    expect(t.nutrientTier).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Well-known constants
// ---------------------------------------------------------------------------

describe('GenomeEncoder — well-known genome constants', () => {
  it('GENOME_NEUTRAL = 0x7777', () => {
    expect(GENOME_NEUTRAL).toBe(0x7777);
  });

  it('GENOME_MAX = 0xFFFF', () => {
    expect(GENOME_MAX).toBe(0xFFFF);
  });

  it('GENOME_MIN = 0x0000', () => {
    expect(GENOME_MIN).toBe(0x0000);
  });

  it('GENOME_NEUTRAL decodes to all-7 tiers', () => {
    const t = unpackGenome(GENOME_NEUTRAL);
    expect(t.spreadTier).toBe(7);
    expect(t.decayTier).toBe(7);
    expect(t.toxinTier).toBe(7);
    expect(t.nutrientTier).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// GENOME_LUT boundaries
// ---------------------------------------------------------------------------

describe('GenomeEncoder — GENOME_LUT length', () => {
  it('has exactly TRAIT_COUNT * TIER_COUNT entries', () => {
    expect(GENOME_LUT.length).toBe(4 * 16);
  });
});

describe('GenomeEncoder — spreadBonus phenotype (TRAIT_SPREAD)', () => {
  const base = TRAIT_SPREAD * TIER_COUNT;

  it('tier 0 → spreadBonus ≈ −0.30', () => {
    expect(GENOME_LUT[base + 0]).toBeCloseTo(-0.30, 5);
  });

  it('tier 7 → spreadBonus ≈ 0.00 (neutral)', () => {
    expect(GENOME_LUT[base + 7]).toBeCloseTo(0.00, 5);
  });

  it('tier 15 → spreadBonus ≈ +0.40', () => {
    expect(GENOME_LUT[base + 15]).toBeCloseTo(0.40, 5);
  });

  it('is monotonically increasing across all tiers', () => {
    for (let t = 1; t < TIER_COUNT; t++) {
      expect(GENOME_LUT[base + t]).toBeGreaterThan(GENOME_LUT[base + t - 1]);
    }
  });
});

describe('GenomeEncoder — decayModifier phenotype (TRAIT_DECAY)', () => {
  const base = TRAIT_DECAY * TIER_COUNT;

  it('tier 0 → decayModifier ≈ +0.008 (fastest decay)', () => {
    expect(GENOME_LUT[base + 0]).toBeCloseTo(0.008, 5);
  });

  it('tier 7 → decayModifier ≈ 0.000 (neutral)', () => {
    expect(GENOME_LUT[base + 7]).toBeCloseTo(0.000, 5);
  });

  it('tier 15 → decayModifier ≈ −0.003 (slowest decay)', () => {
    expect(GENOME_LUT[base + 15]).toBeCloseTo(-0.003, 5);
  });

  it('is monotonically decreasing across all tiers', () => {
    for (let t = 1; t < TIER_COUNT; t++) {
      expect(GENOME_LUT[base + t]).toBeLessThan(GENOME_LUT[base + t - 1]);
    }
  });
});

describe('GenomeEncoder — toxinResist phenotype (TRAIT_TOXIN)', () => {
  const base = TRAIT_TOXIN * TIER_COUNT;

  it('tier 0 → toxinResist = 0.00 (no resistance)', () => {
    expect(GENOME_LUT[base + 0]).toBeCloseTo(0.00, 5);
  });

  it('tier 15 → toxinResist ≈ 0.90 (high resistance)', () => {
    expect(GENOME_LUT[base + 15]).toBeCloseTo(0.90, 5);
  });

  it('is monotonically increasing across all tiers', () => {
    for (let t = 1; t < TIER_COUNT; t++) {
      expect(GENOME_LUT[base + t]).toBeGreaterThan(GENOME_LUT[base + t - 1]);
    }
  });
});

describe('GenomeEncoder — nutrientAbs phenotype (TRAIT_NUTRIENT)', () => {
  const base = TRAIT_NUTRIENT * TIER_COUNT;

  it('tier 0 → nutrientAbs ≈ 0.20 (minimum absorption)', () => {
    expect(GENOME_LUT[base + 0]).toBeCloseTo(0.20, 5);
  });

  it('tier 15 → nutrientAbs = 1.00 (maximum absorption)', () => {
    expect(GENOME_LUT[base + 15]).toBeCloseTo(1.00, 5);
  });

  it('is monotonically increasing across all tiers', () => {
    for (let t = 1; t < TIER_COUNT; t++) {
      expect(GENOME_LUT[base + t]).toBeGreaterThan(GENOME_LUT[base + t - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Individual phenotype helper functions
// ---------------------------------------------------------------------------

describe('GenomeEncoder — getSpreadBonus()', () => {
  it('returns 0.00 for GENOME_NEUTRAL (tier 7)', () => {
    expect(getSpreadBonus(GENOME_NEUTRAL)).toBeCloseTo(0.00, 5);
  });

  it('returns −0.30 for GENOME_MIN (tier 0)', () => {
    expect(getSpreadBonus(GENOME_MIN)).toBeCloseTo(-0.30, 5);
  });

  it('returns +0.40 for GENOME_MAX (tier 15)', () => {
    expect(getSpreadBonus(GENOME_MAX)).toBeCloseTo(0.40, 5);
  });
});

describe('GenomeEncoder — getDecayModifier()', () => {
  it('returns 0.00 for GENOME_NEUTRAL (tier 7)', () => {
    expect(getDecayModifier(GENOME_NEUTRAL)).toBeCloseTo(0.00, 5);
  });

  it('returns +0.008 for GENOME_MIN (tier 0)', () => {
    expect(getDecayModifier(GENOME_MIN)).toBeCloseTo(0.008, 5);
  });

  it('returns −0.003 for GENOME_MAX (tier 15)', () => {
    expect(getDecayModifier(GENOME_MAX)).toBeCloseTo(-0.003, 5);
  });
});

describe('GenomeEncoder — getToxinResist()', () => {
  it('returns 0.00 for GENOME_MIN (tier 0)', () => {
    expect(getToxinResist(GENOME_MIN)).toBeCloseTo(0.00, 5);
  });

  it('returns ~0.42 for GENOME_NEUTRAL (tier 7)', () => {
    // tier 7 of 15 linearly maps to 7/15 * 0.90 ≈ 0.42
    expect(getToxinResist(GENOME_NEUTRAL)).toBeCloseTo((7 / 15) * 0.90, 4);
  });

  it('returns 0.90 for GENOME_MAX (tier 15)', () => {
    expect(getToxinResist(GENOME_MAX)).toBeCloseTo(0.90, 5);
  });
});

describe('GenomeEncoder — getNutrientAbs()', () => {
  it('returns 0.20 for GENOME_MIN (tier 0)', () => {
    expect(getNutrientAbs(GENOME_MIN)).toBeCloseTo(0.20, 5);
  });

  it('returns 1.00 for GENOME_MAX (tier 15)', () => {
    expect(getNutrientAbs(GENOME_MAX)).toBeCloseTo(1.00, 5);
  });
});

// ---------------------------------------------------------------------------
// Bit isolation — changing one trait must not affect the others
// ---------------------------------------------------------------------------

describe('GenomeEncoder — trait bit isolation', () => {
  it('changing spread tier does not affect other traits', () => {
    const g1 = packGenome(0, 5, 10, 12);
    const g2 = packGenome(15, 5, 10, 12);
    const t1 = unpackGenome(g1);
    const t2 = unpackGenome(g2);
    expect(t1.decayTier).toBe(t2.decayTier);
    expect(t1.toxinTier).toBe(t2.toxinTier);
    expect(t1.nutrientTier).toBe(t2.nutrientTier);
  });

  it('changing nutrient tier does not affect spread tier', () => {
    const g1 = packGenome(3, 7, 7, 0);
    const g2 = packGenome(3, 7, 7, 15);
    const t1 = unpackGenome(g1);
    const t2 = unpackGenome(g2);
    expect(t1.spreadTier).toBe(t2.spreadTier);
    expect(t1.spreadTier).toBe(3);
  });
});
