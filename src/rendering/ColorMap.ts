/**
 * @fileoverview Cell-type colour definitions and pre-computed lookup table for
 * the What Simulator renderer.
 *
 * The hot pixel-write loop in Renderer.ts calls into this module once at
 * startup to build a `Uint32Array` lookup table indexed by:
 *
 *   index = cellType * ENERGY_STEPS + energyQuantized
 *
 * where `energyQuantized = Math.floor(energy * (ENERGY_STEPS - 1))`.
 *
 * One array read per cell per frame — no conditional chains, no function
 * calls in the hot path.
 *
 * Colour layout in the Uint32 (little-endian x86/ARM, matching ImageData):
 *   byte 0 = R,  byte 1 = G,  byte 2 = B,  byte 3 = A
 *   packed = (A << 24) | (B << 16) | (G << 8) | R
 */

import { CellType } from '../simulation/GridState.js';
import { hexToRgb, packRgba, scaleBrightness } from '../utils/colorUtils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Number of discrete energy levels in the lookup table.
 * 256 gives sub-percent granularity which is invisible to the eye.
 */
export const ENERGY_STEPS = 256;

/**
 * Number of unique CellType values (0–10).
 * Keep in sync with the {@link CellType} enum.
 */
const CELL_TYPE_COUNT = 11;

// ---------------------------------------------------------------------------
// Base colours (hex strings → parsed once at build time)
// ---------------------------------------------------------------------------

/**
 * One entry per CellType (indexed by the enum value).
 * Each entry has a `base` RGBA and an optional `min` brightness multiplier for
 * cells that use energy to modulate brightness (Life, LifeVariant).
 */
interface ColorEntry {
  /** Base hex colour string for this cell type. */
  hex: string;
  /** Minimum brightness factor when energy is 0 (default 0 = invisible). */
  minBrightness: number;
  /** Whether brightness should scale with energy. */
  energyModulated: boolean;
}

/**
 * Colour table indexed by {@link CellType} ordinal value.
 * Must have exactly `CELL_TYPE_COUNT` entries in the same order as the enum.
 */
const COLOR_ENTRIES: readonly ColorEntry[] = [
  // 0 — Empty
  { hex: '#0a0a12', minBrightness: 1, energyModulated: false },
  // 1 — Life (A) — bright green, dims with low energy
  { hex: '#00ff88', minBrightness: 0.15, energyModulated: true },
  // 2 — Wall — mid-dark grey, static
  { hex: '#3a3a3a', minBrightness: 1, energyModulated: false },
  // 3 — Toxin — vivid purple
  { hex: '#cc00ff', minBrightness: 1, energyModulated: false },
  // 4 — Nutrient — saturated green (distinct from Life)
  { hex: '#00cc44', minBrightness: 1, energyModulated: false },
  // 5 — Drain — deep blue
  { hex: '#0044cc', minBrightness: 1, energyModulated: false },
  // 6 — GravityWell — warm orange
  { hex: '#ff8800', minBrightness: 1, energyModulated: false },
  // 7 — Barrier — bright yellow
  { hex: '#ffee00', minBrightness: 1, energyModulated: false },
  // 8 — Fire — red-orange
  { hex: '#ff4400', minBrightness: 1, energyModulated: false },
  // 9 — Ice — pale blue-white
  { hex: '#aaddff', minBrightness: 1, energyModulated: false },
  // 10 — LifeVariant (B) — bright yellow, dims with low energy
  { hex: '#ffdd00', minBrightness: 0.15, energyModulated: true },
];

// ---------------------------------------------------------------------------
// Lookup table builder
// ---------------------------------------------------------------------------

/**
 * Builds the flat colour lookup table (`Uint32Array`) used by the renderer.
 *
 * The table has `CELL_TYPE_COUNT * ENERGY_STEPS` entries.  For non-energy-
 * modulated cell types the entire row is a single repeated colour.  For life
 * types each row blends from dim (energy = 0) to full brightness (energy = 1).
 *
 * @returns Packed RGBA lookup table.
 */
export function buildColorLUT(): Uint32Array {
  const lut = new Uint32Array(CELL_TYPE_COUNT * ENERGY_STEPS);

  for (let typeIdx = 0; typeIdx < CELL_TYPE_COUNT; typeIdx++) {
    const entry = COLOR_ENTRIES[typeIdx];
    const base  = hexToRgb(entry.hex);

    for (let e = 0; e < ENERGY_STEPS; e++) {
      const tableIndex = typeIdx * ENERGY_STEPS + e;

      if (entry.energyModulated) {
        // Map energy step e → brightness factor in [minBrightness, 1.0].
        const energyFraction = e / (ENERGY_STEPS - 1);
        const brightness = entry.minBrightness + (1 - entry.minBrightness) * energyFraction;
        const scaled = scaleBrightness(base, brightness);
        lut[tableIndex] = packRgba(scaled.r, scaled.g, scaled.b);
      } else {
        // Static colour — same value for all energy steps.
        lut[tableIndex] = packRgba(base.r, base.g, base.b);
      }
    }
  }

  return lut;
}

// ---------------------------------------------------------------------------
// LUT access helper
// ---------------------------------------------------------------------------

/**
 * Looks up the packed RGBA colour for a given cell type and energy value.
 *
 * Prefer calling this with the pre-built LUT rather than computing colour
 * per-cell; this function exists mainly for testing and fallback use.
 *
 * @param lut - Pre-built colour lookup table from {@link buildColorLUT}.
 * @param cellType - Cell type ordinal (0–10).
 * @param energy - Energy in [0, 1].
 * @returns Packed RGBA as a 32-bit unsigned integer.
 */
export function lookupColor(
  lut: Uint32Array,
  cellType: number,
  energy: number,
): number {
  const e = Math.min(
    ENERGY_STEPS - 1,
    Math.max(0, Math.floor(energy * (ENERGY_STEPS - 1))),
  );
  return lut[cellType * ENERGY_STEPS + e];
}

/**
 * Convenience singleton — the LUT is built once on module load.
 * Renderer.ts imports this so it never rebuilds the table per frame.
 */
export const COLOR_LUT: Uint32Array = buildColorLUT();

// Re-export CellType for callers that only import from this module.
export { CellType };
