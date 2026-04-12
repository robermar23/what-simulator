/**
 * @fileoverview Genome mutation engine for the Round 2 evolution system.
 *
 * ## Mutation model
 *
 * Round 2 replaces the binary "Life mutates to LifeVariant" system with a
 * continuous per-bit mutation model.  Every reproduction event (spread) runs
 * through this module to compute the child's genome from the parent's.
 *
 * ### Mutation triggers
 *
 * 1. **Spontaneous point mutation (background)**
 *    Each spread event has a configurable `pointMutationRate` probability
 *    (default 0.002) that ONE random bit in the child's 16-bit genome is
 *    flipped.  Small effect per event; large cumulative effect over generations.
 *
 * 2. **Stress-induced hypermutation**
 *    When `stressLevel > 0` (cell survived a damaging event such as toxin,
 *    fire proximity, or drain overload), up to THREE independent bit-flip
 *    attempts are made instead of one, each at three times the base rate.
 *    This implements the biological SOS response: stressed DNA becomes
 *    less stable, increasing variation.
 *
 * ### Phenotype derivation
 *
 * After computing the child genome, call {@link applyPhenotypeFromGenome}
 * to populate the four per-cell phenotype TypedArray buffers (`toxinResist`,
 * `nutrientAbs`, `heatResist`, `spreadBonus`) by looking up the genome
 * in {@link GENOME_LUT}.  This is O(1) — no heap allocation.
 *
 * ### Variant identity
 *
 * {@link countBitDifferences} returns the Hamming distance between two
 * genomes.  The caller uses this to decide whether to assign a new
 * `variantId` (threshold: ≥3 bits differ — see Phase 11 VariantRegistry).
 */

import {
  GENOME_LUT,
  getToxinResist,
  getNutrientAbs,
  getSpreadBonus,
  getDecayModifier,
} from './GenomeEncoder.js';

// Re-export helpers used by SimulationEngine to keep its import list short.
export { getToxinResist, getNutrientAbs, getSpreadBonus, getDecayModifier };

// ---------------------------------------------------------------------------
// Point mutation
// ---------------------------------------------------------------------------

/**
 * Computes a child's genome from a parent's genome, applying stochastic
 * point mutation.
 *
 * The mutation model:
 *  - **Normal mode** (`stressLevel = 0`): one bit-flip attempt at
 *    `pointMutationRate`.
 *  - **Stress mode** (`stressLevel > 0`): three independent bit-flip
 *    attempts each at `pointMutationRate × 3`.
 *
 * With default `pointMutationRate = 0.002` and no stress, approximately
 * 0.2% of spread events introduce a single genome bit-flip.  With stress,
 * up to three flips may occur in one event, enabling rapid local adaptation.
 *
 * @param parentGenome     - 16-bit genome integer of the parent cell.
 * @param pointMutationRate - Per-event probability [0, 1] of a bit flip.
 * @param stressLevel       - 0 = normal; > 0 = stressed (3× rate, 3 attempts).
 * @returns 16-bit child genome integer (`& 0xFFFF` to stay in range).
 */
export function computeChildGenome(
  parentGenome:      number,
  pointMutationRate: number,
  stressLevel:       number,
): number {
  let g = parentGenome;

  if (stressLevel > 0) {
    // Stress hypermutation: up to 3 independent flip attempts, each 3× rate.
    const stressRate = Math.min(1.0, pointMutationRate * 3);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Math.random() < stressRate) {
        const bit = (Math.random() * 16) | 0;
        g ^= (1 << bit);
      }
    }
  } else {
    // Background point mutation: one flip attempt at base rate.
    if (Math.random() < pointMutationRate) {
      const bit = (Math.random() * 16) | 0;
      g ^= (1 << bit);
    }
  }

  return g & 0xFFFF;
}

// ---------------------------------------------------------------------------
// Hamming distance
// ---------------------------------------------------------------------------

/**
 * Counts the number of bits that differ between two 16-bit genomes
 * (Hamming distance).
 *
 * Used by the caller to decide when a new `variantId` should be assigned:
 * if `countBitDifferences(parentGenome, childGenome) >= 3`, the child has
 * diverged significantly enough to start a new lineage.
 *
 * Algorithm: Brian Kernighan's bit-counting trick — O(number of set bits).
 *
 * @param genomeA - First 16-bit genome integer.
 * @param genomeB - Second 16-bit genome integer.
 * @returns Number of bits that differ [0, 16].
 */
export function countBitDifferences(genomeA: number, genomeB: number): number {
  // XOR reveals differing bits; count the 1-bits in the result.
  let xor = (genomeA ^ genomeB) & 0xFFFF;
  let count = 0;
  while (xor !== 0) {
    xor &= (xor - 1); // clear lowest set bit
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Phenotype derivation
// ---------------------------------------------------------------------------

/**
 * Writes all four per-cell phenotype values to the back buffer at `idx`,
 * derived from the given genome via {@link GENOME_LUT}.
 *
 * This is the single authoritative source for how genome maps to per-cell
 * behaviour in the hot tick loop.  Call this every time a new Life cell is
 * born (in `_trySpread`) or an existing cell's genome is modified (e.g. by
 * Rewinder or adaptive immunity in Phase 10+).
 *
 * Phenotype derivation:
 *   - `toxinResist`  = LUT[TRAIT_TOXIN    × 16 + toxinTier]   → [0.00, 0.90]
 *   - `nutrientAbs`  = LUT[TRAIT_NUTRIENT × 16 + nutrientTier] → [0.20, 1.00]
 *   - `heatResist`   = toxinResist × 0.5 (shares toxin tier, half magnitude)
 *   - `spreadBonus`  = LUT[TRAIT_SPREAD   × 16 + spreadTier]   → [−0.30, +0.40]
 *
 * Note: `heatResist` is derived from `toxinTier` as a simplification for
 * Phase 9.  A dedicated nibble will be added if genome expands to 32 bits.
 *
 * @param genome      - 16-bit genome integer (source of trait tiers).
 * @param toxinResist - Back buffer for per-cell toxin resistance [0, 0.90].
 * @param nutrientAbs - Back buffer for per-cell nutrient absorption [0.20, 1.00].
 * @param heatResist  - Back buffer for per-cell heat resistance [0, 0.45].
 * @param spreadBonus - Back buffer for per-cell spread rate delta [−0.30, +0.40].
 * @param idx         - Flat cell index to write.
 */
export function applyPhenotypeFromGenome(
  genome:      number,
  toxinResist: Float32Array,
  nutrientAbs: Float32Array,
  heatResist:  Float32Array,
  spreadBonus: Float32Array,
  idx:         number,
): void {
  const tr = getToxinResist(genome);
  toxinResist[idx] = tr;
  nutrientAbs[idx] = getNutrientAbs(genome);
  // heatResist shares the toxin nibble at half magnitude (Phase 9 simplification).
  heatResist[idx]  = tr * 0.5;
  spreadBonus[idx] = getSpreadBonus(genome);
}
