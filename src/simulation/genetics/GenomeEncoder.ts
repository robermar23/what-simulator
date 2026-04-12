/**
 * @fileoverview Genome encoding/decoding for Round 2 evolution engine.
 *
 * ## Genome Bit Layout
 *
 * The genome is a compact 16-bit unsigned integer stored in a `Uint16Array`.
 * It is divided into four 4-bit "nibbles", each encoding the **tier** (0–15)
 * of one heritable trait:
 *
 * ```
 * Bits 15–12  Bits 11–8   Bits 7–4    Bits 3–0
 * [nutrient]  [toxin]     [decay]     [spread]
 *   tier        tier        tier        tier
 *   0–15        0–15        0–15        0–15
 * ```
 *
 * 16 tiers × 4 traits = 65 536 unique genome combinations.  Each tier maps
 * to a floating-point phenotype value via the {@link GENOME_LUT} lookup table,
 * avoiding per-cell floating-point arithmetic in the hot tick loop.
 *
 * ## Phenotype Ranges
 *
 * | Trait        | Tier 0 (min) | Tier 7 (mid / neutral) | Tier 15 (max) |
 * |--------------|-------------|------------------------|---------------|
 * | spreadBonus  | −0.30       | 0.00                   | +0.40         |
 * | decayModifier| +0.008      | 0.000                  | −0.003        |
 * | toxinResist  | 0.00        | 0.40                   | 0.90          |
 * | nutrientAbs  | 0.20        | 0.60                   | 1.00          |
 *
 * A "neutral" genome is 0x7777 (all four traits at tier 7) — this is the
 * starting genome for all seeded Life cells so Round 1 behaviour is unchanged
 * until mutations accumulate.
 */

// ---------------------------------------------------------------------------
// Trait indices within GENOME_LUT
// ---------------------------------------------------------------------------

/**
 * Trait slot index within the {@link GENOME_LUT} table.
 * Each slot occupies 16 entries (one per tier).
 */
export const TRAIT_SPREAD   = 0; // nibble bits 3–0
export const TRAIT_DECAY    = 1; // nibble bits 7–4
export const TRAIT_TOXIN    = 2; // nibble bits 11–8
export const TRAIT_NUTRIENT = 3; // nibble bits 15–12

/** Number of distinct traits encoded in the genome. */
export const TRAIT_COUNT = 4;

/** Number of tier steps per trait (4-bit nibble → 0–15). */
export const TIER_COUNT = 16;

// ---------------------------------------------------------------------------
// GENOME_LUT — pre-computed phenotype lookup table
// ---------------------------------------------------------------------------

/**
 * Phenotype lookup table: `Float32Array` of length `TRAIT_COUNT * TIER_COUNT`.
 *
 * Access pattern:
 * ```ts
 * const phenotype = GENOME_LUT[traitIndex * TIER_COUNT + tier];
 * ```
 *
 * This converts a genome nibble to a phenotype value in O(1) with no
 * floating-point arithmetic — critical for the hot inner tick loop.
 *
 * Layout (indices 0–63):
 *   [0–15]  spreadBonus  tiers 0–15  (range −0.30 → +0.40)
 *   [16–31] decayModifier tiers 0–15 (range +0.008 → −0.003)
 *   [32–47] toxinResist  tiers 0–15  (range 0.00 → 0.90)
 *   [48–63] nutrientAbs  tiers 0–15  (range 0.20 → 1.00)
 */
export const GENOME_LUT: Float32Array = (() => {
  const lut = new Float32Array(TRAIT_COUNT * TIER_COUNT);

  // spreadBonus: tier 7 = 0.00 (neutral), tier 0 = −0.30, tier 15 = +0.40
  // Linear interpolation in two segments: [0..7] and [7..15].
  const spreadBase = TRAIT_SPREAD * TIER_COUNT;
  for (let t = 0; t < TIER_COUNT; t++) {
    if (t <= 7) {
      // Map [0, 7] → [−0.30, 0.00]
      lut[spreadBase + t] = -0.30 + (t / 7) * 0.30;
    } else {
      // Map [7, 15] → [0.00, +0.40]
      lut[spreadBase + t] = ((t - 7) / 8) * 0.40;
    }
  }

  // decayModifier: tier 7 = 0.00 (neutral), tier 0 = +0.008, tier 15 = −0.003
  // Positive = faster decay, negative = slower decay (survival advantage).
  const decayBase = TRAIT_DECAY * TIER_COUNT;
  for (let t = 0; t < TIER_COUNT; t++) {
    if (t <= 7) {
      // Map [0, 7] → [+0.008, 0.000]
      lut[decayBase + t] = 0.008 - (t / 7) * 0.008;
    } else {
      // Map [7, 15] → [0.000, −0.003]
      lut[decayBase + t] = -((t - 7) / 8) * 0.003;
    }
  }

  // toxinResist: tier 0 = 0.00, tier 15 = 0.90, linear.
  const toxinBase = TRAIT_TOXIN * TIER_COUNT;
  for (let t = 0; t < TIER_COUNT; t++) {
    lut[toxinBase + t] = (t / 15) * 0.90;
  }

  // nutrientAbs: tier 0 = 0.20, tier 15 = 1.00, linear.
  const nutrientBase = TRAIT_NUTRIENT * TIER_COUNT;
  for (let t = 0; t < TIER_COUNT; t++) {
    lut[nutrientBase + t] = 0.20 + (t / 15) * 0.80;
  }

  return lut;
})();

// ---------------------------------------------------------------------------
// Genome encoding / decoding helpers
// ---------------------------------------------------------------------------

/**
 * Encodes four trait tiers into a 16-bit genome integer.
 *
 * All tier values are clamped to [0, 15] before encoding.
 *
 * @param spreadTier   - Spread-rate trait tier [0, 15].
 * @param decayTier    - Decay-modifier trait tier [0, 15].
 * @param toxinTier    - Toxin-resistance trait tier [0, 15].
 * @param nutrientTier - Nutrient-absorption trait tier [0, 15].
 * @returns 16-bit genome integer.
 */
export function packGenome(
  spreadTier:   number,
  decayTier:    number,
  toxinTier:    number,
  nutrientTier: number,
): number {
  // Clamp each tier to valid nibble range [0, 15].
  const s = Math.max(0, Math.min(15, spreadTier   | 0));
  const d = Math.max(0, Math.min(15, decayTier    | 0));
  const t = Math.max(0, Math.min(15, toxinTier    | 0));
  const n = Math.max(0, Math.min(15, nutrientTier | 0));

  // Pack: spread in bits 3–0, decay in 7–4, toxin in 11–8, nutrient in 15–12.
  return (n << 12) | (t << 8) | (d << 4) | s;
}

/** Decoded genome trait tiers. */
export interface GenomeTiers {
  /** Spread-rate tier [0, 15]. Tier 7 = neutral (no bonus). */
  spreadTier:   number;
  /** Decay-modifier tier [0, 15]. Tier 7 = neutral (no extra decay). */
  decayTier:    number;
  /** Toxin-resistance tier [0, 15]. Tier 0 = no resistance. */
  toxinTier:    number;
  /** Nutrient-absorption tier [0, 15]. Tier 0 = minimum absorption. */
  nutrientTier: number;
}

/**
 * Decodes a 16-bit genome integer into its four trait tiers.
 *
 * @param genome - 16-bit genome integer from `Uint16Array`.
 * @returns {@link GenomeTiers} with the four decoded tier values.
 */
export function unpackGenome(genome: number): GenomeTiers {
  return {
    spreadTier:   (genome       ) & 0xF,  // bits 3–0
    decayTier:    (genome >>  4 ) & 0xF,  // bits 7–4
    toxinTier:    (genome >>  8 ) & 0xF,  // bits 11–8
    nutrientTier: (genome >> 12 ) & 0xF,  // bits 15–12
  };
}

/**
 * Looks up the spreadBonus phenotype for a given 16-bit genome.
 *
 * @param genome - 16-bit genome integer.
 * @returns spreadBonus in [−0.30, +0.40].
 */
export function getSpreadBonus(genome: number): number {
  return GENOME_LUT[TRAIT_SPREAD * TIER_COUNT + ((genome) & 0xF)];
}

/**
 * Looks up the decayModifier phenotype for a given 16-bit genome.
 *
 * @param genome - 16-bit genome integer.
 * @returns decayModifier in [−0.003, +0.008] (positive = faster decay).
 */
export function getDecayModifier(genome: number): number {
  return GENOME_LUT[TRAIT_DECAY * TIER_COUNT + ((genome >> 4) & 0xF)];
}

/**
 * Looks up the toxinResist phenotype for a given 16-bit genome.
 *
 * @param genome - 16-bit genome integer.
 * @returns toxinResist in [0.00, 0.90].
 */
export function getToxinResist(genome: number): number {
  return GENOME_LUT[TRAIT_TOXIN * TIER_COUNT + ((genome >> 8) & 0xF)];
}

/**
 * Looks up the nutrientAbs phenotype for a given 16-bit genome.
 *
 * @param genome - 16-bit genome integer.
 * @returns nutrientAbs in [0.20, 1.00].
 */
export function getNutrientAbs(genome: number): number {
  return GENOME_LUT[TRAIT_NUTRIENT * TIER_COUNT + ((genome >> 12) & 0xF)];
}

// ---------------------------------------------------------------------------
// Well-known genome constants
// ---------------------------------------------------------------------------

/**
 * Neutral genome: all four traits at tier 7 (mid-range / no bonus/penalty).
 * This is the starting genome for all Life cells seeded at round start.
 *
 * Packing: spread=7, decay=7, toxin=7, nutrient=7
 * Binary: 0111_0111_0111_0111 = 0x7777
 */
export const GENOME_NEUTRAL = packGenome(7, 7, 7, 7); // 0x7777

/**
 * Maximum-fitness genome: all traits at tier 15.
 * Not attainable in one step — represents evolutionary ceiling.
 */
export const GENOME_MAX = packGenome(15, 15, 15, 15); // 0xFFFF

/**
 * Minimum genome: all traits at tier 0.
 * Used as a baseline in Rewinder cell effect.
 */
export const GENOME_MIN = packGenome(0, 0, 0, 0); // 0x0000
