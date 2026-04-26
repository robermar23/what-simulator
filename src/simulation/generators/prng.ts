/**
 * @fileoverview Seeded pseudo-random number generator for deterministic
 * obstacle generation.
 *
 * Uses the mulberry32 algorithm: a fast, high-quality 32-bit PRNG that
 * produces the same sequence for the same seed across all JS engines.
 * Critical for reproducible environment presets when `deterministic: true`.
 */

/**
 * Creates a mulberry32 seeded PRNG.
 *
 * @param seed - 32-bit integer seed.  Same seed → identical sequence.
 * @returns A function that returns uniform floats in [0, 1).
 *
 * @example
 * const rng = mulberry32(42);
 * const x = rng(); // always the same value for seed 42
 */
export function mulberry32(seed: number): () => number {
  // Ensure seed is a positive 32-bit integer.
  let s = seed >>> 0;
  return function (): number {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Derives a deterministic 32-bit seed from a preset key string.
 *
 * Uses a djb2-style hash so that similar-looking preset names produce
 * very different seeds (avalanche property).
 *
 * @param key - Preset identifier string (e.g. `'coralReef'`).
 * @returns 32-bit unsigned seed value.
 */
export function seedFromKey(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash) ^ key.charCodeAt(i);
  }
  return hash >>> 0;
}
