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
 * Number of unique CellType values (0–15: Round 1 types 0–10, Round 2 types 11–15).
 * Keep in sync with the {@link CellType} enum.
 */
const CELL_TYPE_COUNT = 16;

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
 *
 * Phase 5 additions:
 *   - Barrier (7): energy-modulated so it visually fades to transparent as it
 *     approaches the end of its lifetime.  minBrightness = 0 lets it vanish.
 *   - Fire (8): energy-modulated — bright orange-red when fully fuelled, dims
 *     to a dark ember colour just before burning out.
 */
const COLOR_ENTRIES: readonly ColorEntry[] = [
  // 0 — Empty — near-black void
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
  // 6 — GravityWell — warm orange glow
  { hex: '#ff8800', minBrightness: 1, energyModulated: false },
  // 7 — Barrier — bright yellow fading to invisible as lifetime runs out.
  //     minBrightness=0 so the colour fully dims when energy → 0.
  { hex: '#ffee00', minBrightness: 0, energyModulated: true },
  // 8 — Fire — red-orange ember; dims from bright flame to dark ash.
  //     minBrightness=0.1 gives a visible dark-red glow just before burnout.
  { hex: '#ff4400', minBrightness: 0.1, energyModulated: true },
  // 9 — Ice — pale blue-white, static
  { hex: '#aaddff', minBrightness: 1, energyModulated: false },
  // 10 — LifeVariant (B) — bright yellow, dims with low energy
  { hex: '#ffdd00', minBrightness: 0.15, energyModulated: true },

  // --- Round 2 additions (Phase 13) ---
  // 11 — Mutagen — pulsing magenta; energy-modulated so depleting mutagen dims
  { hex: '#ff00cc', minBrightness: 0.25, energyModulated: true },
  // 12 — RadioWaste — sickly green-yellow; permanent, never decays
  { hex: '#99ff00', minBrightness: 1,    energyModulated: false },
  // 13 — Antibiotic — white crystalline; survival check each tick
  { hex: '#f0f0f0', minBrightness: 1,    energyModulated: false },
  // 14 — Rewinder — blue-silver; shifts genome nibbles toward neutral tier 7
  { hex: '#4488ff', minBrightness: 1,    energyModulated: false },
  // 15 — Colony — warm amber honeycomb; energy-modulated as it sustains itself
  { hex: '#ffaa22', minBrightness: 0.4,  energyModulated: true },
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

// ---------------------------------------------------------------------------
// Lifecycle render mode colours (Phase 10)
// ---------------------------------------------------------------------------

/**
 * Pre-packed RGBA colours for the lifecycle render mode.
 *
 * In lifecycle mode, Life cells are coloured by their current stage rather
 * than the default energy-based green:
 *   - JUVENILE  — bright lime (#44ff88, high brightness)    → frontier cells
 *   - MATURE    — normal green (#00ff88, energy-modulated)  → main colony
 *   - SENESCENT — muted purple-pink (#cc44bb, dim)          → ageing interior
 *
 * Format: little-endian RGBA packed as `(A << 24) | (B << 16) | (G << 8) | R`.
 * Matches the format used by {@link buildColorLUT} and `Uint32Array` ImageData.
 */
export const LIFECYCLE_COLORS = {
  /** Juvenile stage: bright lime green, full brightness. */
  JUVENILE:  packRgba(0x44, 0xff, 0x88),
  /** Mature stage (at full energy): same green as the normal Life colour. */
  MATURE:    packRgba(0x00, 0xff, 0x88),
  /** Senescent stage: muted purple-pink, darker to signal ageing. */
  SENESCENT: packRgba(0xcc, 0x44, 0xbb),
} as const;

/**
 * Returns the packed RGBA colour for a Life cell in the lifecycle render mode.
 *
 * The colour encodes lifecycle stage rather than cell type:
 *   - `flags & JUVENILE`  → bright lime (young frontier cells)
 *   - `flags & SENESCENT` → purple-pink (ageing core cells)
 *   - otherwise           → energy-modulated green (mature colony)
 *
 * @param flags  - Cell flags byte from the `flags` GridBuffer.
 * @param energy - Cell energy [0, 1]; modulates mature cell brightness.
 * @returns Packed RGBA 32-bit colour.
 */
export function lifecycleColorFor(flags: number, energy: number): number {
  if (flags & LIFECYCLE_FLAG_JUVENILE) {
    // Juvenile: bright lime, slightly dimmed at very low energy.
    const e   = Math.max(0.3, energy);
    const erg = Math.round(0x44 * e);
    const eg  = Math.round(0xff * e);
    const eb  = Math.round(0x88 * e);
    return packRgba(erg, eg, eb);
  }
  if (flags & LIFECYCLE_FLAG_SENESCENT) {
    // Senescent: purple-pink, fixed dark tone.
    return LIFECYCLE_COLORS.SENESCENT;
  }
  // Mature: energy-modulated green (matches default Life colour).
  const brightness = 0.15 + 0.85 * energy;
  return packRgba(
    0,
    Math.round(0xff * brightness),
    Math.round(0x88 * brightness),
  );
}

/**
 * Bitmask values for lifecycle flags — mirrors {@link CellFlags} in GridState.
 * Duplicated here so ColorMap has no import dependency on the simulation layer.
 */
export const LIFECYCLE_FLAG_JUVENILE  = 0b0000_1000; // CellFlags.JUVENILE
export const LIFECYCLE_FLAG_SENESCENT = 0b0001_0000; // CellFlags.SENESCENT

// ---------------------------------------------------------------------------
// Variant palette (Phase 11)
// ---------------------------------------------------------------------------

/**
 * Number of distinct variant IDs supported (0–255 = 256 total).
 * Matches the `Uint8Array` storage for `variantId` per cell.
 */
export const VARIANT_COUNT = 256;

/**
 * Pre-computed 256-entry RGBA colour palette for variant lineages.
 *
 * Colours are distributed using the **golden-angle hue scheme**:
 *   - Variant 0 (base Life seed): fixed vivid green (#00ff88) — matches the
 *     existing Life cell colour so undiverged cells look identical to Phase 9.
 *   - Variants 1–255: hue = `(variantId * GOLDEN_ANGLE_DEG) % 360`, with
 *     fixed saturation = 85% and lightness = 55% (HSL).  The golden-angle
 *     step (≈ 137.508°) maximises perceptual distance between adjacent IDs,
 *     so variants that appear close in numeric ID look visually distinct.
 *
 * Each entry is packed as `(0xFF << 24) | (B << 16) | (G << 8) | R`
 * (little-endian RGBA) — the same format used by {@link buildColorLUT}.
 * Energy modulation is applied at render time, not baked into the palette.
 */
export const VARIANT_PALETTE: Uint32Array = ((): Uint32Array => {
  /**
   * Golden angle in degrees.  Each step in variantId space advances the hue
   * by ~137.508°, distributing 256 hues evenly around the colour wheel
   * without clustering.
   *
   * Derivation: 360 × (1 − 1/φ) where φ ≈ 1.618 (golden ratio).
   */
  const GOLDEN_ANGLE_DEG = 137.508;

  const palette = new Uint32Array(VARIANT_COUNT);

  for (let v = 0; v < VARIANT_COUNT; v++) {
    let r: number, g: number, b: number;

    if (v === 0) {
      // Variant 0 = base seed Life: vivid green #00ff88
      r = 0x00; g = 0xff; b = 0x88;
    } else {
      // Golden-angle HSL distribution: S=85%, L=55%
      const hue = (v * GOLDEN_ANGLE_DEG) % 360;
      const s   = 0.85;
      const l   = 0.55;
      ({ r, g, b } = hslToRgb(hue, s, l));
    }

    palette[v] = packRgba(r, g, b);
  }

  return palette;
})();

/**
 * Converts an HSL colour to integer RGB components [0, 255].
 *
 * @param h - Hue in degrees [0, 360).
 * @param s - Saturation in [0, 1].
 * @param l - Lightness in [0, 1].
 * @returns Object with `r`, `g`, `b` each in [0, 255].
 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return {
    r: Math.round(f(0)  * 255),
    g: Math.round(f(8)  * 255),
    b: Math.round(f(4)  * 255),
  };
}

/**
 * Returns the packed RGBA colour for a Life cell in `variantId` render mode.
 *
 * Looks up the cell's `variantId` in the pre-built {@link VARIANT_PALETTE} and
 * applies energy modulation so low-energy cells appear darker.
 *
 * Non-Life cells should be rendered with the standard {@link COLOR_LUT} even
 * in `variantId` mode (only Life cells carry meaningful variant lineage data).
 *
 * @param variantId - Cell's variant lineage ID (0–255).
 * @param energy    - Cell energy in [0, 1]; modulates brightness.
 * @returns Packed RGBA 32-bit colour.
 */
export function variantColorFor(variantId: number, energy: number): number {
  const base = VARIANT_PALETTE[variantId & 0xFF];

  // Extract RGB components from the packed little-endian RGBA word.
  const baseR =  base        & 0xFF;
  const baseG = (base >>  8) & 0xFF;
  const baseB = (base >> 16) & 0xFF;

  // Energy-modulate brightness: dim at low energy (min 15% brightness).
  const brightness = 0.15 + 0.85 * Math.max(0, Math.min(1, energy));
  return packRgba(
    Math.round(baseR * brightness),
    Math.round(baseG * brightness),
    Math.round(baseB * brightness),
  );
}

// ---------------------------------------------------------------------------
// Phase 12 render mode colour functions
// ---------------------------------------------------------------------------

/**
 * Returns the packed RGBA colour for a Life cell in `genome` render mode.
 *
 * Maps the 16-bit genome value to a hue in HSL space, creating a visible
 * colour gradient that shows genetic diversity across the colony.  The neutral
 * genome (0x7777) maps to the green midpoint; values below neutral shift toward
 * blue, values above shift toward yellow-red.
 *
 * @param genome - 16-bit packed genome (0x0000–0xFFFF).
 * @param energy - Cell energy in [0, 1]; modulates brightness (min 15%).
 * @returns Packed RGBA 32-bit colour.
 */
export function genomeColorFor(genome: number, energy: number): number {
  // Normalise genome to [0, 1]; neutral 0x7777 = 0.4668 ≈ 0.47 → maps to ~168° (aqua/green).
  const t          = genome / 0xFFFF;
  // Map t → hue: 0→240° (blue), 0.47→120° (green/neutral), 1→0° (red).
  const hue        = 240 - t * 240;
  const brightness = 0.15 + 0.85 * Math.max(0, Math.min(1, energy));
  const { r, g, b } = hslToRgb(hue, 0.8, 0.5 * brightness + 0.3);
  return packRgba(r, g, b);
}

/**
 * Returns the packed RGBA colour for a Life cell in `generation` render mode.
 *
 * Young lineages (low generation count) appear cool cyan-blue; old lineages
 * (high generation count) appear warm amber-orange.  Brightness is modulated
 * by energy so dying cells are darker.
 *
 * The colour saturates at `GEN_MAX` ticks; cells older than this share the
 * same warm amber colour.
 *
 * @param generation - Cell generation count (0–65535).
 * @param energy     - Cell energy in [0, 1]; modulates brightness.
 * @returns Packed RGBA 32-bit colour.
 */
export function generationColorFor(generation: number, energy: number): number {
  // Normalise generation to [0, 1]; saturate at 500 ticks for visible range.
  const GEN_MAX = 500;
  const t       = Math.min(1, generation / GEN_MAX);
  // Lerp: young → cyan (#00ccff), old → amber (#ffaa22).
  const brightness = 0.2 + 0.8 * Math.max(0, Math.min(1, energy));
  return packRgba(
    Math.round((0x00 + t * 0xFF) * brightness),
    Math.round((0xCC + t * (0xAA - 0xCC)) * brightness),
    Math.round((0xFF + t * (0x22 - 0xFF)) * brightness),
  );
}

/**
 * Returns the packed RGBA colour for a Life cell in `fitness` render mode.
 *
 * Fitness is approximated as `energy × (1 + spreadBonus)`.  High-fitness cells
 * appear vivid gold; low-fitness cells appear dark olive-green.  This mode
 * reveals which cells are currently the most reproductively capable.
 *
 * @param energy     - Cell energy in [0, 1].
 * @param spreadBonus - Per-cell spread bonus from the genome [0, ~0.3].
 * @returns Packed RGBA 32-bit colour.
 */
export function fitnessColorFor(energy: number, spreadBonus: number): number {
  // Fitness in [0, ~1.3]; clamp to [0, 1] for colour mapping.
  const fitness = Math.min(1, energy * (1 + spreadBonus));
  // Low fitness → dark olive (#334400), high fitness → vivid gold (#ffdd00).
  return packRgba(
    Math.round(0x33 + fitness * (0xFF - 0x33)),
    Math.round(0x44 + fitness * (0xDD - 0x44)),
    Math.round(0x00),
  );
}

/**
 * Returns the packed RGBA colour for a cell in `signal` render mode.
 *
 * Signal strength [0, 1] is mapped to a cyan-blue glow overlaid on the cell's
 * base colour.  Empty cells with zero signal render near-black; Colony cells
 * and their neighbours glow bright cyan, visualising the chemical signal field.
 *
 * @param signal   - Signal strength in [0, 1].
 * @param baseRgba - Standard packed RGBA colour for this cell (from COLOR_LUT).
 * @returns Packed RGBA 32-bit colour blended with signal glow.
 */
export function signalColorFor(signal: number, baseRgba: number): number {
  if (signal <= 0) return baseRgba;

  const s   = Math.min(1, signal);
  const bR  =  baseRgba        & 0xFF;
  const bG  = (baseRgba >>  8) & 0xFF;
  const bB  = (baseRgba >> 16) & 0xFF;

  // Target glow colour: vivid cyan (#00eeff).
  const gR = 0x00;
  const gG = 0xEE;
  const gB = 0xFF;

  // Lerp: low signal → base colour; high signal → cyan glow.
  return packRgba(
    Math.round(bR + s * (gR - bR)),
    Math.round(bG + s * (gG - bG)),
    Math.round(bB + s * (gB - bB)),
  );
}

// Re-export CellType for callers that only import from this module.
export { CellType };
