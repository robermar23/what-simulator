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
import { hexToRgb, packRgba, scaleBrightness, linearToSrgb } from '../utils/colorUtils.js';

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
  { hex: '#0a0a12', minBrightness: 1,    energyModulated: false },
  // 1 — Life (A) — bright green, dims with low energy
  { hex: '#00ff88', minBrightness: 0.15, energyModulated: true  },
  // 2 — Wall — cold dark slate (deeper than the old mid-grey; hash noise adds stone texture)
  { hex: '#252830', minBrightness: 1,    energyModulated: false },
  // 3 — Toxin — deep violet (less neon than #cc00ff; looks viscous rather than cartoon)
  { hex: '#7700cc', minBrightness: 1,    energyModulated: false },
  // 4 — Nutrient — rich organic green (darker/warmer than pure #00cc44)
  { hex: '#1a9e50', minBrightness: 1,    energyModulated: false },
  // 5 — Drain — deep navy (suggests a pull-current vortex rather than a flat blue)
  { hex: '#0528aa', minBrightness: 1,    energyModulated: false },
  // 6 — GravityWell — deep amber (less cartoon, more like a heat lens)
  { hex: '#cc5500', minBrightness: 1,    energyModulated: false },
  // 7 — Barrier — electric lemon; fades to invisible as lifetime runs out
  { hex: '#ffdd22', minBrightness: 0,    energyModulated: true  },
  // 8 — Fire — deep ember red; dims from bright flame to dark ash
  { hex: '#dd2200', minBrightness: 0.1,  energyModulated: true  },
  // 9 — Ice — glacial crystal blue (brighter/cooler than the old pale #aaddff)
  { hex: '#b8e8ff', minBrightness: 1,    energyModulated: false },
  // 10 — LifeVariant (B) — bright gold, dims with low energy
  { hex: '#ffdd00', minBrightness: 0.15, energyModulated: true  },

  // --- Round 2 additions ---
  // 11 — Mutagen — deep magenta (less neon than #ff00cc; dims as it depletes)
  { hex: '#cc0077', minBrightness: 0.25, energyModulated: true  },
  // 12 — RadioWaste — muted bilious yellow-green (more ominous than bright #99ff00)
  { hex: '#77bb00', minBrightness: 1,    energyModulated: false },
  // 13 — Antibiotic — icy blue-white crystal (warmer than pure white; suggests crystalline drug)
  { hex: '#c8e0ff', minBrightness: 1,    energyModulated: false },
  // 14 — Rewinder — deep electric blue (more authoritative than #4488ff)
  { hex: '#1144dd', minBrightness: 1,    energyModulated: false },
  // 15 — Colony — deep honeycomb amber (richer than #ffaa22; dims when energy is low)
  { hex: '#cc8811', minBrightness: 0.4,  energyModulated: true  },
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
   * Golden angle in radians.  Each step advances the OKLab hue by ~137.508°,
   * maximising perceptual distance between adjacent variant IDs.
   *
   * Derivation: 2π × (1 − 1/φ) where φ ≈ 1.618 (golden ratio).
   */
  const GOLDEN_ANGLE_RAD = 2.399963229; // 137.508° × π/180

  /** Constant perceived lightness for all variants (OKLab L axis). */
  const L_OK = 0.72;

  /** Chroma radius in the OKLab a/b plane — controls colour saturation. */
  const C_OK = 0.12;

  const palette = new Uint32Array(VARIANT_COUNT);

  // Variant 0: base seed Life — keep the familiar vivid green #00ff88 so
  // undiverged cells look identical to previous phases.
  palette[0] = packRgba(0x00, 0xff, 0x88);

  for (let v = 1; v < VARIANT_COUNT; v++) {
    // Distribute hue around the OKLab a/b plane using the golden angle.
    // L is held constant so all 256 variants have equal perceived brightness —
    // unlike HSL where orange/yellow hues appear brighter than blue/purple.
    const hue = (v * GOLDEN_ANGLE_RAD) % (2 * Math.PI);
    const { r, g, b } = oklabToSrgb(L_OK, C_OK * Math.cos(hue), C_OK * Math.sin(hue));
    palette[v] = packRgba(r, g, b);
  }

  return palette;
})();

// ---------------------------------------------------------------------------
// OKLab colour space helpers (Phase 16b)
//
// OKLab (Björn Ottosson, 2020) is a perceptually uniform colour space where
// equal Euclidean distances correspond to equal perceived colour differences
// and the L axis truly represents lightness independent of hue.
//
// The GLSL equivalent lives in WebGLRenderer.ts (oklabToLinearRgb).
// ---------------------------------------------------------------------------

/**
 * Converts OKLab coordinates to a gamma-encoded sRGB colour (0–255 channels).
 *
 * Steps:
 *   OKLab → LMS (cube-root domain) → LMS (linear) → linear sRGB → sRGB [0,255]
 *
 * Out-of-gamut linear sRGB values are clamped to [0, 1] before encoding.
 *
 * @param L - Perceived lightness in [0, 1].
 * @param a - Green–red chroma axis (approx. −0.5 … +0.5).
 * @param b - Blue–yellow chroma axis (approx. −0.5 … +0.5).
 * @returns Gamma-encoded sRGB colour with channels in [0, 255].
 */
export function oklabToSrgb(L: number, a: number, b: number): { readonly r: number; readonly g: number; readonly b: number } {
  // Step 1: OKLab → LMS (cube-root domain)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  // Step 2: Undo cube root → LMS in linear light
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  // Step 3: LMS → linear sRGB (matrix from OKLab spec)
  const rLin =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  // Step 4: Linear sRGB → gamma-encoded sRGB [0, 255]; clamp out-of-gamut values.
  const enc = (c: number): number =>
    Math.round(linearToSrgb(Math.max(0, Math.min(1, c))) * 255);

  return { r: enc(rLin), g: enc(gLin), b: enc(bLin) };
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
 * Interpolates through OKLab so all three endpoints share equal perceived
 * lightness — unlike the previous HSL approach where yellow/orange appeared
 * brighter than blue at the same "lightness" value.
 *
 * OKLab endpoints:
 *   - genome 0x0000 → blue  L=0.55, a=−0.05, b=−0.22
 *   - genome ~0x8000 → green L=0.72, a=−0.17, b=+0.12  (neutral midpoint)
 *   - genome 0xFFFF → red   L=0.55, a=+0.18, b=+0.10
 *
 * Energy scales the L axis so low-energy cells appear darker while hue/chroma
 * are preserved — this is the perceptually correct way to dim an OKLab colour.
 *
 * @param genome - 16-bit packed genome (0x0000–0xFFFF).
 * @param energy - Cell energy in [0, 1]; modulates perceived lightness (min 15%).
 * @returns Packed RGBA 32-bit colour.
 */
export function genomeColorFor(genome: number, energy: number): number {
  const t = genome / 0xFFFF;

  // OKLab endpoints: blue ← neutral green → red
  const blueL = 0.55;  const blueA = -0.05; const blueB = -0.22;
  const midL  = 0.72;  const midA  = -0.17; const midB  =  0.12;
  const redL  = 0.55;  const redA  =  0.18; const redB  =  0.10;

  // Piecewise linear interpolation through OKLab (stays in perceptual space).
  let L: number, a: number, b: number;
  if (t < 0.5) {
    const s = t * 2;
    L = blueL + s * (midL - blueL);
    a = blueA + s * (midA - blueA);
    b = blueB + s * (midB - blueB);
  } else {
    const s = (t - 0.5) * 2;
    L = midL + s * (redL - midL);
    a = midA + s * (redA - midA);
    b = midB + s * (redB - midB);
  }

  // Scale L for energy brightness (min 15%); hue and chroma are unchanged.
  const brightness = 0.15 + 0.85 * Math.max(0, Math.min(1, energy));
  const { r, g, b: bCh } = oklabToSrgb(L * brightness, a, b);
  return packRgba(r, g, bCh);
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
