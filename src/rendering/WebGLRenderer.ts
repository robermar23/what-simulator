/**
 * @fileoverview WebGL 2 renderer for the What Simulator — Phase 7.
 *
 * Drop-in replacement for {@link Renderer} (Canvas 2D) that targets a
 * WebGL 2 context on an `OffscreenCanvas` (or `HTMLCanvasElement`).
 *
 * ## Why WebGL?
 *
 * The Canvas 2D `ImageData` path is CPU-bound: it writes every cell pixel
 * into a Uint8ClampedArray before flushing.  For a 512×512 grid at 2 px/cell
 * that is ~1 MB per frame at 60 fps.  At 1024×1024 (Phase 7) it is ~4 MB and
 * the dirty-region optimisation no longer helps because the spread touches most
 * of the grid.
 *
 * WebGL uploads the raw TypedArray buffers directly as GPU textures (~1 MB
 * for 1024×1024 cellType + energy) and the colour-mapping logic runs in a
 * fragment shader — zero CPU work per pixel.
 *
 * ## Design
 *
 * - Two GPU textures:
 *     - `u_cellType` → `R8UI`   (unsigned byte, integer sampler)
 *     - `u_energy`  → `R32F`    (32-bit float, requires EXT_color_buffer_float
 *                                 for rendering; we only sample, so it is fine)
 * - A fullscreen quad (two triangles) covers the entire canvas.
 * - The fragment shader maps `cellType + energy → RGBA` exactly matching
 *   the {@link ColorMap} colour table used by the Canvas 2D renderer.
 * - `cellSize` and `showGridLines` are passed as uniforms so the shader
 *   can replicate the multi-pixel-per-cell rendering and grid-line overlay.
 *
 * ## Interface Compatibility
 *
 * The public API mirrors `Renderer` exactly so `RenderWorker.ts` can swap
 * between the two with a single type union:
 *
 * ```ts
 * let renderer: Renderer | WebGLRenderer;
 * renderer = useWebGL ? new WebGLRenderer(canvas) : new Renderer(canvas);
 * renderer.render(buffers, w, h);
 * renderer.invalidate();
 * renderer.cellSize = 2;
 * renderer.showGridLines = false;
 * ```
 *
 * @module WebGLRenderer
 */

import { type GridBuffers } from '../simulation/GridState.js';
import { type AnyCanvas, type RendererOptions } from './Renderer.js';
import { VARIANT_PALETTE } from './ColorMap.js';
import { type WebGLBackground } from './BackgroundRenderer.js'; // Phase 16d

// ---------------------------------------------------------------------------
// GLSL source strings
// ---------------------------------------------------------------------------

/**
 * Vertex shader: draws a fullscreen quad by positioning two triangles that
 * cover clip space [-1, 1]×[-1, 1].
 *
 * The `a_position` attribute drives a unit quad via a hardcoded triangle-strip
 * (`TRIANGLE_STRIP` with 4 vertices). The varying `v_position` carries the
 * normalised device coordinate into the fragment shader so the fragment shader
 * can derive pixel position from `gl_FragCoord`.
 */
const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// XY clip-space position in [-1, 1]^2.
in vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

/**
 * Fragment shader: maps (cellType, energy[, flags, variantId, genome,
 * generation, signalStrength, renderMode]) → RGBA.
 *
 * ## Render modes (u_renderMode)
 *
 *   0 — **default**: each cell type has a fixed base colour; energy-modulated
 *       types (Life, LifeVariant, Barrier, Fire, Mutagen, Colony) blend from
 *       `minBrightness` at energy=0 to full brightness at energy=1.
 *
 *   1 — **lifecycle**: Life cells are coloured by their stage (Phase 10):
 *       - JUVENILE  (flags bit 3) → bright lime  (#44ff88)
 *       - SENESCENT (flags bit 4) → purple-pink  (#cc44bb)
 *       - Mature (neither flag)  → energy-modulated green (#00ff88)
 *       Non-Life cells render as in default mode.
 *
 *   2 — **variantId**: Life cells coloured by their lineage palette (Phase 11).
 *       Each variant ID (0–255) maps to a unique hue from the VARIANT_PALETTE
 *       golden-angle hue distribution.  Energy modulates brightness (min 15%).
 *       Non-Life cells render as in default mode.
 *
 *   3 — **genome** (Phase 12): Life cells coloured by genome value.
 *       Low genome (0x0000) → blue; neutral (0x7777) → green; high (0xFFFF) → red.
 *       Reveals genetic diversity across the colony.
 *
 *   4 — **generation** (Phase 12): Life cells coloured by generation count.
 *       Young lineages → cool cyan; old lineages → warm amber (saturates at 500).
 *
 *   5 — **fitness** (Phase 12): Life cells coloured by energy level as a proxy
 *       for fitness.  Low energy → dark olive; high energy → vivid gold.
 *
 *   6 — **signal** (Phase 12): All cells overlaid with their signalStrength value.
 *       Zero signal → base cell colour; full signal → vivid cyan (#00eeff).
 *
 * Colour values stay in sync with ColorMap.ts COLOR_ENTRIES.
 * Round 2 cell types 11–15 are included.
 */
export const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
precision highp usampler2D;

// --- Uniforms ---------------------------------------------------------------

/** Integer (R8UI) texture holding the CellType for every cell. */
uniform usampler2D u_cellType;

/** Float (R32F) texture holding the energy [0..1] for every cell. */
uniform sampler2D  u_energy;

/**
 * Integer (R8UI) texture holding the flags byte for every cell (Phase 10).
 * Bit 3 = JUVENILE, bit 4 = SENESCENT.
 */
uniform usampler2D u_flags;

/**
 * Integer (R8UI) texture holding the variantId byte for every cell (Phase 11).
 * Values 0–255 index into u_variantPalette for the cell's lineage colour.
 */
uniform usampler2D u_variantId;

/**
 * 256×1 RGBA texture — the variant colour palette (Phase 11).
 * Each texel holds the pre-computed golden-angle hue colour for one variant ID.
 * Sampled using nearest-neighbour filtering; texel x = variantId.
 */
uniform sampler2D  u_variantPalette;

/**
 * Integer (R16UI) texture holding the 16-bit genome for every cell (Phase 12).
 * Used by the genome render mode to visualise genetic diversity.
 */
uniform usampler2D u_genome;

/**
 * Integer (R16UI) texture holding the generation count per cell (Phase 12).
 * Used by the generation render mode to show lineage age.
 */
uniform usampler2D u_generation;

/**
 * Float (R32F) texture holding the signal strength per cell (Phase 12).
 * Used by the signal render mode to show the chemical signal field.
 */
uniform sampler2D u_signalStrength;

/** Pixels per cell (matches AppState.cellSize). */
uniform float u_cellSize;

/** Grid width in cells. */
uniform int u_gridWidth;

/** Grid height in cells. */
uniform int u_gridHeight;

/** Whether to composite a 1-px grid-line overlay at cell boundaries. */
uniform bool u_showGridLines;

/**
 * Active render mode:
 *   0 = default    (cellType + energy)
 *   1 = lifecycle  (Life cells coloured by JUVENILE / SENESCENT flags)
 *   2 = variantId  (Life cells coloured by lineage palette)
 *   3 = genome     (Life cells coloured by 16-bit genome value)
 *   4 = generation (Life cells coloured by generation count)
 *   5 = fitness    (Life cells coloured by energy as fitness proxy)
 *   6 = signal     (all cells overlaid with signalStrength cyan glow)
 */
uniform int u_renderMode;

/**
 * Environment colour tint blended into every Life cell colour so cells
 * visually belong to the active background environment.
 * xyz = RGB in [0, 1]; w = blend alpha in [0, 1] (0 = no tint).
 */
uniform vec4 u_envTint;

/**
 * When true the scene renders into an RGBA16F HDR framebuffer — emissive
 * cell types (Fire, Barrier, Colony, Life A) output linear values > 1.0
 * that feed the bloom extraction pass.  The composite shader applies
 * Reinhard tonemapping and sRGB encoding instead.
 * When false (default), this shader gamma-encodes the output directly.
 */
uniform bool u_hdrOutput;

/**
 * Phase 18: monotonically increasing frame counter for time-based animation
 * (membrane pulse, death breakdown).  Wraps at 2^31.
 */
uniform int u_time;

/**
 * Phase 18: sub-cell morphology detail level [0, 1].
 * 0 = flat legacy squares; 1 = full circular cell with nucleus / organelles.
 * Only active when u_cellSize >= 4.0 (sub-pixel detail is invisible below that).
 */
uniform float u_aliveDetail;

// --- Output -----------------------------------------------------------------
out vec4 outColor;

// ---------------------------------------------------------------------------
// Gamma correction — IEC 61966-2-1 sRGB transfer functions (Phase 16a)
//
// All colour math (brightness scaling, blending, mixing) must operate in
// linear light space to be perceptually correct.  The monitor expects sRGB-
// encoded values, so we:
//   1. Linearise every input colour (baseColor, palette samples, hardcoded
//      hex values) before doing any arithmetic.
//   2. Apply linearToSrgbVec() as the very last step before writing outColor.
//
// The TypeScript equivalents of these functions live in colorUtils.ts so
// the CPU-side colour code and tests stay in sync.
// ---------------------------------------------------------------------------

/**
 * Converts a single gamma-compressed sRGB channel [0,1] to linear light [0,1].
 *
 * Uses the IEC 61966-2-1 piecewise function (not a simple power curve) for
 * accuracy in the dark region where the power approximation breaks down.
 *
 * @param c - sRGB channel value in [0, 1].
 * @returns Linear light value in [0, 1].
 */
float srgbToLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

/** Applies srgbToLinear per-channel to a vec3. */
vec3 srgbToLinearVec(vec3 c) {
  return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

/**
 * Converts a single linear light channel [0,1] to gamma-compressed sRGB [0,1].
 *
 * Applied as the very last operation before writing outColor so that all
 * in-shader arithmetic stays in linear light while the display receives the
 * sRGB-encoded value it expects.
 *
 * @param c - Linear light channel value in [0, 1].
 * @returns sRGB gamma-encoded value in [0, 1].
 */
float linearToSrgb(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

/** Applies linearToSrgb per-channel to a vec3. */
vec3 linearToSrgbVec(vec3 c) {
  return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
}

// ---------------------------------------------------------------------------
// OKLab colour space — perceptually uniform conversion (Phase 16b)
//
// OKLab (Björn Ottosson, 2020): equal Euclidean distances = equal perceived
// colour differences; L is true lightness independent of hue.
//
// Returns LINEAR sRGB — no gamma encoding here; the final linearToSrgbVec()
// call at the end of main() handles the output encoding.
//
// TypeScript mirror: ColorMap.ts oklabToSrgb()
// ---------------------------------------------------------------------------

/**
 * Converts OKLab (L, a, b) to LINEAR sRGB [0, 1], clamped to gamut.
 *
 * @param L - Perceived lightness in [0, 1].
 * @param a - Green–red chroma axis (approx. −0.5 … +0.5).
 * @param b - Blue–yellow chroma axis (approx. −0.5 … +0.5).
 * @returns Linear sRGB vec3 with channels clamped to [0, 1].
 */
vec3 oklabToLinearRgb(float L, float a, float b) {
  // Step 1: OKLab → LMS (cube-root domain)
  float l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  float m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  float s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  // Step 2: Undo cube root → LMS in linear light
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;

  // Step 3: LMS → linear sRGB (OKLab spec matrix); clamp out-of-gamut values.
  return clamp(vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ), 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Colour table — must stay in sync with ColorMap.ts / COLOR_ENTRIES
// ---------------------------------------------------------------------------

/**
 * Returns the base RGB colour for a given cell type ordinal.
 * Includes Round 1 types (0–10) and Round 2 types (11–15).
 *
 * @param t - Cell type ordinal [0, 15].
 * @returns Linear RGB in [0, 1]^3.
 */
vec3 baseColor(uint t) {
  // ---- Round 1 types (0–10) — must match ColorMap.ts COLOR_ENTRIES ----------
  // 0  Empty        #0a0a12
  if (t ==  0u) return vec3(0.0392, 0.0392, 0.0706);
  // 1  Life A       #00ff88
  if (t ==  1u) return vec3(0.0,    1.0,    0.5333);
  // 2  Wall         #252830 — cold dark slate
  if (t ==  2u) return vec3(0.1451, 0.1569, 0.1882);
  // 3  Toxin        #7700cc — deep violet
  if (t ==  3u) return vec3(0.4667, 0.0,    0.8);
  // 4  Nutrient     #1a9e50 — rich organic green
  if (t ==  4u) return vec3(0.1020, 0.6196, 0.3137);
  // 5  Drain        #0528aa — deep navy
  if (t ==  5u) return vec3(0.0196, 0.1569, 0.6667);
  // 6  GravityWell  #cc5500 — deep amber
  if (t ==  6u) return vec3(0.8,    0.3333, 0.0);
  // 7  Barrier      #ffdd22 — electric lemon
  if (t ==  7u) return vec3(1.0,    0.8667, 0.1333);
  // 8  Fire         #dd2200 — deep ember red
  if (t ==  8u) return vec3(0.8667, 0.1333, 0.0);
  // 9  Ice          #b8e8ff — glacial crystal blue
  if (t ==  9u) return vec3(0.7216, 0.9098, 1.0);
  // 10 LifeVariant  #ffdd00 — bright gold
  if (t == 10u) return vec3(1.0,    0.8667, 0.0);

  // ---- Round 2 types (11–15) -----------------------------------------------
  // 11 Mutagen     #cc0077 — deep magenta
  if (t == 11u) return vec3(0.8,    0.0,    0.4667);
  // 12 RadioWaste  #77bb00 — muted bilious yellow-green
  if (t == 12u) return vec3(0.4667, 0.7333, 0.0);
  // 13 Antibiotic  #c8e0ff — icy blue-white crystal
  if (t == 13u) return vec3(0.7843, 0.8784, 1.0);
  // 14 Rewinder    #1144dd — deep electric blue
  if (t == 14u) return vec3(0.0667, 0.2667, 0.8667);
  // 15 Colony      #cc8811 — deep honeycomb amber
  if (t == 15u) return vec3(0.8,    0.5333, 0.0667);

  return vec3(0.0); // unknown type — invisible black
}

/**
 * Returns HDR-boosted linear RGB for emissive cell types when rendering to
 * the RGBA16F HDR framebuffer (u_hdrOutput = true).
 *
 * Values > 1.0 for Fire, Barrier, Colony, and Life A cause those cells to
 * exceed the display range so the bloom extraction pass captures their glow.
 * All other types fall back to the standard sRGB-linearised base colour.
 *
 * Must stay in sync with the HDR boost table in docs/PLAN3.md §Phase 16c.
 *
 * @param t - Cell type ordinal [0, 15].
 * @returns Linear RGB — channels may exceed 1.0 for emissive types.
 */
vec3 hdrBaseColor(uint t) {
  if (t ==  1u) return vec3(0.0,   1.4,   0.35);   // Life A   — vivid healthy glow
  if (t ==  7u) return vec3(1.8,   1.3,   0.04);   // Barrier  — electric lemon crackle
  if (t ==  8u) return vec3(2.0,   0.08,  0.0);    // Fire     — burning flame
  if (t == 15u) return vec3(1.2,   0.5,   0.006);  // Colony   — warm honeycomb glow
  // All other types: identical to non-HDR path.
  return srgbToLinearVec(baseColor(t));
}

/**
 * Returns the minimum brightness factor for energy-modulated cell types.
 * Non-modulated types return 1.0 so the brightness formula is always valid.
 *
 * @param t - Cell type ordinal.
 * @returns Minimum brightness in [0, 1].
 */
float minBrightness(uint t) {
  if (t ==  1u) return 0.15;   // Life A
  if (t ==  7u) return 0.0;    // Barrier (fades to invisible as lifetime expires)
  if (t ==  8u) return 0.1;    // Fire (dark ember glow just before burnout)
  if (t == 10u) return 0.15;   // Life Variant B
  if (t == 11u) return 0.25;   // Mutagen (dims as potency depletes)
  if (t == 15u) return 0.4;    // Colony (dims when starved of sacrificed energy)
  return 1.0;                  // all others: static brightness
}

/**
 * Returns true for cell types whose brightness scales with the energy value.
 *
 * @param t - Cell type ordinal.
 * @returns True if the colour should dim at low energy.
 */
bool isEnergyModulated(uint t) {
  return t == 1u || t == 7u || t == 8u || t == 10u || t == 11u || t == 15u;
}

// ---------------------------------------------------------------------------
// Obstacle material texture helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic per-cell hash — maps a 2D integer cell coordinate to a
 * pseudo-random float in [0, 1].  The value is stable every frame (no
 * time-varying parameter) so the texture never flickers.
 *
 * Based on a Murmur-style multiplicative hash seeded with a constant so that
 * the origin cell (0, 0) does not trivially hash to 0.
 *
 * @param c - Integer cell coordinate (clamped to grid bounds by the caller).
 * @returns Pseudo-random float in [0, 1].
 */
float cellHash(ivec2 c) {
  uint h = uint(c.x) * 374761393u + uint(c.y) * 668265263u + 2166136261u;
  h ^= h >> 13u;
  h *= 1540483477u;
  h ^= h >> 15u;
  return float(h & 0xFFFFu) / 65535.0;
}

/**
 * Returns the normalised position of the current fragment within its cell,
 * with (0, 0) at the top-left corner and (1, 1) at the bottom-right.
 *
 * At u_cellSize < 2.0 (1 px per cell) every fragment IS an entire cell, so
 * (0.5, 0.5) is returned — the bevel and shape offsets then evaluate to ~0,
 * which is the desired neutral (no sub-cell detail at 1 px/cell).
 *
 * @returns Normalised [0,1]^2 position within the cell.
 */
vec2 cellLocalUV() {
  if (u_cellSize < 2.0) return vec2(0.5);
  vec2 inCell = fract(gl_FragCoord.xy / u_cellSize);
  // Flip Y so (0,0) = top-left: WebGL Y=0 is at the bottom of the screen
  // but our grid's row 0 is at the top.
  return vec2(inCell.x, 1.0 - inCell.y);
}

/**
 * Per-type hash-noise magnitude for obstacle cells.
 * Returns 0.0 for life cells and empty — they have their own visual logic.
 *
 * @param t - Cell type ordinal.
 * @returns Noise scale in [0, 1]; multiply by the signed hash to get the offset.
 */
float obstacleNoiseMag(uint t) {
  if (t ==  2u) return 0.13; // Wall       — rough stone (high variation)
  if (t ==  3u) return 0.10; // Toxin      — viscous, slightly uneven
  if (t ==  4u) return 0.10; // Nutrient   — organic texture
  if (t ==  5u) return 0.10; // Drain      — turbulent
  if (t ==  6u) return 0.10; // GravityWell — heat shimmer
  if (t ==  7u) return 0.08; // Barrier    — energised field
  if (t ==  8u) return 0.10; // Fire       — flickering embers
  if (t ==  9u) return 0.05; // Ice        — clean crystal (low variation)
  if (t == 11u) return 0.12; // Mutagen    — pulsing spots
  if (t == 12u) return 0.18; // RadioWaste — highly irregular contamination
  if (t == 13u) return 0.05; // Antibiotic — uniform crystalline facets
  if (t == 14u) return 0.08; // Rewinder   — geometric shimmer
  if (t == 15u) return 0.10; // Colony     — honeycomb variation
  return 0.0;
}

// ---------------------------------------------------------------------------
// Phase 18 — Sub-cell morphology helpers
// ---------------------------------------------------------------------------

/**
 * Simple value-noise hash — maps a vec2 seed to a pseudo-random float [0, 1].
 * Used for per-cell deterministic variation (organelle jitter, membrane break).
 *
 * @param p - 2D seed value.
 * @returns Pseudo-random float in [0, 1].
 */
float hash1_morph(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

/**
 * Computes per-cell sub-cell morphology for Life cells and returns an rgba vec4.
 *
 * Called only when aliveDetail > 0.0 and cellSize >= 4.0.
 * Produces a circular cell body with membrane ring, nucleus, organelle dots,
 * energy pulse animation, division flash, and death membrane breakdown.
 *
 * baseRGB   - colour from active render mode in linear light.
 * energy    - cell energy [0, 1].
 * flags     - bitmask: JUVENILE bit 3, SENESCENT bit 4, JUST_DIVIDED bit 7.
 * genomeVal - 16-bit genome used for nucleus offset and organelle positions.
 * cellIdx   - flat index for per-cell phase stagger.
 * uv        - sub-cell UV in [0,1]^2 top-left origin.
 * Returns vec4(rgb, alpha); alpha < 1 in corners so background shows through.
 */
vec4 lifeMorphology(
  vec3  baseRGB,
  float energy,
  uint  flags,
  uint  genomeVal,
  int   cellIdx,
  vec2  uv
) {
  vec2  c     = uv - 0.5;       // centred on origin, range [-0.5, 0.5]
  float r     = length(c);
  float angle = atan(c.y, c.x); // [-π, π]

  bool isJuvenile  = (flags &  8u) != 0u;
  bool isSenescent = (flags & 16u) != 0u;
  bool justDivided = (flags & 128u) != 0u; // JUST_DIVIDED = 0x80

  // --- Energy pulse (per-cell phase stagger via golden-angle offset) ---
  float cellPhase = float(cellIdx) * 0.37;
  float pulseFreq = isJuvenile ? 2.0 : (isSenescent ? 0.4 : 1.0);
  float pulse     = 0.5 + 0.5 * sin(float(u_time) * 0.06 * pulseFreq + cellPhase);

  // --- Membrane ring ---
  // GLSL ES 3.0: smoothstep(e0,e1,x) is undefined when e0 >= e1.
  // All circle masks use the "1 - smoothstep(inner, outer, r)" form so
  // edge0 < edge1 is always guaranteed.
  float memOuter  = 0.46;
  float memInner  = 0.34;
  // Outer alpha fade: 1 inside (r < memOuter-0.025), 0 outside (r > memOuter).
  float memOuterMask = 1.0 - smoothstep(memOuter - 0.025, memOuter, r);
  // Inner alpha fade: 0 inside (r < memInner), 1 outside (r > memInner+0.025).
  float memInnerMask = smoothstep(memInner, memInner + 0.025, r);
  float memMask = memOuterMask * memInnerMask;

  // Death breakdown: membrane dissolves into arcs at low energy.
  float breakNoise = hash1_morph(vec2(angle * 1.16, float(genomeVal) * 0.00015));
  float memFade    = smoothstep(0.0, 0.25, energy) + 0.3 * breakNoise;
  memMask         *= mix(1.0, memFade, step(energy, 0.09));

  // --- Cell body (soft circle, radius pulses with energy) ---
  float bodyR    = 0.42 + 0.03 * pulse * energy;
  // 1 at centre, fades to 0 between (bodyR - 0.09) and (bodyR + 0.04).
  float bodyMask = 1.0 - smoothstep(bodyR - 0.09, bodyR + 0.04, r);

  // --- Nucleus ---
  // Position slightly off-centre, direction seeded from genome bits.
  float nox = float((genomeVal >> 12u) & 7u) / 14.0 * 0.16 - 0.08;
  float noy = float((genomeVal >>  9u) & 7u) / 14.0 * 0.16 - 0.08;
  float nR  = length(c - vec2(nox, noy));
  // Senescent nucleus is larger and slightly fragmented (two overlapping lobes).
  float nucSize = isSenescent ? 0.155 : 0.095;
  float nucMask = 1.0 - smoothstep(nucSize - 0.02, nucSize, nR);
  if (isSenescent) {
    // Second lobe offset from first — simulates nuclear envelope breakdown.
    float nR2 = length(c - vec2(nox + 0.09, noy - 0.05));
    nucMask = max(nucMask, 1.0 - smoothstep(0.05, 0.07, nR2));
  }

  // --- Organelles (3 bright dots, positions from genome nibbles) ---
  float organMask = 0.0;
  for (int oi = 0; oi < 3; oi++) {
    float ox = float((genomeVal >> uint(oi * 4))      & 15u) / 15.0 * 0.28 - 0.14;
    float oy = float((genomeVal >> uint(oi * 4 + 8))  & 15u) / 15.0 * 0.28 - 0.14;
    float oR = length(c - vec2(ox, oy));
    organMask += 1.0 - smoothstep(0.035, 0.055, oR);
  }
  organMask = min(organMask, 1.0);

  // --- Colour layers (all in linear light) ---
  // Membrane: slightly brighter ring than the cell body.
  vec3 memColour    = baseRGB * 1.55;
  // Body interior: slightly darker than the base colour.
  vec3 bodyColour   = baseRGB * 0.72;
  // Nucleus: dark reddish-brown (DNA-stain aesthetic), independent of base.
  vec3 nucColour    = srgbToLinearVec(vec3(0.20, 0.05, 0.10));
  if (isSenescent) nucColour *= 0.5; // darkened for aged cells
  // Organelles: small bright flecks matching the base hue.
  vec3 organColour  = baseRGB * 1.25;

  // Division flash: boost everything to well above display-white so bloom fires.
  float divBoost = justDivided ? 2.8 : 1.0;

  // --- Alpha: smooth circular boundary so background shows through corners ---
  // Use the outer membrane edge as the cell silhouette.
  float totalAlpha = max(bodyMask, memMask * 0.95);

  // Composite layers front-to-back (nucleus/organelles over body over membrane).
  vec3 rgb = vec3(0.0);
  rgb = mix(rgb, bodyColour,  bodyMask);
  rgb = mix(rgb, memColour,   memMask);
  rgb = mix(rgb, nucColour,   nucMask);
  rgb = mix(rgb, organColour, organMask);

  rgb *= divBoost;

  return vec4(rgb, totalAlpha);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void main() {
  // ---- Map fragment pixel → cell coordinate --------------------------------
  //
  // gl_FragCoord.xy is the centre of the current fragment in window space,
  // with (0.5, 0.5) at the bottom-left pixel.  We divide by cellSize to find
  // which cell this fragment belongs to, then flip Y because the WebGL
  // framebuffer has Y=0 at the bottom while our grid has row 0 at the top.

  ivec2 cellCoord = ivec2(gl_FragCoord.xy / u_cellSize);
  // Flip Y so row 0 is at the top of the canvas.
  cellCoord.y = u_gridHeight - 1 - cellCoord.y;

  // Clamp to grid bounds to avoid out-of-range texture reads.
  cellCoord = clamp(cellCoord, ivec2(0), ivec2(u_gridWidth - 1, u_gridHeight - 1));

  // ---- Sample simulation textures ------------------------------------------

  // texelFetch reads a single texel by integer pixel coordinates, bypassing
  // all filtering.  Pixel-perfect cell colours with no blending.
  uint  cellType = texelFetch(u_cellType, cellCoord, 0).r;
  float energy   = texelFetch(u_energy,   cellCoord, 0).r;
  uint  flags    = texelFetch(u_flags,    cellCoord, 0).r;
  uint  vid      = texelFetch(u_variantId, cellCoord, 0).r;

  // ---- Colour mapping -------------------------------------------------------

  vec3 cellRGB;

  bool isLife = (cellType == 1u || cellType == 10u);

  if (u_renderMode == 1 && isLife) {
    // ---- Lifecycle render mode (Phase 10) — Life/LifeVariant only -----------
    //
    // Colour encodes lifecycle stage derived from the flags byte:
    //   Bit 3 (0x08) = JUVENILE  → bright lime  (#44ff88)
    //   Bit 4 (0x10) = SENESCENT → purple-pink  (#cc44bb)
    //   Neither flag             → mature green  (energy-modulated #00ff88)

    bool isJuvenile  = (flags & 8u)  != 0u;
    bool isSenescent = (flags & 16u) != 0u;

    if (isJuvenile) {
      // Bright lime (#44ff88) — linearise sRGB base, then dim at low energy.
      float e = max(0.3, energy);
      cellRGB = srgbToLinearVec(vec3(0.2667, 1.0, 0.5333)) * e;
    } else if (isSenescent) {
      // Purple-pink (#cc44bb) — linearise sRGB; fixed dim tone signals ageing.
      cellRGB = srgbToLinearVec(vec3(0.8, 0.2667, 0.7333));
    } else {
      // Mature (#00ff88) — linearise sRGB base, then energy-modulate brightness.
      float brightness = 0.15 + 0.85 * clamp(energy, 0.0, 1.0);
      cellRGB = srgbToLinearVec(vec3(0.0, 1.0, 0.5333)) * brightness;
    }

  } else if (u_renderMode == 2 && isLife) {
    // ---- VariantId render mode (Phase 11) — Life/LifeVariant only ----------
    // Palette texture stores sRGB bytes; linearise before brightness multiply.
    vec3 paletteRGB = srgbToLinearVec(texelFetch(u_variantPalette, ivec2(int(vid), 0), 0).rgb);
    float brightness = 0.15 + 0.85 * clamp(energy, 0.0, 1.0);
    cellRGB = paletteRGB * brightness;

  } else if (u_renderMode == 3 && isLife) {
    // ---- Genome render mode (Phase 16b) — OKLab interpolation --------------
    // Interpolates through OKLab so all three endpoints share equal perceived
    // lightness.  Blue/green/red appear equally vivid — unlike the old sRGB
    // component lerp where yellow/green dominated perceptually.
    //
    // Endpoints (must stay in sync with ColorMap.ts genomeColorFor):
    //   genome 0x0000 → blue  OKLab(0.55, −0.05, −0.22)
    //   genome ~0x8000 → green OKLab(0.72, −0.17, +0.12)  ← neutral midpoint
    //   genome 0xFFFF → red   OKLab(0.55, +0.18, +0.10)
    uint genomeVal = texelFetch(u_genome, cellCoord, 0).r;
    float t        = float(genomeVal) / 65535.0;

    vec3 blueOk  = vec3(0.55, -0.05, -0.22);
    vec3 greenOk = vec3(0.72, -0.17,  0.12);
    vec3 redOk   = vec3(0.55,  0.18,  0.10);

    // Piecewise lerp through OKLab space.
    vec3 ok = t < 0.5
        ? mix(blueOk,  greenOk, t * 2.0)
        : mix(greenOk, redOk,   (t - 0.5) * 2.0);

    // Scale L axis for energy brightness — preserves hue and chroma.
    float bright = 0.15 + 0.85 * clamp(energy, 0.0, 1.0);
    ok.x *= bright;
    cellRGB = oklabToLinearRgb(ok.x, ok.y, ok.z);

  } else if (u_renderMode == 4 && isLife) {
    // ---- Generation render mode (Phase 12) — Life/LifeVariant only ---------
    // Young (gen=0) → cyan (#00ccff); old (gen≥500) → amber (#ffaa22).
    uint genVal = texelFetch(u_generation, cellCoord, 0).r;
    float t     = clamp(float(genVal) / 500.0, 0.0, 1.0);
    float bright = 0.2 + 0.8 * clamp(energy, 0.0, 1.0);
    // Linearise sRGB endpoints before mixing so the gradient is perceptually uniform.
    vec3 young  = srgbToLinearVec(vec3(0.0,  0.8,  1.0));    // cyan   linearised
    vec3 old    = srgbToLinearVec(vec3(1.0,  0.667, 0.133));  // amber  linearised
    cellRGB = mix(young, old, t) * bright;

  } else if (u_renderMode == 5 && isLife) {
    // ---- Fitness render mode (Phase 12) — Life/LifeVariant only ------------
    // Uses energy as a fitness proxy: low → dark olive, high → vivid gold.
    float fit = clamp(energy, 0.0, 1.0);
    // Linearise sRGB endpoints so mid-fitness cells appear at 50% perceived brightness.
    vec3 lo   = srgbToLinearVec(vec3(0.2,  0.267, 0.0));   // dark olive  linearised
    vec3 hi   = srgbToLinearVec(vec3(1.0,  0.867, 0.0));   // vivid gold  linearised
    cellRGB = mix(lo, hi, fit);

  } else if (u_renderMode == 7 && isLife) {
    // ---- Morphology render mode (Phase 18) — anatomy baseline ---------------
    // Uses a fixed bright cellular-green base so sub-cell structure is readable
    // regardless of genome or variant.  Energy still modulates brightness so
    // dying cells visibly dim.
    float bright = 0.25 + 0.75 * clamp(energy, 0.0, 1.0);
    cellRGB = srgbToLinearVec(vec3(0.0, 1.0, 0.533)) * bright; // #00ff88

  } else {
    // ---- Default render mode: cellType + energy → colour -------------------
    // In HDR mode use boosted emissive values; otherwise standard linearised sRGB.
    vec3 base = u_hdrOutput ? hdrBaseColor(cellType) : srgbToLinearVec(baseColor(cellType));
    float brightness;
    if (isEnergyModulated(cellType)) {
      float minB = minBrightness(cellType);
      brightness = minB + (1.0 - minB) * clamp(energy, 0.0, 1.0);
    } else {
      brightness = 1.0;
    }
    cellRGB = base * brightness;

    // ---- Obstacle material texture ------------------------------------------
    //
    // Applied to every non-Life, non-Empty cell to replace the flat crayon-block
    // look with something that reads as a real material.  Three additive layers:
    //
    //   1. Hash noise  — per-cell brightness variation (breaks uniform colour)
    //   2. Bevel       — top-left highlight / bottom-right shadow (3D depth)
    //   3. Shape       — type-specific radial/edge pattern (wall mortar seams,
    //                    ice specular, drain vortex, toxin pool glow, etc.)
    //
    // All effects are purely deterministic from cell position — no time uniform
    // is needed and the texture never flickers between frames.

    bool isObstacle = (cellType >= 2u && cellType != 10u);
    if (isObstacle) {
      // --- 1. Per-cell hash noise ---
      float noise = (cellHash(cellCoord) * 2.0 - 1.0) * obstacleNoiseMag(cellType);

      // --- 2. Inner-cell bevel (raised-surface illusion) ---
      // uv = (0,0) at top-left, (1,1) at bottom-right of the cell.
      // The linear diagonal (1 - x - y) is +1 at origin, -1 at far corner;
      // scaled to ±0.12 so the effect is visible but not overpowering.
      vec2  uv    = cellLocalUV();
      float bevel = (1.0 - uv.x - uv.y) * 0.12;

      // --- 3. Per-type sub-cell shaping ---
      float shape = 0.0;

      if (cellType == 2u) {
        // Wall — dark mortar seam at all four cell edges, stone texture inside.
        // smoothstep creates a thin gradient seam rather than a hard cut.
        float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
        shape = -(1.0 - smoothstep(0.0, 0.14, edge)) * 0.32;

      } else if (cellType == 3u) {
        // Toxin — viscous pool: bright centre, darkened rim (surface-tension look)
        float r = length(uv - 0.5) * 2.0;
        shape = -(r * r) * 0.20;

      } else if (cellType == 5u) {
        // Drain — vortex: dark centre (the pull), brighter turbulent rim
        float r = length(uv - 0.5) * 2.0;
        shape = (r - 0.5) * 0.20;

      } else if (cellType == 6u) {
        // GravityWell — radial heat glow: bright centre, falls off to edges
        float r = length(uv - 0.5) * 2.0;
        shape = (1.0 - r) * 0.22;

      } else if (cellType == 9u) {
        // Ice — glacial crystal: sharp specular in the top-left corner plus
        // a stronger bevel to simulate faceted ice surfaces.
        float spec = max(0.0, 1.0 - uv.x * 4.0 - uv.y * 4.0);
        shape  = spec * 0.45;
        bevel *= 1.6; // extra-strong bevel for crystalline facets

      } else if (cellType == 12u) {
        // RadioWaste — irregular hot-spots: secondary radial brightening
        // on top of the already-high hash noise, giving a "glowing contamination" look
        float r = length(uv - 0.5) * 2.0;
        shape = (1.0 - r) * 0.14;

      } else if (cellType == 13u) {
        // Antibiotic — pure crystalline facets: very strong bevel, minimal noise
        bevel *= 2.4;

      } else if (cellType == 14u) {
        // Rewinder — diagonal stripe shimmer (geometric/digital read)
        float stripe = fract((uv.x + uv.y) * 3.0);
        shape = (stripe - 0.5) * 0.10;

      } else if (cellType == 15u) {
        // Colony — warm honeycomb: glowing centre (colony hub feel)
        float r = length(uv - 0.5) * 2.0;
        shape = (1.0 - r) * 0.20;
      }

      cellRGB = clamp(cellRGB + vec3(noise + bevel + shape), 0.0, 1.0);
    }
  }

  // ---- Phase 18: Sub-cell morphology (Life cells, aliveDetail > 0, cellSize >= 4) ----
  //
  // Replaces the flat coloured-square look with circular cells that have an
  // outer membrane ring, soft body, nucleus, organelle dots, pulse animation,
  // division flash, and a breaking membrane when energy is low.
  //
  // The morphology result has per-fragment alpha < 1 in the cell corners, so
  // when u_hdrOutput is true the background composites through the gaps,
  // giving colonies the "cells on a slide" look.
  float alpha = (u_hdrOutput && cellType == 0u) ? 0.0 : 1.0;

  if (u_aliveDetail > 0.0 && u_cellSize >= 4.0 && isLife) {
    uint genomeVal = texelFetch(u_genome, cellCoord, 0).r;
    int  cellIdx   = cellCoord.y * u_gridWidth + cellCoord.x;
    vec2 morphUV   = cellLocalUV();

    vec4 morph = lifeMorphology(cellRGB, energy, flags, genomeVal, cellIdx, morphUV);

    // Blend flat colour → full morphology by aliveDetail amount.
    cellRGB = mix(cellRGB, morph.rgb / max(morph.a, 0.001), u_aliveDetail);

    // In HDR mode: override alpha so cell corners are transparent.
    if (u_hdrOutput) {
      alpha = mix(1.0, morph.a, u_aliveDetail);
    }
  }

  // ---- Phase 18: Extracellular matrix on empty cells (non-HDR only) ----------
  //
  // Adds a barely-visible fibrous texture to empty cells so the empty space
  // reads as biological gel rather than void.  Not needed in HDR mode because
  // the background shader provides richer visuals behind transparent cells.
  if (cellType == 0u && !u_hdrOutput && u_aliveDetail > 0.5) {
    vec2  mUV   = cellLocalUV();
    // Two-axis crosshatch using the existing hash utility, time-drifted slowly.
    float drift = float(u_time) * 0.0004;
    float fx    = hash1_morph(vec2(mUV.x * 5.0 + drift, mUV.y * 3.0));
    float fy    = hash1_morph(vec2(mUV.x * 3.0, mUV.y * 5.0 + drift));
    float mat   = (fx + fy) * 0.5 * 0.06 * u_aliveDetail;
    // Very faint cool green-grey — extracellular medium colour.
    cellRGB = srgbToLinearVec(vec3(0.039, 0.047, 0.039)) + vec3(mat);
  }

  // ---- Signal overlay (Phase 12) — applied in signal render mode ------------
  // Blends the cell's computed colour with vivid cyan (#00eeff) proportional
  // to the cell's signalStrength.  This reveals Colony chemical signal fields.
  if (u_renderMode == 6) {
    float sig = texelFetch(u_signalStrength, cellCoord, 0).r;
    sig = clamp(sig, 0.0, 1.0);
    vec3 cyanGlow = srgbToLinearVec(vec3(0.0, 0.933, 1.0)); // #00eeff linearised
    cellRGB = mix(cellRGB, cyanGlow, sig);
  }

  // ---- Grid-line overlay (Phase 6 feature, replicated in WebGL) -------------
  //
  // Draw a subtle white overlay at cell boundaries.  The boundary is defined
  // as the first pixel of each cell (sub-pixel fraction < 1/cellSize).

  if (u_showGridLines && u_cellSize >= 2.0) {
    vec2 inCell = fract(gl_FragCoord.xy / u_cellSize);
    // 0.08 sRGB white ≈ 0.006 in linear light; convert so the overlay
    // is added in the same space as cellRGB (which is now linear).
    float gridAlpha = srgbToLinear(0.08);
    if (inCell.x < (1.0 / u_cellSize) || inCell.y < (1.0 / u_cellSize)) {
      cellRGB = cellRGB + vec3(gridAlpha);
    }
  }

  // Environment tint — blend cell colour toward the background palette colour.
  // u_envTint.a = 0 means no tint; this branch is free when no background active.
  // u_envTint.rgb carries normalised sRGB values (0–1); linearise before mixing
  // so the blend operates in linear light alongside the rest of cellRGB.
  if (u_envTint.a > 0.0) {
    vec3 tintLinear = srgbToLinearVec(u_envTint.rgb);
    cellRGB = mix(cellRGB, tintLinear, u_envTint.a);
  }

  // When u_hdrOutput is true (scene pass targeting an RGBA16F FBO), emit raw
  // linear values so the composite shader can tonemap HDR → LDR.  Empty cells
  // are output as fully transparent (alpha 0) so the background texture shows
  // through during the composite pass.  In direct mode apply sRGB encoding.
  outColor = u_hdrOutput
      ? vec4(cellRGB, alpha)
      : vec4(linearToSrgbVec(clamp(cellRGB, 0.0, 1.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Post-processing shader sources (Phase 16c — HDR bloom pipeline)
// ---------------------------------------------------------------------------

/**
 * Passthrough vertex shader used by all post-processing passes.
 * @internal Exported for shader-content assertions in unit tests.
 * Converts the clip-space quad position to normalised UV coordinates [0, 1]
 * that the fragment shaders use to sample the source texture.
 */
export const PP_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_texCoord;

void main() {
  // Clip space [-1,1] → UV [0,1].
  v_texCoord  = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

/**
 * Bloom extraction pass (Pass 2).
 *
 * Samples the HDR scene texture.  For each fragment, computes the luminance
 * and extracts only the portion above the configurable threshold.
 * Pixels below the threshold are zeroed — only bright emissive cells
 * (Fire, Barrier, Colony, Life A at high energy) survive and spread.
 *
 * Runs at half the scene resolution to keep blur passes cheap.
 */
export const BLOOM_EXTRACT_FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

/** HDR scene texture from Pass 1. */
uniform sampler2D u_scene;

/**
 * Luminance threshold [0, 1].  Pixels whose perceived brightness exceeds
 * this value contribute to bloom.  Default: 0.85.
 */
uniform float u_threshold;

in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec3  color = texture(u_scene, v_texCoord).rgb;
  // Perceptual luminance (ITU-R BT.709 coefficients).
  float luma  = dot(color, vec3(0.2126, 0.7152, 0.0722));
  // Only the above-threshold portion drives bloom; below-threshold → black.
  float contrib = max(0.0, luma - u_threshold);
  outColor = vec4(color * contrib, 1.0);
}
`;

/**
 * Separable 9-tap Gaussian blur pass (Passes 3 and 4).
 *
 * Applied twice — once horizontal, once vertical — to achieve a full 2-D
 * Gaussian without the O(n²) cost of a 2-D kernel.
 *
 * Kernel weights follow a Gaussian with σ ≈ 1.5 and are normalised to
 * sum ≈ 1.0 across the 9 taps:
 *   centre (×1): 0.227027
 *   ±1 (×2):     0.194595
 *   ±2 (×2):     0.121622
 *   ±3 (×2):     0.054054
 *   ±4 (×2):     0.016216
 */
export const BLOOM_BLUR_FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

/** Texture to blur (extract result on Pass 3; H-blur result on Pass 4). */
uniform sampler2D u_source;

/** True = horizontal pass; false = vertical pass. */
uniform bool u_horizontal;

in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  // Gaussian weights for the 9-tap kernel (centre + 4 symmetrical pairs).
  const float WEIGHTS[5] = float[](0.227027, 0.194595, 0.121622, 0.054054, 0.016216);

  // Per-texel offset in UV space (one texel in the blur direction).
  vec2 texOffset = 1.0 / vec2(textureSize(u_source, 0));

  // Accumulate weighted samples from the source.
  vec3 result = texture(u_source, v_texCoord).rgb * WEIGHTS[0];
  for (int i = 1; i < 5; ++i) {
    vec2 off = u_horizontal
        ? vec2(texOffset.x * float(i), 0.0)
        : vec2(0.0, texOffset.y * float(i));
    result += texture(u_source, v_texCoord + off).rgb * WEIGHTS[i];
    result += texture(u_source, v_texCoord - off).rgb * WEIGHTS[i];
  }
  outColor = vec4(result, 1.0);
}
`;

/**
 * Composite + tonemap pass (Pass 5).
 *
 * Additively blends the full-resolution HDR scene with the half-resolution
 * blurred bloom texture, then applies Reinhard extended tonemapping to map
 * HDR linear values to the [0, 1] display range, and finally sRGB-encodes
 * the output for the 8-bit display framebuffer.
 *
 * Reinhard extended formula: c * (1 + c/w²) / (1 + c)
 * where w = whitePoint = 4.0  (HDR values at 4× display-white → near-white).
 *
 * The sRGB transfer functions are duplicated here (not shared from the scene
 * shader) because this is a separate GLSL programme that cannot inherit from
 * the scene FRAG_SRC source string.
 */
export const COMPOSITE_FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

/** Full-resolution HDR scene texture from Pass 1 (RGBA — alpha 0 = empty cell). */
uniform sampler2D u_scene;

/** Half-resolution blurred bloom texture from Pass 4. */
uniform sampler2D u_bloom;

/**
 * Bloom additive blend strength [0, 1].
 * 0 = no bloom; 1 = bloom at full computed intensity.  Default: 0.6.
 */
uniform float u_bloomStrength;

/**
 * Pre-rendered background texture (RGBA16F, linear sRGB).
 * Only sampled when u_hasBackground is true.
 */
uniform sampler2D u_background;

/**
 * True when a WebGL background has been rendered for this frame.
 * When false, empty cells show as the plain dark background colour.
 */
uniform bool u_hasBackground;

in  vec2 v_texCoord;
out vec4 outColor;

float linearToSrgb(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 linearToSrgbVec(vec3 c) {
  return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
}

/**
 * Reinhard extended tonemapping — maps HDR [0, ∞) to [0, 1] without hue shift.
 * whitePoint = 4.0: a value at 4× display-white maps to ~0.94 (near-white).
 *
 * @param c - Linear HDR colour triple (channels may exceed 1.0).
 * @returns LDR colour in [0, 1]^3.
 */
vec3 reinhardExtended(vec3 c) {
  const float whitePoint = 4.0;
  return c * (1.0 + c / (whitePoint * whitePoint)) / (1.0 + c);
}

void main() {
  vec4  sceneRGBA = texture(u_scene, v_texCoord);
  vec3  bloom     = texture(u_bloom, v_texCoord).rgb * u_bloomStrength;

  // Composite background behind the scene using scene alpha.
  // Empty cells (alpha = 0) fully reveal the background;
  // non-empty cells (alpha = 1) fully occlude it.
  vec3 base = sceneRGBA.rgb;
  if (u_hasBackground) {
    vec3 bg = texture(u_background, v_texCoord).rgb;
    base    = mix(bg, sceneRGBA.rgb, sceneRGBA.a);
  }

  vec3 hdr = base + bloom;
  vec3 ldr = reinhardExtended(hdr);
  outColor = vec4(linearToSrgbVec(clamp(ldr, 0.0, 1.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Fullscreen quad geometry
// ---------------------------------------------------------------------------

/**
 * Triangle-strip vertices for a fullscreen quad in clip space.
 * Order: top-left, bottom-left, top-right, bottom-right.
 * Two triangles cover the entire [-1, 1]×[-1, 1] clip-space square.
 */
const QUAD_VERTS = new Float32Array([
  -1,  1,   // top-left
  -1, -1,   // bottom-left
   1,  1,   // top-right
   1, -1,   // bottom-right
]);

// ---------------------------------------------------------------------------
// WebGLRenderer class
// ---------------------------------------------------------------------------

/**
 * WebGL 2–based renderer for the What Simulator.
 *
 * Matches the public API of {@link Renderer} so `RenderWorker` can treat both
 * interchangeably via the union type `Renderer | WebGLRenderer`.
 *
 * @example
 * ```ts
 * // In a Web Worker with an OffscreenCanvas:
 * const renderer = new WebGLRenderer(offscreenCanvas, { cellSize: 2 });
 * renderer.render(sabViews[frontIdx], gridWidth, gridHeight);
 * ```
 */
export class WebGLRenderer {
  /** Target canvas (`HTMLCanvasElement` or `OffscreenCanvas`). */
  private readonly _canvas: AnyCanvas;

  /** WebGL 2 rendering context. */
  private readonly _gl: WebGL2RenderingContext;

  /** Compiled + linked GLSL programme. */
  private readonly _program: WebGLProgram;

  /** Vertex buffer object holding the fullscreen quad. */
  private readonly _vbo: WebGLBuffer;

  /** Vertex array object. */
  private readonly _vao: WebGLVertexArrayObject;

  // --- GPU textures ----------------------------------------------------------

  /** `R8UI` texture — one byte per cell, holds the CellType ordinal. */
  private readonly _cellTypeTex: WebGLTexture;

  /** `R32F` texture — one float per cell, holds the energy value. */
  private readonly _energyTex: WebGLTexture;

  /**
   * `R8UI` texture — one byte per cell, holds the flags bitmask (Phase 10).
   * Used by the lifecycle render mode to detect JUVENILE / SENESCENT cells.
   */
  private readonly _flagsTex: WebGLTexture;

  /**
   * `R8UI` texture — one byte per cell, holds the variantId (Phase 11).
   * Used by the variantId render mode to look up the lineage palette colour.
   */
  private readonly _variantIdTex: WebGLTexture;

  /**
   * `RGBA8` 256×1 texture holding the pre-computed variant colour palette.
   * Uploaded once at construction from `VARIANT_PALETTE` (Phase 11).
   * Never changes during a simulation run (palette is static).
   */
  private readonly _variantPaletteTex: WebGLTexture;

  /**
   * `R16UI` texture — one 16-bit uint per cell, holds the genome (Phase 12).
   * Used by the genome render mode to map genetic value to colour.
   */
  private readonly _genomeTex: WebGLTexture;

  /**
   * `R16UI` texture — one 16-bit uint per cell, holds the generation count (Phase 12).
   * Used by the generation render mode to show lineage age.
   */
  private readonly _generationTex: WebGLTexture;

  /**
   * `R32F` texture — one float per cell, holds the signal strength (Phase 12).
   * Used by the signal render mode to show the chemical signal field.
   */
  private readonly _signalStrengthTex: WebGLTexture;

  // --- Uniform locations (cached once after compile) -------------------------

  private readonly _uCellType!: WebGLUniformLocation;
  private readonly _uEnergy!: WebGLUniformLocation;
  /** Uniform location for the flags texture (Phase 10). */
  private readonly _uFlags!: WebGLUniformLocation;
  /** Uniform location for the variantId texture (Phase 11). */
  private readonly _uVariantId!: WebGLUniformLocation;
  /** Uniform location for the variant palette texture (Phase 11). */
  private readonly _uVariantPalette!: WebGLUniformLocation;
  /** Uniform location for the genome texture (Phase 12). */
  private readonly _uGenome!: WebGLUniformLocation;
  /** Uniform location for the generation texture (Phase 12). */
  private readonly _uGeneration!: WebGLUniformLocation;
  /** Uniform location for the signal strength texture (Phase 12). */
  private readonly _uSignalStrength!: WebGLUniformLocation;
  private readonly _uCellSize!: WebGLUniformLocation;
  private readonly _uGridWidth!: WebGLUniformLocation;
  private readonly _uGridHeight!: WebGLUniformLocation;
  private readonly _uShowGridLines!: WebGLUniformLocation;
  /** Uniform location for the render mode integer (Phase 10/11/12). */
  private readonly _uRenderMode!: WebGLUniformLocation;
  private readonly _uEnvTint!:    WebGLUniformLocation;
  /** Uniform location for the HDR output flag (Phase 16c). */
  private readonly _uHdrOutput!:  WebGLUniformLocation;
  /** Phase 18: frame counter uniform — drives pulse/flash animations in GLSL. */
  private readonly _uTime!: WebGLUniformLocation;
  /** Phase 18: morphology detail level uniform [0,1]. */
  private readonly _uAliveDetail!: WebGLUniformLocation;

  /**
   * Phase 18: morphology detail level [0, 1].
   * 0 = flat squares, 1 = full circular cell anatomy.
   * Only has visual effect when cellSize >= 4px.
   */
  private _aliveDetail = 1.0;

  /** Current environment tint `[r, g, b, alpha]` — r/g/b normalised to [0,1]. */
  private _envTintVec: readonly [number, number, number, number] = [0, 0, 0, 0];

  // --- Phase 16c HDR bloom pipeline ------------------------------------------

  /**
   * True when `EXT_color_buffer_float` is available and the 5-pass HDR bloom
   * pipeline has been initialised.  False = direct 8-bit render path.
   */
  private _bloomEnabled  = false;

  /** Luminance threshold above which pixels contribute to bloom [0, 1]. */
  private _bloomThreshold = 0.85;

  /** Bloom additive blend strength [0, 1]. */
  private _bloomStrength  = 0.6;

  // HDR scene texture + FBO (full resolution, RGBA16F).
  private _hdrTex:          WebGLTexture       | null = null;
  private _hdrFbo:          WebGLFramebuffer   | null = null;

  // Half-resolution bloom extraction + Gaussian blur textures and FBOs.
  private _bloomExtractTex: WebGLTexture       | null = null;
  private _bloomExtractFbo: WebGLFramebuffer   | null = null;
  private _bloomBlurHTex:   WebGLTexture       | null = null;
  private _bloomBlurHFbo:   WebGLFramebuffer   | null = null;
  private _bloomBlurVTex:   WebGLTexture       | null = null;
  private _bloomBlurVFbo:   WebGLFramebuffer   | null = null;

  // Post-processing shader programs (null when bloom is unsupported).
  private _bloomExtractProg: WebGLProgram      | null = null;
  private _bloomBlurProg:    WebGLProgram      | null = null;
  private _compositeProg:    WebGLProgram      | null = null;

  /** VAO for the post-processing passes (reuses `_vbo`, separate PP program). */
  private _ppVao: WebGLVertexArrayObject | null = null;

  // Uniform locations for the post-processing programs (null when unsupported).
  private _uExtractScene:      WebGLUniformLocation | null = null;
  private _uExtractThreshold:  WebGLUniformLocation | null = null;
  private _uBlurSource:        WebGLUniformLocation | null = null;
  private _uBlurHorizontal:    WebGLUniformLocation | null = null;
  private _uCompositeScene:    WebGLUniformLocation | null = null;
  private _uCompositeBloom:    WebGLUniformLocation | null = null;
  private _uCompositeStrength: WebGLUniformLocation | null = null;

  // --- Phase 16d WebGL background -------------------------------------------

  /**
   * Current WebGL background instance (null = no background).
   * Renders into `_bgFbo` once per frame before the composite pass.
   */
  private _webGLBackground: WebGLBackground | null = null;

  /** Monotonically increasing frame counter passed to background.render(). */
  private _frame = 0;

  /** RGBA16F texture the background renders into each frame. */
  private _bgTex: WebGLTexture | null = null;

  /** Framebuffer wrapping `_bgTex` as its colour attachment. */
  private _bgFbo: WebGLFramebuffer | null = null;

  /** Composite shader uniform location for the background sampler. */
  private _uCompositeBg: WebGLUniformLocation | null = null;

  /** Composite shader uniform location for the u_hasBackground bool. */
  private _uCompositeHasBg: WebGLUniformLocation | null = null;

  // --- State -----------------------------------------------------------------

  /** Pixels per cell. */
  private _cellSize: number;

  /** Whether to composite the 1-px grid-line overlay. */
  private _showGridLines: boolean;

  /**
   * Current render mode.
   *   0 = default (cellType + energy)
   *   1 = lifecycle (Life cells coloured by JUVENILE/SENESCENT flags)
   *
   * Phase 10 — change via the `renderMode` setter so the uniform is updated.
   */
  private _renderMode = 0;

  /** Grid width in cells — tracked to detect resize. */
  private _gridWidth  = 0;

  /** Grid height in cells — tracked to detect resize. */
  private _gridHeight = 0;

  /**
   * Maximum safe canvas dimension in pixels.
   * Capped at 4096 regardless of GL MAX_TEXTURE_SIZE so the bloom pipeline
   * stays within budget at any cell-size zoom level.  Queried once at
   * construction time.
   */
  private _maxTexDim = 4096;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Constructs a WebGL 2 renderer targeting `canvas`.
   *
   * @param canvas  - `HTMLCanvasElement` or `OffscreenCanvas` to render into.
   * @param options - Optional rendering configuration (cellSize, showGridLines).
   * @throws If the browser does not support WebGL 2.
   */
  constructor(canvas: AnyCanvas, options: RendererOptions = {}) {
    this._canvas        = canvas;
    this._cellSize      = options.cellSize      ?? 2;
    this._showGridLines = options.showGridLines ?? false;

    // Acquire a WebGL 2 context.  WebGL 2 is required for:
    //   - R8UI (unsigned integer texture format)
    //   - R32F  (32-bit float texture without extension)
    //   - texelFetch in GLSL 3.00 es
    //   - Vertex Array Objects (core, not extension)
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl === null) {
      throw new Error(
        'WebGLRenderer: WebGL 2 is not available in this environment. ' +
        'Fall back to Canvas 2D renderer.',
      );
    }
    this._gl = gl;

    // Query the GPU's maximum texture dimension and cap it at 4096.
    // Running the HDR bloom pipeline at sizes beyond 4096px costs 16×+ the
    // fragment work of a 1024px canvas and causes frame-rate collapse.
    this._maxTexDim = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      4096,
    );

    // Disable premultiplied alpha — our colours are already straight RGBA.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    // --- Compile shaders and link programme -----------------------------------
    this._program = this._createProgram(VERT_SRC, FRAG_SRC);

    // Cache all uniform locations once (avoids a string lookup per frame).
    this._uCellType        = this._requireUniform('u_cellType');
    this._uEnergy          = this._requireUniform('u_energy');
    this._uFlags           = this._requireUniform('u_flags');
    this._uVariantId       = this._requireUniform('u_variantId');
    this._uVariantPalette  = this._requireUniform('u_variantPalette');
    this._uGenome          = this._requireUniform('u_genome');
    this._uGeneration      = this._requireUniform('u_generation');
    this._uSignalStrength  = this._requireUniform('u_signalStrength');
    this._uCellSize        = this._requireUniform('u_cellSize');
    this._uGridWidth       = this._requireUniform('u_gridWidth');
    this._uGridHeight      = this._requireUniform('u_gridHeight');
    this._uShowGridLines   = this._requireUniform('u_showGridLines');
    this._uRenderMode      = this._requireUniform('u_renderMode');
    this._uEnvTint         = this._requireUniform('u_envTint');
    this._uHdrOutput       = this._requireUniform('u_hdrOutput');
    this._uTime            = this._requireUniform('u_time');
    this._uAliveDetail     = this._requireUniform('u_aliveDetail');

    // --- Fullscreen quad geometry ---------------------------------------------
    // _vbo MUST be created before the HDR block below, because _createPPVao()
    // (called inside that block) binds this._vbo to configure the PP VAO's
    // vertex attribute.  If _vbo were created after, _createPPVao() would bind
    // null and the PP VAO would have no vertex data → all bloom passes silent.
    this._vbo = this._createQuadBuffer();
    this._vao = this._createVAO(this._vbo);

    // --- HDR bloom pipeline (Phase 16c) --------------------------------------
    //
    // RGBA16F framebuffer attachments require EXT_color_buffer_float in WebGL 2.
    // Desktop GPUs support it universally; some mobile browsers do not.
    // If unavailable, _bloomEnabled stays false and we render directly.
    const hdrExt = gl.getExtension('EXT_color_buffer_float');
    if (hdrExt !== null) {
      this._bloomEnabled = true;

      // Compile the three post-processing programs.
      this._bloomExtractProg = this._createProgram(PP_VERT_SRC, BLOOM_EXTRACT_FRAG_SRC);
      this._bloomBlurProg    = this._createProgram(PP_VERT_SRC, BLOOM_BLUR_FRAG_SRC);
      this._compositeProg    = this._createProgram(PP_VERT_SRC, COMPOSITE_FRAG_SRC);

      // Cache PP uniform locations.
      this._uExtractScene      = this._requireUniformIn(this._bloomExtractProg, 'u_scene');
      this._uExtractThreshold  = this._requireUniformIn(this._bloomExtractProg, 'u_threshold');
      this._uBlurSource        = this._requireUniformIn(this._bloomBlurProg,    'u_source');
      this._uBlurHorizontal    = this._requireUniformIn(this._bloomBlurProg,    'u_horizontal');
      this._uCompositeScene    = this._requireUniformIn(this._compositeProg,    'u_scene');
      this._uCompositeBloom    = this._requireUniformIn(this._compositeProg,    'u_bloom');
      this._uCompositeStrength = this._requireUniformIn(this._compositeProg,    'u_bloomStrength');
      this._uCompositeBg       = this._requireUniformIn(this._compositeProg,    'u_background');
      this._uCompositeHasBg    = this._requireUniformIn(this._compositeProg,    'u_hasBackground');

      // Background texture + FBO (same RGBA16F format; sized in _resize).
      this._bgTex = this._createTexture();
      this._bgFbo = this._createFbo();

      // Create HDR + bloom texture objects (sized lazily in _resize).
      this._hdrTex          = this._createTexture();
      this._bloomExtractTex = this._createTexture();
      this._bloomBlurHTex   = this._createTexture();
      this._bloomBlurVTex   = this._createTexture();

      // Create FBO objects (attached to textures in _resize).
      this._hdrFbo          = this._createFbo();
      this._bloomExtractFbo = this._createFbo();
      this._bloomBlurHFbo   = this._createFbo();
      this._bloomBlurVFbo   = this._createFbo();

      // Post-processing VAO — shares _vbo with the scene pass.
      this._ppVao = this._createPPVao();
    } else {
      console.warn(
        'WebGLRenderer: EXT_color_buffer_float unavailable; bloom disabled.',
      );
    }

    // --- Textures (allocated empty; resized on first render) -----------------
    this._cellTypeTex      = this._createTexture();
    this._energyTex        = this._createTexture();
    this._flagsTex         = this._createTexture();
    this._variantIdTex     = this._createTexture();
    // Phase 12 textures.
    this._genomeTex        = this._createTexture();
    this._generationTex    = this._createTexture();
    this._signalStrengthTex = this._createTexture();

    // --- Variant palette texture (256×1, RGBA, static) ----------------------
    // Build the palette as a flat RGBA Uint8Array (4 bytes per variant).
    // The VARIANT_PALETTE entries are packed little-endian RGBA; we need to
    // unpack and re-pack as big-endian RGBA for WebGL texImage2D.
    const palBytes = new Uint8Array(256 * 4);
    for (let v = 0; v < 256; v++) {
      const packed = VARIANT_PALETTE[v];
      const base   = v * 4;
      palBytes[base]     =  packed        & 0xFF; // R
      palBytes[base + 1] = (packed >>  8) & 0xFF; // G
      palBytes[base + 2] = (packed >> 16) & 0xFF; // B
      palBytes[base + 3] = 0xFF;                   // A = fully opaque
    }
    this._variantPaletteTex = this._createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._variantPaletteTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,             // mip level
      gl.RGBA8,      // internal format
      256,           // width = 256 palette entries
      1,             // height = 1 row
      0,             // border
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      palBytes,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ---------------------------------------------------------------------------
  // Public API (mirrors Renderer exactly)
  // ---------------------------------------------------------------------------

  /** Current pixels-per-cell setting. */
  get cellSize(): number {
    return this._cellSize;
  }

  /**
   * Changes the cell size and queues a canvas resize on the next render call.
   *
   * @param size - New cell size in pixels (1–8).
   */
  set cellSize(size: number) {
    this._cellSize = size;
    // Force canvas + viewport resize on next render by resetting tracked dims.
    this._gridWidth = 0;
  }

  /** Whether the grid-line overlay is active. */
  get showGridLines(): boolean {
    return this._showGridLines;
  }

  /**
   * Enables or disables the 1-px grid-line overlay.
   *
   * @param show - True to draw grid lines; false to hide.
   */
  set showGridLines(show: boolean) {
    this._showGridLines = show;
  }

  /**
   * Current render mode.
   * - `'default'`    — cell type + energy colour mapping (Phase 1–9 behaviour).
   * - `'lifecycle'`  — Life cells coloured by JUVENILE/SENESCENT flags (Phase 10).
   * - `'variantId'`  — Life cells coloured by variant lineage palette (Phase 11).
   * - `'genome'`     — Life cells coloured by genome value (Phase 12).
   * - `'generation'` — Life cells coloured by generation count (Phase 12).
   * - `'fitness'`    — Life cells coloured by energy as fitness proxy (Phase 12).
   * - `'signal'`     — All cells overlaid with signal strength glow (Phase 12).
   */
  /**
   * Phase 18: morphology detail level [0, 1].
   * At 0 cells render as flat coloured squares; at 1 they show circular bodies,
   * membranes, nuclei, organelles, pulse animation, and division flashes.
   *
   * @returns Current detail level.
   */
  get aliveDetail(): number {
    return this._aliveDetail;
  }

  /**
   * Sets the morphology detail level.  Takes effect on the next render call.
   *
   * @param value - Clamped to [0, 1].
   */
  set aliveDetail(value: number) {
    this._aliveDetail = Math.max(0, Math.min(1, value));
  }

  get renderMode(): 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal' | 'morphology' {
    if (this._renderMode === 1) return 'lifecycle';
    if (this._renderMode === 2) return 'variantId';
    if (this._renderMode === 3) return 'genome';
    if (this._renderMode === 4) return 'generation';
    if (this._renderMode === 5) return 'fitness';
    if (this._renderMode === 6) return 'signal';
    if (this._renderMode === 7) return 'morphology';
    return 'default';
  }

  /**
   * Changes the render mode.  Takes effect on the next {@link render} call.
   *
   * @param mode - New render mode string.
   */
  set renderMode(mode: 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal' | 'morphology') {
    if (mode === 'lifecycle')        { this._renderMode = 1; }
    else if (mode === 'variantId')   { this._renderMode = 2; }
    else if (mode === 'genome')      { this._renderMode = 3; }
    else if (mode === 'generation')  { this._renderMode = 4; }
    else if (mode === 'fitness')     { this._renderMode = 5; }
    else if (mode === 'signal')      { this._renderMode = 6; }
    else if (mode === 'morphology')  { this._renderMode = 7; }
    else                             { this._renderMode = 0; }
  }

  /**
   * Environment colour tint blended into every Life cell colour.
   *
   * @param tint - `[r, g, b, alpha]` with r/g/b ∈ [0, 255] and alpha ∈ [0, 1].
   *               Set alpha to 0 (via `[0,0,0,0]`) to disable tinting.
   */
  set envTint(tint: readonly [number, number, number, number]) {
    this._envTintVec = tint;
  }

  // --- Phase 16c bloom controls ---------------------------------------------

  /**
   * Returns true when the HDR bloom pipeline is active.
   * False when `EXT_color_buffer_float` was unavailable at construction.
   */
  get bloomEnabled(): boolean {
    return this._bloomEnabled;
  }

  /**
   * Enables or disables the HDR bloom post-processing pipeline.
   * Has no effect when `EXT_color_buffer_float` is unavailable.
   *
   * @param enabled - True to enable bloom; false to use direct 8-bit rendering.
   */
  set bloomEnabled(enabled: boolean) {
    // Can only enable if the extension is available (FBOs were created).
    if (enabled && this._hdrFbo === null) return;
    this._bloomEnabled = enabled;
  }

  /**
   * Luminance threshold above which pixels contribute to bloom.
   *
   * @returns Current threshold in [0, 1]. Default: 0.85.
   */
  get bloomThreshold(): number {
    return this._bloomThreshold;
  }

  /**
   * Sets the luminance threshold for bloom extraction.
   * Lower values spread bloom to more cells; higher values restrict it to the
   * brightest emissive types.
   *
   * @param t - Threshold in [0, 1]. Values outside the range are clamped.
   */
  set bloomThreshold(t: number) {
    this._bloomThreshold = Math.max(0, Math.min(1, t));
  }

  /**
   * Bloom additive blend strength.
   *
   * @returns Current strength in [0, 1]. Default: 0.6.
   */
  get bloomStrength(): number {
    return this._bloomStrength;
  }

  /**
   * Sets the bloom blend strength in the composite pass.
   * 0 = no bloom visible; 1 = full computed bloom intensity.
   *
   * @param s - Strength in [0, 1]. Values outside the range are clamped.
   */
  set bloomStrength(s: number) {
    this._bloomStrength = Math.max(0, Math.min(1, s));
  }

  // --- Phase 16d background control ----------------------------------------

  /**
   * Sets the WebGL background rendered behind the simulation in the HDR bloom
   * composite pass.  Pass `null` to clear (empty cells → opaque dark).
   *
   * Only effective when the HDR bloom pipeline is active.
   *
   * @param bg - WebGL background instance, or null for no background.
   */
  setWebGLBackground(bg: WebGLBackground | null): void {
    this._webGLBackground = bg;
  }

  /**
   * Renders the simulation state onto the canvas using WebGL.
   *
   * Steps:
   * 1. Resize canvas + WebGL viewport if grid dimensions or cellSize changed.
   * 2. Upload `cellType` and `energy` arrays as GPU textures (sub-image update).
   * 3. Set uniforms and draw the fullscreen quad.
   *
   * @param buffers - Grid front buffers (read-only by convention).
   * @param width   - Grid width in cells.
   * @param height  - Grid height in cells.
   */
  render(buffers: GridBuffers, width: number, height: number): void {
    const gl = this._gl;

    // Resize canvas and WebGL viewport when dimensions or cellSize change.
    if (width !== this._gridWidth || height !== this._gridHeight) {
      this._resize(width, height);
    }

    // --- Upload cellType texture (R8UI) ---------------------------------------
    //
    // `texSubImage2D` writes into an existing texture object without
    // reallocating GPU memory — much cheaper than `texImage2D` every frame.
    gl.bindTexture(gl.TEXTURE_2D, this._cellTypeTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,              // mip level
      0, 0,           // xoffset, yoffset
      width, height,  // width, height
      gl.RED_INTEGER, // format matching R8UI internal format
      gl.UNSIGNED_BYTE,
      buffers.cellType,
    );

    // --- Upload energy texture (R32F) -----------------------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._energyTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED,         // format matching R32F internal format
      gl.FLOAT,
      buffers.energy,
    );

    // --- Upload flags texture (R8UI, Phase 10) --------------------------------
    // The flags byte holds lifecycle bits (JUVENILE, SENESCENT) used by the
    // lifecycle render mode in the fragment shader.
    gl.bindTexture(gl.TEXTURE_2D, this._flagsTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      buffers.flags,
    );

    // --- Upload variantId texture (R8UI, Phase 11) ----------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._variantIdTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      buffers.variantId,
    );

    // --- Upload genome texture (R16UI, Phase 12) ------------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._genomeTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      buffers.genome,
    );

    // --- Upload generation texture (R16UI, Phase 12) --------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._generationTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      buffers.generation,
    );

    // --- Upload signalStrength texture (R32F, Phase 12) -----------------------
    gl.bindTexture(gl.TEXTURE_2D, this._signalStrengthTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED,
      gl.FLOAT,
      buffers.signalStrength,
    );

    // --- Draw -----------------------------------------------------------------

    gl.useProgram(this._program);

    // Bind cellType texture to texture unit 0.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._cellTypeTex);
    gl.uniform1i(this._uCellType, 0);

    // Bind energy texture to texture unit 1.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._energyTex);
    gl.uniform1i(this._uEnergy, 1);

    // Bind flags texture to texture unit 2 (Phase 10).
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._flagsTex);
    gl.uniform1i(this._uFlags, 2);

    // Bind variantId texture to texture unit 3 (Phase 11).
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._variantIdTex);
    gl.uniform1i(this._uVariantId, 3);

    // Bind variant palette texture to texture unit 4 (Phase 11).
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this._variantPaletteTex);
    gl.uniform1i(this._uVariantPalette, 4);

    // Bind genome texture to texture unit 5 (Phase 12).
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this._genomeTex);
    gl.uniform1i(this._uGenome, 5);

    // Bind generation texture to texture unit 6 (Phase 12).
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this._generationTex);
    gl.uniform1i(this._uGeneration, 6);

    // Bind signalStrength texture to texture unit 7 (Phase 12).
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this._signalStrengthTex);
    gl.uniform1i(this._uSignalStrength, 7);

    // Per-frame uniforms.
    gl.uniform1f(this._uCellSize,      this._cellSize);
    gl.uniform1i(this._uGridWidth,     width);
    gl.uniform1i(this._uGridHeight,    height);
    gl.uniform1i(this._uShowGridLines, this._showGridLines ? 1 : 0);
    gl.uniform1i(this._uRenderMode,    this._renderMode);
    gl.uniform1i(this._uTime,          this._frame);
    gl.uniform1f(this._uAliveDetail,   this._aliveDetail);

    // Upload environment tint — r/g/b normalised to [0,1] for the shader.
    const [tr, tg, tb, ta] = this._envTintVec;
    gl.uniform4f(this._uEnvTint, tr / 255, tg / 255, tb / 255, ta);

    // Dispatch to the appropriate render path.
    if (this._bloomEnabled && this._hdrFbo !== null) {
      this._drawHDRPipeline();
    } else {
      // Direct path: render scene straight to the 8-bit display framebuffer.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.uniform1i(this._uHdrOutput, 0);
      gl.bindVertexArray(this._vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }
  }

  /**
   * No-op on the WebGL renderer — texture uploads replace all cell data on
   * every frame so there is no stale pixel cache to invalidate.
   *
   * The method exists so `RenderWorker.ts` can call it uniformly on both
   * `Renderer` and `WebGLRenderer` without type checking.
   */
  invalidate(): void {
    // Intentional no-op: WebGL redraws from textures every frame.
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resizes the canvas and WebGL viewport to match `width * cellSize × height * cellSize`.
   * Also re-allocates the two GPU textures at the new grid dimensions.
   *
   * @param width  - Grid width in cells.
   * @param height - Grid height in cells.
   */
  private _resize(width: number, height: number): void {
    this._gridWidth  = width;
    this._gridHeight = height;

    const gl       = this._gl;
    // Cap canvas pixels so the HDR bloom pipeline never exceeds _maxTexDim.
    // At large cellSizes (e.g. 32px × 512 grid = 16 384px) the uncapped size
    // would exceed GPU texture limits and cause catastrophic perf / white screen.
    // The fragment shader maps fragCoord → cellCoord via division by u_cellSize,
    // so capping just means fewer cells are visible — correct pan-in behaviour.
    const canvasW  = Math.min(width  * this._cellSize, this._maxTexDim);
    const canvasH  = Math.min(height * this._cellSize, this._maxTexDim);

    // Resize the canvas (both HTMLCanvasElement and OffscreenCanvas have these
    // writable properties).
    this._canvas.width  = canvasW;
    this._canvas.height = canvasH;

    // Match the WebGL viewport to the canvas pixel dimensions.
    gl.viewport(0, 0, canvasW, canvasH);

    // (Re-)allocate all per-cell textures at the new grid size.
    // texImage2D with null data allocates GPU memory without a data copy;
    // texSubImage2D fills each texture on the first real render call.
    this._allocateTexture(this._cellTypeTex,       width, height, gl.R8UI,  gl.RED_INTEGER, gl.UNSIGNED_BYTE);
    this._allocateTexture(this._energyTex,         width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    // Phase 10: flags texture (R8UI) — holds lifecycle bitmask per cell.
    this._allocateTexture(this._flagsTex,          width, height, gl.R8UI,  gl.RED_INTEGER, gl.UNSIGNED_BYTE);
    // Phase 11: variantId texture (R8UI) — holds lineage ID per cell.
    this._allocateTexture(this._variantIdTex,      width, height, gl.R8UI,  gl.RED_INTEGER, gl.UNSIGNED_BYTE);
    // Phase 12: genome / generation (R16UI) and signalStrength (R32F).
    this._allocateTexture(this._genomeTex,         width, height, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT);
    this._allocateTexture(this._generationTex,     width, height, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT);
    this._allocateTexture(this._signalStrengthTex, width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    // Note: _variantPaletteTex is 256×1 and never resizes — skip here.

    // --- HDR bloom textures (Phase 16c) --------------------------------------
    //
    // Allocated only when the extension is available.  The scene FBO matches
    // the canvas pixel size exactly; bloom FBOs run at half resolution to keep
    // the Gaussian blur cheap without a visible quality loss.
    if (this._bloomEnabled && this._hdrTex !== null) {
      const halfW = Math.max(1, Math.floor(canvasW / 2));
      const halfH = Math.max(1, Math.floor(canvasH / 2));

      this._allocateHdrTexture(this._hdrTex,          canvasW, canvasH);
      this._attachTexToFbo(    this._hdrFbo!,          this._hdrTex);

      this._allocateHdrTexture(this._bloomExtractTex!, halfW, halfH);
      this._attachTexToFbo(    this._bloomExtractFbo!, this._bloomExtractTex!);

      this._allocateHdrTexture(this._bloomBlurHTex!,   halfW, halfH);
      this._attachTexToFbo(    this._bloomBlurHFbo!,   this._bloomBlurHTex!);

      this._allocateHdrTexture(this._bloomBlurVTex!,   halfW, halfH);
      this._attachTexToFbo(    this._bloomBlurVFbo!,   this._bloomBlurVTex!);

      // Background texture runs at full scene resolution (same as HDR scene).
      if (this._bgTex !== null) {
        this._allocateHdrTexture(this._bgTex, canvasW, canvasH);
        this._attachTexToFbo(this._bgFbo!, this._bgTex);
      }
    }
  }

  /**
   * Allocates (or re-allocates) a 2D texture at the given dimensions.
   * Existing GPU memory is freed and a new allocation is created.
   *
   * Uses nearest-neighbour filtering and clamp-to-edge wrapping, which is
   * required for non-power-of-two textures in WebGL 2.
   *
   * @param tex            - Texture object to configure.
   * @param width          - Texture width in texels.
   * @param height         - Texture height in texels.
   * @param internalFormat - WebGL internal format (e.g. `gl.R8UI`, `gl.R32F`).
   * @param format         - Pixel data format (e.g. `gl.RED_INTEGER`, `gl.RED`).
   * @param type           - Data type (e.g. `gl.UNSIGNED_BYTE`, `gl.FLOAT`).
   */
  private _allocateTexture(
    tex: WebGLTexture,
    width: number,
    height: number,
    internalFormat: number,
    format: number,
    type: number,
  ): void {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);

    // Allocate GPU storage without uploading data yet.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,              // mip level
      internalFormat,
      width,
      height,
      0,              // border (must be 0 in WebGL)
      format,
      type,
      null,           // no data — filled by texSubImage2D on first render
    );

    // Nearest-neighbour filtering keeps cell boundaries pixel-sharp.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // Clamp-to-edge is required for non-power-of-two textures in WebGL.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Compiles and links the vertex + fragment shaders into a GLSL programme.
   *
   * @param vertSrc - GLSL vertex shader source.
   * @param fragSrc - GLSL fragment shader source.
   * @returns Linked `WebGLProgram`.
   * @throws If either shader fails to compile or linking fails.
   */
  private _createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl   = this._gl;
    const vert = this._compileShader(gl.VERTEX_SHADER,   vertSrc);
    const frag = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);

    const prog = gl.createProgram();
    if (prog === null) throw new Error('WebGLRenderer: gl.createProgram() returned null.');

    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);

    // Shaders are consumed by the programme — detach and delete to free GPU mem.
    gl.detachShader(prog, vert);
    gl.detachShader(prog, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? 'unknown error';
      gl.deleteProgram(prog);
      throw new Error(`WebGLRenderer: programme link failed:\n${log}`);
    }

    return prog;
  }

  /**
   * Compiles one GLSL shader stage.
   *
   * @param type   - `gl.VERTEX_SHADER` or `gl.FRAGMENT_SHADER`.
   * @param source - GLSL source text.
   * @returns Compiled `WebGLShader`.
   * @throws If compilation fails.
   */
  private _compileShader(type: number, source: string): WebGLShader {
    const gl     = this._gl;
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('WebGLRenderer: gl.createShader() returned null.');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
      gl.deleteShader(shader);
      const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`WebGLRenderer: ${typeName} shader compile failed:\n${log}`);
    }

    return shader;
  }

  /**
   * Uploads the fullscreen quad vertices into a `WebGLBuffer`.
   *
   * The buffer is bound to `ARRAY_BUFFER` and filled with {@link QUAD_VERTS}.
   * It is never modified after construction.
   *
   * @returns The created and populated `WebGLBuffer`.
   * @throws If buffer creation fails.
   */
  private _createQuadBuffer(): WebGLBuffer {
    const gl  = this._gl;
    const buf = gl.createBuffer();
    if (buf === null) throw new Error('WebGLRenderer: gl.createBuffer() returned null.');

    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return buf;
  }

  /**
   * Creates a VAO that binds the `a_position` attribute to the quad buffer.
   *
   * Using a VAO means the attribute binding state is saved once and replayed
   * on each draw call without re-specifying the layout.
   *
   * @param vbo - The quad vertex buffer.
   * @returns The created `WebGLVertexArrayObject`.
   * @throws If VAO or attribute location lookup fails.
   */
  private _createVAO(vbo: WebGLBuffer): WebGLVertexArrayObject {
    const gl  = this._gl;
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('WebGLRenderer: gl.createVertexArray() returned null.');

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    const loc = gl.getAttribLocation(this._program, 'a_position');
    if (loc === -1) {
      throw new Error('WebGLRenderer: attribute "a_position" not found in programme.');
    }

    // Two floats (x, y) per vertex, no stride padding, starting at offset 0.
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(null);
    return vao;
  }

  /**
   * Creates an empty, unbound `WebGLTexture` object.
   * The texture is configured and sized lazily on first use in `_allocateTexture`.
   *
   * @returns A new `WebGLTexture`.
   * @throws If texture creation fails.
   */
  private _createTexture(): WebGLTexture {
    const tex = this._gl.createTexture();
    if (tex === null) throw new Error('WebGLRenderer: gl.createTexture() returned null.');
    return tex;
  }

  // ---------------------------------------------------------------------------
  // Phase 16c — HDR bloom pipeline
  // ---------------------------------------------------------------------------

  /**
   * Runs the 5-pass HDR bloom pipeline when `EXT_color_buffer_float` is
   * available.  Assumes `this._program` is already bound with all scene
   * uniforms set (called from `render()` after the scene setup block).
   *
   * Pass 1 — scene to RGBA16F HDR FBO (full resolution).
   * Pass 2 — bloom extraction to half-res FBO (luma > threshold).
   * Pass 3 — horizontal 9-tap Gaussian blur (half-res).
   * Pass 4 — vertical   9-tap Gaussian blur (half-res).
   * Pass 5 — composite scene + bloom, Reinhard tonemap, sRGB encode → display.
   *
   */
  private _drawHDRPipeline(): void {
    // Guard: resources are fully present (should always be true when _bloomEnabled).
    if (
      this._hdrFbo          === null || this._hdrTex          === null ||
      this._bloomExtractFbo === null || this._bloomExtractTex === null ||
      this._bloomBlurHFbo   === null || this._bloomBlurHTex   === null ||
      this._bloomBlurVFbo   === null || this._bloomBlurVTex   === null ||
      this._bloomExtractProg === null || this._bloomBlurProg  === null ||
      this._compositeProg   === null || this._ppVao           === null
    ) return;

    const gl     = this._gl;
    // Use the canvas's actual pixel dimensions — already capped by _resize.
    const cW     = this._canvas.width;
    const cH     = this._canvas.height;
    const halfW  = Math.max(1, Math.floor(cW / 2));
    const halfH  = Math.max(1, Math.floor(cH / 2));

    // --- Pass 0 (optional): Render WebGL background into bg FBO -------------
    const hasBg = this._webGLBackground !== null && this._bgFbo !== null && this._bgTex !== null;
    if (hasBg) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bgFbo);
      gl.viewport(0, 0, cW, cH);
      this._webGLBackground!.render(gl, cW, cH, this._frame);
    }

    // --- Pass 1: Render scene to HDR FBO ------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._hdrFbo);
    gl.viewport(0, 0, cW, cH);
    // Re-bind scene program (background render may have left a different program).
    gl.useProgram(this._program);
    gl.uniform1i(this._uHdrOutput, 1);   // emit raw linear (may exceed 1.0)
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Pass 2: Bloom extract (full-res HDR → half-res extract FBO) --------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomExtractFbo);
    gl.viewport(0, 0, halfW, halfH);
    gl.useProgram(this._bloomExtractProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._hdrTex);
    gl.uniform1i(this._uExtractScene!,     0);
    gl.uniform1f(this._uExtractThreshold!, this._bloomThreshold);
    gl.bindVertexArray(this._ppVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Pass 3: Horizontal Gaussian blur (extract → blurH FBO) -------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomBlurHFbo);
    gl.useProgram(this._bloomBlurProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomExtractTex);
    gl.uniform1i(this._uBlurSource!,     0);
    gl.uniform1i(this._uBlurHorizontal!, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Pass 4: Vertical Gaussian blur (blurH → blurV FBO) -----------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomBlurVFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomBlurHTex);
    gl.uniform1i(this._uBlurHorizontal!, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Pass 5: Composite + Reinhard tonemap → display framebuffer ----------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cW, cH);
    gl.useProgram(this._compositeProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._hdrTex);
    gl.uniform1i(this._uCompositeScene!,    0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomBlurVTex);
    gl.uniform1i(this._uCompositeBloom!,    1);
    gl.uniform1f(this._uCompositeStrength!, this._bloomStrength);

    // Bind background texture to unit 2 and inform the composite shader.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, hasBg ? this._bgTex : null);
    gl.uniform1i(this._uCompositeBg!,    2);
    gl.uniform1i(this._uCompositeHasBg!, hasBg ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);

    this._frame++;
  }

  /**
   * Allocates (or re-allocates) an RGBA16F texture at the given pixel
   * dimensions with linear filtering for smooth bloom sampling.
   *
   * @param tex    - Texture object to configure.
   * @param width  - Width in pixels.
   * @param height - Height in pixels.
   */
  private _allocateHdrTexture(tex: WebGLTexture, width: number, height: number): void {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // RGBA16F: 4-channel, 16-bit float — supports values > 1.0 for HDR glow.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    // Linear filtering gives smoother bloom blending than nearest-neighbour.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Attaches a texture to a framebuffer's `COLOR_ATTACHMENT0`.
   *
   * @param fbo - Framebuffer to configure.
   * @param tex - Texture to attach as the colour render target.
   */
  private _attachTexToFbo(fbo: WebGLFramebuffer, tex: WebGLTexture): void {
    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Creates an empty `WebGLFramebuffer` object.
   * Textures are attached (and re-attached on resize) via `_attachTexToFbo`.
   *
   * @returns The created `WebGLFramebuffer`.
   * @throws If framebuffer creation fails.
   */
  private _createFbo(): WebGLFramebuffer {
    const fbo = this._gl.createFramebuffer();
    if (fbo === null) throw new Error('WebGLRenderer: gl.createFramebuffer() returned null.');
    return fbo;
  }

  /**
   * Creates a VAO for the post-processing fullscreen quad.
   * Reuses `_vbo` (same geometry) but queries `a_position` from the
   * bloom-extract programme so the attribute location is correct.
   *
   * @returns The created `WebGLVertexArrayObject`.
   * @throws If VAO creation or attribute lookup fails.
   */
  private _createPPVao(): WebGLVertexArrayObject {
    const gl  = this._gl;
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('WebGLRenderer: gl.createVertexArray() returned null (PP).');

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);

    const loc = gl.getAttribLocation(this._bloomExtractProg!, 'a_position');
    if (loc === -1) throw new Error('WebGLRenderer: "a_position" not found in bloom-extract programme.');

    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(null);
    return vao;
  }

  /**
   * Returns the `WebGLUniformLocation` for a named uniform in the given
   * programme, throwing if not found.  Used for post-processing programmes
   * where uniforms live in a programme other than `this._program`.
   *
   * @param prog - The linked `WebGLProgram` to query.
   * @param name - Uniform variable name in the GLSL source.
   * @returns The `WebGLUniformLocation`.
   * @throws If the uniform is not found in `prog`.
   */
  private _requireUniformIn(prog: WebGLProgram, name: string): WebGLUniformLocation {
    const loc = this._gl.getUniformLocation(prog, name);
    if (loc === null) {
      throw new Error(`WebGLRenderer: uniform "${name}" not found in post-process programme.`);
    }
    return loc;
  }

  /**
   * Returns the `WebGLUniformLocation` for the named uniform, throwing if it
   * does not exist in the compiled programme.
   *
   * All uniforms referenced in the shaders must be successfully resolved here
   * to catch typos at construction time rather than silently at render time.
   *
   * @param name - Uniform variable name in the GLSL source.
   * @returns The `WebGLUniformLocation`.
   * @throws If the uniform is not found.
   */
  private _requireUniform(name: string): WebGLUniformLocation {
    const loc = this._gl.getUniformLocation(this._program, name);
    if (loc === null) {
      throw new Error(`WebGLRenderer: uniform "${name}" not found in programme.`);
    }
    return loc;
  }
}

// ---------------------------------------------------------------------------
// Static capability check
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the current environment supports WebGL 2.
 *
 * Call this before constructing a `WebGLRenderer` to give the application a
 * chance to fall back to the Canvas 2D renderer gracefully.
 *
 * Detection uses a temporary `OffscreenCanvas` (1×1) so it works in Web
 * Workers as well as on the main thread.  The probe context is explicitly
 * released via `WEBGL_lose_context` to avoid the browser warning
 * "Too many active WebGL contexts" caused by accumulated unreleased probes.
 *
 * @returns `true` if `WebGL2RenderingContext` is available and functional.
 */
export function isWebGL2Available(): boolean {
  try {
    const probe = new OffscreenCanvas(1, 1);
    const gl    = probe.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl === null) return false;

    // Release the probe context immediately so the browser does not keep it
    // alive as an "active" WebGL context.  WEBGL_lose_context is universally
    // supported in any browser that implements WebGL 2.
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();

    return true;
  } catch {
    return false;
  }
}
