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
 *  12 — **predprey** (Phase 21): Life cells classified by genome threshold.
 *       Predators → vivid red (#ff2200); prey → teal (#00ddbb); Spores → brown (#5c3d1a).
 *       Non-Life cells render as in default mode.
 *
 * Colour values stay in sync with ColorMap.ts COLOR_ENTRIES.
 * Round 2 cell types 11–15 and Phase 21 type 16 (Spore) are included.
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

/**
 * Phase 19: R32F texture — X-axis velocity (grid-units/tick) per cell.
 * Sampled in lifeMorphology() to render the trailing flagellum arc.
 */
uniform sampler2D u_vx;

/**
 * Phase 19: R32F texture — Y-axis velocity (grid-units/tick) per cell.
 */
uniform sampler2D u_vy;

/**
 * Phase 20: R32F texture — nutrient chemical concentration [0, 1] per cell.
 * Seeded by Nutrient cells; diffuses and decays each tick.
 * Visualised in render mode 8 as a blue→green heat map.
 */
uniform sampler2D u_chemNutrient;

/**
 * Phase 20: R32F texture — waste chemical concentration [0, 1] per cell.
 * Secreted by active Life cells proportional to energy consumption.
 * Visualised in render mode 9 as a yellow→red heat map.
 */
uniform sampler2D u_chemWaste;

/**
 * Phase 20: R32F texture — kin pheromone concentration [0, 1] per cell.
 * Secreted by Life cells; drives quorum sensing and kin attraction.
 * Visualised in render mode 10 as a purple gradient.
 */
uniform sampler2D u_chemPheromone;

/**
 * Phase 20: R32F texture — alarm pheromone concentration [0, 1] per cell.
 * Emitted by dying cells; triggers alarm-flight in neighbours.
 * Visualised in render mode 11 as an urgent orange glow.
 */
uniform sampler2D u_chemAlarm;

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
 *   0 = default         (cellType + energy)
 *   1 = lifecycle       (Life cells coloured by JUVENILE / SENESCENT flags)
 *   2 = variantId       (Life cells coloured by lineage palette)
 *   3 = genome          (Life cells coloured by 16-bit genome value)
 *   4 = generation      (Life cells coloured by generation count)
 *   5 = fitness         (Life cells coloured by energy as fitness proxy)
 *   6 = signal          (all cells overlaid with signalStrength cyan glow)
 *   7 = morphology      (Phase 18 anatomy without energy tinting)
 *   8 = nutrient-field  (Phase 20 chemNutrient heat map: blue → green)
 *   9 = waste-field     (Phase 20 chemWaste heat map: yellow → red)
 *  10 = pheromone-field (Phase 20 chemPheromone heat map: black → purple)
 *  11 = alarm-field     (Phase 20 chemAlarm heat map: black → orange)
 *  12 = predprey        (Phase 21: predators vivid red / prey teal / spores brown)
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

/**
 * Phase 21: predator genome threshold normalised to [0, 1] (divide the raw
 * Uint16 threshold by 65535).  Life cells with normalised genome >= this value
 * are rendered as predators in render mode 12.  0 = predprey mode disabled
 * (all Life cells render as prey teal, which is the expected fallback).
 */
uniform float u_predatorThreshold;

/**
 * Phase 22: when true, interior cells of tight clusters are subtly darkened
 * by counting their live Moore-neighbourhood occupancy.
 * Produces a subtle depth cue that makes colony edges pop against the interior.
 */
uniform bool u_ambientOcclusion;

/**
 * Phase 22: R32F texture — per-cell trail brightness [0, 1].
 * Decays at 0.92× per frame; written to by motile cells as they vacate a cell.
 * Composited over empty cells as a faint variant-coloured wake.
 */
uniform sampler2D u_trailBright;

/**
 * Phase 22: R8UI texture — variantId of the last motile cell to occupy each
 * cell.  Looked up via the variant palette to colour the trail glow.
 */
uniform usampler2D u_trailVid;

/**
 * Phase 22: when true, trail glow is blended over empty cells.
 */
uniform bool u_trails;

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

  // ---- Phase 21 -----------------------------------------------------------
  // 16 Spore       #5c3d1a — thick-walled brown dormancy pod
  if (t == 16u) return vec3(0.361,  0.239,  0.102);

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
  if (t == 16u) return 0.3;    // Spore — never fully dark so the pod stays visible
  return 1.0;                  // all others: static brightness
}

/**
 * Returns true for cell types whose brightness scales with the energy value.
 *
 * @param t - Cell type ordinal.
 * @returns True if the colour should dim at low energy.
 */
bool isEnergyModulated(uint t) {
  // Phase 21: Spore energy is frozen at sporulation value, so modulating by it
  // gives a natural visual indicator of how much "life" remains in the dormant cell.
  return t == 1u || t == 7u || t == 8u || t == 10u || t == 11u || t == 15u || t == 16u;
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
  vec2  uv,
  float vx,
  float vy
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

  // --- Phase 19: Flagellum arc (motile cells, aliveDetail > 0.5, vMag > 0.1) ---
  //
  // Renders a thin tapered arc trailing behind the cell in the direction
  // opposite to its velocity vector.  Only visible at higher detail levels
  // and when the cell is actually moving (vMag > 0.1 grid-units/tick).
  float vMag = length(vec2(vx, vy));
  if (vMag > 0.1) {
    vec2  flagDir  = -normalize(vec2(vx, vy)); // trail points opposite to motion
    float axial    = dot(c, flagDir);           // distance along flagellum axis
    float lateral  = length(c - axial * flagDir);

    // Only draw in the band between just past the membrane and the cell edge.
    float flagStart = 0.24;
    float flagEnd   = 0.48;
    float t         = clamp((axial - flagStart) / (flagEnd - flagStart), 0.0, 1.0);
    float axialMask = smoothstep(flagStart, flagStart + 0.04, axial) *
                      (1.0 - smoothstep(flagEnd - 0.05, flagEnd, axial));

    // Width tapers from 0.04 at the root to 0.01 at the tip.
    float halfW       = mix(0.04, 0.01, t);
    float lateralMask = 1.0 - smoothstep(halfW - 0.008, halfW, lateral);

    float flagMask  = axialMask * lateralMask;
    float speedFade = clamp((vMag - 0.1) / 0.9, 0.0, 1.0);
    float flagAlpha = flagMask * speedFade;

    if (flagAlpha > 0.001) {
      // Brighter than the base colour so flagella pop against the background.
      vec3 flagColour = baseRGB * 2.0;
      rgb        = mix(rgb, flagColour, flagAlpha);
      totalAlpha = max(totalAlpha, flagAlpha * 0.85);
    }
  }

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

  } else if (u_renderMode == 12) {
    // ---- Predator/Prey render mode (Phase 21) --------------------------------
    //
    // Three-way classification visible at a glance:
    //   Predators (genome >= threshold, encoded by u_predatorThreshold) → vivid red
    //   Prey      (Life, below threshold)                               → teal
    //   Spores    (dormant prey)                                        → brown
    //   Non-Life cells fall back to default rendering below this branch.
    //
    // u_predatorThreshold is passed as a float in [0, 1] normalised from the
    // 16-bit genome range so the shader avoids integer division.

    if (cellType == 16u) {
      // Spore — energy-modulated brown; slow pulse from frozen energy value.
      float bright = 0.3 + 0.7 * clamp(energy, 0.0, 1.0);
      cellRGB = srgbToLinearVec(vec3(0.361, 0.239, 0.102)) * bright;

    } else if (isLife) {
      uint genomeVal  = texelFetch(u_genome, cellCoord, 0).r;
      float genomeT   = float(genomeVal) / 65535.0;   // normalise to [0, 1]

      if (genomeT >= u_predatorThreshold && u_predatorThreshold > 0.0) {
        // Predator — vivid red (#ff2200), brightness from energy.
        float bright = 0.2 + 0.8 * clamp(energy, 0.0, 1.0);
        cellRGB = srgbToLinearVec(vec3(1.0, 0.133, 0.0)) * bright;
      } else {
        // Prey — teal (#00ddbb), brightness from energy.
        float bright = 0.15 + 0.85 * clamp(energy, 0.0, 1.0);
        cellRGB = srgbToLinearVec(vec3(0.0, 0.867, 0.733)) * bright;
      }
    } else {
      // Non-Life cells: standard default rendering.
      vec3 base = u_hdrOutput ? hdrBaseColor(cellType) : srgbToLinearVec(baseColor(cellType));
      cellRGB = isEnergyModulated(cellType)
        ? base * (minBrightness(cellType) + (1.0 - minBrightness(cellType)) * clamp(energy, 0.0, 1.0))
        : base;
    }

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
    uint  genomeVal = texelFetch(u_genome, cellCoord, 0).r;
    int   cellIdx   = cellCoord.y * u_gridWidth + cellCoord.x;
    vec2  morphUV   = cellLocalUV();
    // Phase 19: sample velocity for flagellum rendering.
    float vxVal     = texelFetch(u_vx, cellCoord, 0).r;
    float vyVal     = texelFetch(u_vy, cellCoord, 0).r;

    vec4 morph = lifeMorphology(cellRGB, energy, flags, genomeVal, cellIdx, morphUV, vxVal, vyVal);

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

  // ---- Phase 20: Chemical field render modes (8–11) --------------------------
  //
  // Each mode samples one chemical channel and displays a full-canvas heat map
  // over the base cell colour.  The mapping uses two-stop colour interpolation
  // in linear light space so the gradient is perceptually smooth.
  //
  // Mode  8 — Nutrient field  : 0 → #0a0d0f (substrate dark), 1 → #00ff88 (life green)
  // Mode  9 — Waste field     : 0 → #0a0d0f,                   1 → #ff6030 (alarm red)
  // Mode 10 — Pheromone field : 0 → #0a0d0f,                   1 → #cc44ff (violet)
  // Mode 11 — Alarm field     : 0 → #0a0d0f,                   1 → #ffaa00 (amber)
  //
  // The base cell rendering (cellRGB) is blended in at low opacity so the grid
  // structure remains visible, letting the viewer correlate chemistry with cells.
  if (u_renderMode >= 8 && u_renderMode <= 11) {
    float chemVal = 0.0;
    vec3  chemHigh = vec3(0.0);

    if (u_renderMode == 8) {
      chemVal  = texelFetch(u_chemNutrient,  cellCoord, 0).r;
      // Life-green (#00ff88) linearised: sRGB (0, 1, 0.533) → linear
      chemHigh = srgbToLinearVec(vec3(0.0, 1.0, 0.533));
    } else if (u_renderMode == 9) {
      chemVal  = texelFetch(u_chemWaste,     cellCoord, 0).r;
      // Alarm red (#ff6030) linearised
      chemHigh = srgbToLinearVec(vec3(1.0, 0.376, 0.188));
    } else if (u_renderMode == 10) {
      chemVal  = texelFetch(u_chemPheromone, cellCoord, 0).r;
      // GFP violet (#cc44ff) linearised
      chemHigh = srgbToLinearVec(vec3(0.800, 0.267, 1.0));
    } else {
      chemVal  = texelFetch(u_chemAlarm,     cellCoord, 0).r;
      // Amber (#ffaa00) linearised
      chemHigh = srgbToLinearVec(vec3(1.0, 0.667, 0.0));
    }

    chemVal = clamp(chemVal, 0.0, 1.0);

    // Substrate dark (#0a0d0f) as the zero-concentration baseline.
    vec3 chemLow  = srgbToLinearVec(vec3(0.039, 0.051, 0.059));
    // Gamma-curve the chemical value so low concentrations are more visible.
    float vis = pow(chemVal, 0.45);
    vec3 chemRGB = mix(chemLow, chemHigh, vis);

    // Blend in the underlying cell structure at 20% opacity so the grid is legible.
    cellRGB = mix(chemRGB, cellRGB, 0.20);
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

  // ---- Phase 22: Ambient Occlusion (Life + Spore cells only) ----------------
  //
  // Count the 8 Moore-neighbourhood cells that are occupied by Life or Spore.
  // Interior cells (high occupancy) get darkened; edge cells stay bright.
  // The effect creates a subtle depth impression that makes colony boundaries
  // visually "pop" without affecting colour hue.
  //
  // Gated on u_ambientOcclusion so it can be toggled from the Cinematic panel.
  if (u_ambientOcclusion && (cellType == 1u || cellType == 16u)) {
    int liveN = 0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        ivec2 nc  = clamp(cellCoord + ivec2(dx, dy),
                          ivec2(0), ivec2(u_gridWidth - 1, u_gridHeight - 1));
        uint  nt  = texelFetch(u_cellType, nc, 0).r;
        if (nt == 1u || nt == 16u) liveN++;
      }
    }
    // occupancy in [0, 1]; edge cells have low occupancy (edgeness near 1).
    float occupancy = float(liveN) / 8.0;
    float edgeness  = 1.0 - occupancy;
    // Interior cells (all 8 neighbours live, edgeness≈0) darken by up to 35%.
    float ao = 1.0 - 0.35 * occupancy * (1.0 - smoothstep(0.0, 0.3, edgeness));
    cellRGB *= ao;
  }

  // ---- Phase 22: Motile-cell trail glow (empty cells only) ------------------
  //
  // Each empty cell samples the trail-brightness texture written by the CPU
  // trail update (0.92× decay per frame, written at 0.8 by motile cells).
  // The trail colour is looked up from the variant palette using the stored
  // variant ID.  Trails glow at low intensity so they feed bloom.
  if (u_trails && cellType == 0u) {
    float trailB = texelFetch(u_trailBright, cellCoord, 0).r;
    if (trailB > 0.01) {
      uint  tVid      = texelFetch(u_trailVid, cellCoord, 0).r;
      vec3  trailCol  = srgbToLinearVec(
                          texelFetch(u_variantPalette, ivec2(int(tVid), 0), 0).rgb);
      // Additive blend: trail brightens the empty substrate.
      // Multiply by 0.5 so it stays subtle and doesn't overpower the background.
      cellRGB += trailCol * trailB * 0.5;
    }
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
 * Composite + tonemap pass (Pass 5) — Phase 22 extended.
 *
 * Additively blends the full-resolution HDR scene with the half-resolution
 * blurred bloom texture, then applies Reinhard extended tonemapping, optional
 * depth-of-field blur, chromatic aberration, and a vignette darkening.
 *
 * Reinhard extended formula: c * (1 + c/w²) / (1 + c)
 * where w = whitePoint = 4.0  (HDR values at 4× display-white → near-white).
 *
 * Phase 22 additions:
 *   u_depthOfField         — hexagonal 9-tap blur, radius from canvas centre.
 *   u_chromaticAberration  — per-channel UV offset at canvas edges.
 *   u_vignette             — radial darkening at the canvas perimeter.
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

/**
 * Phase 22: enable a hexagonal 9-tap depth-of-field blur.
 * Blur radius grows with distance from the canvas centre, simulating a
 * shallow depth-of-field that draws attention to the middle of the colony.
 */
uniform bool u_depthOfField;

/**
 * Phase 22: enable lateral chromatic aberration at canvas edges.
 * R, G, B channels are sampled at slightly different UV offsets proportional
 * to distance from the canvas centre — replicates a wide-angle lens artefact.
 */
uniform bool u_chromaticAberration;

/**
 * Phase 22: enable radial vignette darkening at the canvas perimeter.
 * Draws the viewer's eye toward the bright cell colony in the centre.
 */
uniform bool u_vignette;

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

/**
 * Samples the scene texture with a 9-tap hexagonal kernel for depth of field.
 * blurR is the blur radius in UV units (0 = sharp, 0.012 = heavy blur).
 *
 * Hexagonal taps give a more organic, photographic bokeh than a square grid.
 *
 * @param uv  - Centre UV coordinate to sample around.
 * @param blurR - Blur radius in UV space.
 * @returns Average RGB of the 9 samples.
 */
vec3 dofSample(vec2 uv, float blurR) {
  // Hexagonal kernel: 1 centre + 6 ring + 2 extra diagonal = 9 taps.
  const vec2 HEX[9] = vec2[](
    vec2( 0.000,  0.000),
    vec2( 1.000,  0.000),
    vec2(-1.000,  0.000),
    vec2( 0.500,  0.866),
    vec2(-0.500,  0.866),
    vec2( 0.500, -0.866),
    vec2(-0.500, -0.866),
    vec2( 0.000,  1.000),
    vec2( 0.000, -1.000)
  );
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    sum += texture(u_scene, uv + HEX[i] * blurR).rgb;
  }
  return sum / 9.0;
}

void main() {
  vec2  uv        = v_texCoord;
  vec2  fromCentre = uv - 0.5;
  float edgeDist   = dot(fromCentre, fromCentre); // in [0, 0.5] for corners

  // ---- Depth of Field -------------------------------------------------------
  // Sample the scene using a hexagonal blur kernel whose radius grows with
  // distance from the canvas centre.  The simulated "focal plane" is the
  // centre of the canvas, which is typically where the largest colony lives.
  vec3 sceneSampled;
  if (u_depthOfField) {
    // blurRadius is 0 at centre, ~0.010 at canvas corners.
    // Subtract a small dead zone (0.04) so the very centre stays pin-sharp.
    float blurRadius = max(0.0, edgeDist * 12.0 - 0.04) * 0.001;
    sceneSampled = dofSample(uv, blurRadius);
  } else {
    sceneSampled = texture(u_scene, uv).rgb;
  }
  float sceneAlpha = texture(u_scene, uv).a; // always fetch alpha at centre

  // ---- Chromatic Aberration -------------------------------------------------
  // Offset the R and B channels laterally in the direction away from centre,
  // proportional to distance from centre.  The G channel is not moved so that
  // the artefact is asymmetric and more natural-looking.
  vec3 bloom;
  if (u_chromaticAberration) {
    // ab: lateral offset direction, scaled by 0.004 and edgeDist.
    vec2 ab = fromCentre * edgeDist * 0.05;
    float bloomR = texture(u_bloom, uv + ab).r;
    float bloomG = texture(u_bloom, uv).g;
    float bloomB = texture(u_bloom, uv - ab).b;
    bloom = vec3(bloomR, bloomG, bloomB) * u_bloomStrength;

    // Also apply CA to the scene sample (different axis scale for subtlety).
    vec2 sceneAb = fromCentre * edgeDist * 0.008;
    float sR = texture(u_scene, uv + sceneAb).r;
    float sB = texture(u_scene, uv - sceneAb).b;
    sceneSampled = vec3(sR, sceneSampled.g, sB);
  } else {
    bloom = texture(u_bloom, uv).rgb * u_bloomStrength;
  }

  // Composite background behind the scene using scene alpha.
  // Empty cells (alpha = 0) fully reveal the background;
  // non-empty cells (alpha = 1) fully occlude it.
  vec3 base = sceneSampled;
  if (u_hasBackground) {
    vec3 bg = texture(u_background, uv).rgb;
    base    = mix(bg, sceneSampled, sceneAlpha);
  }

  vec3 hdr = base + bloom;
  vec3 ldr = reinhardExtended(hdr);

  // ---- Vignette -------------------------------------------------------------
  // Radial darkening at the canvas perimeter using a smoothstep roll-off.
  // The multiplier is 1.0 at the centre and falls to ~0.55 at the corners.
  if (u_vignette) {
    float vignette = 1.0 - 0.45 * smoothstep(0.20, 0.70, length(fromCentre));
    ldr *= vignette;
  }

  outColor = vec4(linearToSrgbVec(clamp(ldr, 0.0, 1.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Phase 22 — GPU particle system shader sources
// ---------------------------------------------------------------------------

/**
 * Vertex shader for the CPU-managed particle system (Phase 22).
 *
 * Each particle is stored as 8 floats in a VBO:
 *   [x, y, vx, vy, life, r, g, b]
 * where (x, y) are in grid-cell coordinates [0, gridW] × [0, gridH].
 *
 * The shader converts grid-cell coordinates to clip space and scales
 * gl_PointSize with the particle lifetime so dying particles shrink gracefully.
 * The particle colour is passed to the fragment shader via varying.
 *
 * Dead particles (life ≤ 0) are sent to clip-space corner (-2, -2) and given
 * zero size so they are outside the viewport and never rasterized.
 */
export const PARTICLE_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

/** Grid-cell X coordinate (0 = left column). */
in float a_px;
/** Grid-cell Y coordinate (0 = top row). */
in float a_py;
/** X velocity (grid-units/tick) — unused in vertex shader but kept for stride. */
in float a_vx;
/** Y velocity (grid-units/tick) — unused in vertex shader but kept for stride. */
in float a_vy;
/** Remaining lifetime in [0, 1].  0 = dead; 1 = freshly emitted. */
in float a_life;
/** Linear sRGB red channel. */
in float a_r;
/** Linear sRGB green channel. */
in float a_g;
/** Linear sRGB blue channel. */
in float a_b;

out float v_life;
out vec3  v_color;

/** Canvas pixel dimensions — used to convert cell coords → clip space. */
uniform vec2  u_particleCanvasSize;
/** Pixels per cell (u_cellSize from the main scene shader). */
uniform float u_particleCellSize;
/** Grid height in cells — needed to flip the Y axis. */
uniform int   u_particleGridH;

void main() {
  // Dead particles: shunt off-screen and skip rasterization.
  if (a_life <= 0.0) {
    gl_Position  = vec4(-2.0, -2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    v_life       = 0.0;
    v_color      = vec3(0.0);
    return;
  }

  // Grid → pixel: flip Y because grid row-0 is at the top but WebGL Y=0 is
  // at the bottom.
  float pixX = a_px * u_particleCellSize;
  float pixY = (float(u_particleGridH) - a_py) * u_particleCellSize;

  // Pixel → clip space: normalise to [−1, 1]² and centre on each axis.
  vec2 clip = (vec2(pixX, pixY) / u_particleCanvasSize) * 2.0 - 1.0;

  gl_Position  = vec4(clip, 0.0, 1.0);
  // Point size scales with lifetime: fresh particles are 3 px, dying 1 px.
  gl_PointSize = mix(1.0, 3.5, a_life);

  v_life  = a_life;
  v_color = vec3(a_r, a_g, a_b);
}
`;

/**
 * Fragment shader for the particle system (Phase 22).
 *
 * Renders each alive particle as a soft circular point sprite (gl.POINTS).
 * The colour is output as an HDR value (linear light, may exceed 1.0) so
 * bright particles (division flashes, nutrient sparks) feed the bloom
 * extraction pass and produce visible glow.
 *
 * Chromatic aberration and vignette are applied in the composite pass, not
 * here, so particles benefit from those post-processing effects automatically.
 */
export const PARTICLE_FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

in  float v_life;
in  vec3  v_color;
out vec4  outColor;

void main() {
  // gl_PointCoord: (0,0) top-left, (1,1) bottom-right of the point sprite.
  // Shift to (-0.5, 0.5)² so dist=0 at centre.
  vec2  uv   = gl_PointCoord - 0.5;
  float dist = length(uv) * 2.0;       // 0 at centre, 1 at edge

  // Soft circle: alpha = 1 at centre, 0 at edge.
  float alpha = v_life * smoothstep(1.0, 0.0, dist);
  if (alpha < 0.01) discard;

  // HDR output: multiply by 1.6 so bright particles (white division flash,
  // teal nutrient sparks) are above the bloom threshold and create visible glow.
  outColor = vec4(v_color * 1.6, alpha);
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
  /** Phase 19: R32F texture — X-axis velocity per cell. */
  private readonly _vxTex: WebGLTexture;
  /** Phase 19: R32F texture — Y-axis velocity per cell. */
  private readonly _vyTex: WebGLTexture;

  /** Phase 20: R32F texture — nutrient chemical concentration per cell. */
  private readonly _chemNutrientTex: WebGLTexture;
  /** Phase 20: R32F texture — waste chemical concentration per cell. */
  private readonly _chemWasteTex: WebGLTexture;
  /** Phase 20: R32F texture — kin pheromone concentration per cell. */
  private readonly _chemPheromoneTex: WebGLTexture;
  /** Phase 20: R32F texture — alarm pheromone concentration per cell. */
  private readonly _chemAlarmTex: WebGLTexture;

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
  private readonly _uAliveDetail!:          WebGLUniformLocation;
  /** Phase 21: uniform location for the normalised predator-genome threshold. */
  private readonly _uPredatorThreshold!:    WebGLUniformLocation;
  /** Phase 19: uniform location for the vx (X-axis velocity) R32F texture. */
  private readonly _uVx!: WebGLUniformLocation;
  /** Phase 19: uniform location for the vy (Y-axis velocity) R32F texture. */
  private readonly _uVy!: WebGLUniformLocation;
  /** Phase 20: uniform location for the chemNutrient R32F texture. */
  private readonly _uChemNutrient!: WebGLUniformLocation;
  /** Phase 20: uniform location for the chemWaste R32F texture. */
  private readonly _uChemWaste!: WebGLUniformLocation;
  /** Phase 20: uniform location for the chemPheromone R32F texture. */
  private readonly _uChemPheromone!: WebGLUniformLocation;
  /** Phase 20: uniform location for the chemAlarm R32F texture. */
  private readonly _uChemAlarm!: WebGLUniformLocation;

  /**
   * Phase 18: morphology detail level [0, 1].
   * 0 = flat squares, 1 = full circular cell anatomy.
   * Only has visual effect when cellSize >= 4px.
   */
  private _aliveDetail = 1.0;

  /**
   * Phase 21: predator genome threshold normalised to [0, 1] (Uint16 ÷ 65535).
   * 0 = predator mechanics disabled (no red highlighting in predprey mode).
   */
  private _predatorThreshold = 0.0;

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

  // --- Phase 22: Trail system -----------------------------------------------

  /**
   * CPU-side Float32Array — per-cell trail brightness [0, 1].
   * Decays by 0.92 each frame; written to 0.8 by motile cells that vacate.
   * Allocated in _resize(); null before first render.
   */
  private _trailBuf: Float32Array | null = null;

  /**
   * CPU-side Uint8Array — per-cell variant ID of the last motile occupant.
   * Used by the fragment shader to look up the trail colour from the palette.
   * Allocated in _resize(); null before first render.
   */
  private _trailVidBuf: Uint8Array | null = null;

  /** R32F GPU texture — trail brightness field (same dimensions as grid). */
  private _trailBrightTex: WebGLTexture | null = null;

  /** R8UI GPU texture — trail variant-ID field (same dimensions as grid). */
  private _trailVidTex: WebGLTexture | null = null;

  /** Uniform location for the trail-brightness sampler in the main shader. */
  private _uTrailBright: WebGLUniformLocation | null = null;

  /** Uniform location for the trail-variantId sampler in the main shader. */
  private _uTrailVid: WebGLUniformLocation | null = null;

  /** Uniform location for u_trails bool in the main shader. */
  private _uTrails: WebGLUniformLocation | null = null;

  /** Uniform location for u_ambientOcclusion bool in the main shader. */
  private _uAmbientOcclusion: WebGLUniformLocation | null = null;

  // --- Phase 22: Particle system -------------------------------------------

  /**
   * Fixed-size CPU particle pool.  Layout per particle (PARTICLE_STRIDE = 8):
   *   [0] x        — grid-cell X (float)
   *   [1] y        — grid-cell Y (float)
   *   [2] vx       — X velocity (grid-units/frame)
   *   [3] vy       — Y velocity (grid-units/frame)
   *   [4] life     — remaining lifetime [0, 1]
   *   [5] r        — linear sRGB red
   *   [6] g        — linear sRGB green
   *   [7] b        — linear sRGB blue
   *
   * Ring-buffer write head: _particleHead wraps at PARTICLE_COUNT.
   */
  private _particleBuf: Float32Array | null = null;

  /** Write head for the ring buffer (wraps at PARTICLE_COUNT). */
  private _particleHead = 0;

  /** GPU VBO holding the particle pool; uploaded each frame via bufferSubData. */
  private _particleVbo: WebGLBuffer | null = null;

  /** VAO capturing the particle VBO attribute layout (a_px … a_b). */
  private _particleVao: WebGLVertexArrayObject | null = null;

  /** Compiled particle shader program (PARTICLE_VERT_SRC + PARTICLE_FRAG_SRC). */
  private _particleProg: WebGLProgram | null = null;

  /** Uniform location: canvas pixel size vec2. */
  private _uParticleCanvasSize: WebGLUniformLocation | null = null;

  /** Uniform location: cell size float. */
  private _uParticleCellSize: WebGLUniformLocation | null = null;

  /** Uniform location: grid height int. */
  private _uParticleGridH: WebGLUniformLocation | null = null;

  // --- Phase 22: Composite cinematic uniform locations ----------------------

  /** Uniform location for u_depthOfField in the composite program. */
  private _uCompositeDof: WebGLUniformLocation | null = null;

  /** Uniform location for u_chromaticAberration in the composite program. */
  private _uCompositeCa: WebGLUniformLocation | null = null;

  /** Uniform location for u_vignette in the composite program. */
  private _uCompositeVignette: WebGLUniformLocation | null = null;

  // --- Phase 22: Cinematic state flags -------------------------------------

  /**
   * When true, interior cells of clusters are subtly darkened (AO).
   * Default true for atmospheric depth; toggle via Cinematic panel.
   */
  private _ambientOcclusion = true;

  /**
   * When true, motile-cell trail glow is rendered on empty cells.
   * Disabled automatically on low-end hardware (hardwareConcurrency < 4).
   */
  private _trails = true;

  /**
   * When true, the CPU particle system emits and renders particles.
   * Disabled automatically on low-end hardware (hardwareConcurrency < 4).
   */
  private _particles = true;

  /**
   * When true, the composite pass applies a hexagonal depth-of-field blur
   * that softens the canvas edges relative to the centre.
   * Disabled by default; high visual impact when combined with vignette.
   */
  private _depthOfField = false;

  /**
   * When true, the composite pass applies lateral chromatic aberration
   * proportional to distance from the canvas centre.
   * Disabled by default.
   */
  private _chromaticAberration = false;

  /**
   * When true, the composite pass darkens the canvas perimeter.
   * Default true — the vignette strongly focuses attention on the colony.
   */
  private _vignette = true;

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
    this._uAliveDetail         = this._requireUniform('u_aliveDetail');
    // Phase 21: predator genome threshold for predprey render mode.
    this._uPredatorThreshold   = this._requireUniform('u_predatorThreshold');
    // Phase 19: velocity texture samplers for flagellum rendering.
    this._uVx              = this._requireUniform('u_vx');
    this._uVy              = this._requireUniform('u_vy');
    // Phase 20: chemical ecology texture samplers.
    this._uChemNutrient    = this._requireUniform('u_chemNutrient');
    this._uChemWaste       = this._requireUniform('u_chemWaste');
    this._uChemPheromone   = this._requireUniform('u_chemPheromone');
    this._uChemAlarm       = this._requireUniform('u_chemAlarm');
    // Phase 22: cinematic effect uniforms in the main scene shader.
    this._uAmbientOcclusion = this._requireUniform('u_ambientOcclusion');
    this._uTrailBright      = this._requireUniform('u_trailBright');
    this._uTrailVid         = this._requireUniform('u_trailVid');
    this._uTrails           = this._requireUniform('u_trails');

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
      // Phase 22: cinematic effect uniform locations in the composite program.
      this._uCompositeDof      = this._requireUniformIn(this._compositeProg,    'u_depthOfField');
      this._uCompositeCa       = this._requireUniformIn(this._compositeProg,    'u_chromaticAberration');
      this._uCompositeVignette = this._requireUniformIn(this._compositeProg,    'u_vignette');

      // Phase 22: particle system — only when HDR pipeline is available so
      // particles can be rendered into the RGBA16F FBO and feed bloom.
      this._initParticleSystem();

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

    // --- Phase 22: Trail textures (allocated empty; resized on first render) --
    // Created unconditionally so the scene shader always has valid samplers.
    this._trailBrightTex = this._createTexture();
    this._trailVidTex    = this._createTexture();

    // Auto-disable expensive cinematic effects on low-end hardware.
    // hardwareConcurrency < 4 signals a device with limited CPU/GPU bandwidth.
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency < 4) {
      this._particles          = false;
      this._trails             = false;
      this._depthOfField       = false;
      this._chromaticAberration = false;
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
    // Phase 19: velocity textures (allocated empty; filled on first render).
    this._vxTex             = this._createTexture();
    this._vyTex             = this._createTexture();
    // Phase 20: chemical ecology textures (allocated empty; filled on first render).
    this._chemNutrientTex  = this._createTexture();
    this._chemWasteTex     = this._createTexture();
    this._chemPheromoneTex = this._createTexture();
    this._chemAlarmTex     = this._createTexture();

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

  /**
   * Phase 21: returns the predator genome threshold as a normalised [0, 1] float.
   * Used by the predprey render mode to classify Life cells as predator vs prey.
   *
   * @returns Normalised threshold (raw Uint16 ÷ 65535).  0 = disabled.
   */
  get predatorThreshold(): number {
    return this._predatorThreshold;
  }

  /**
   * Sets the predator genome threshold.  Takes effect on the next render call.
   *
   * @param rawUint16 - Raw genome threshold as a Uint16 integer [0, 65535].
   *                    Internally normalised to [0, 1] for the shader.
   */
  set predatorThreshold(rawUint16: number) {
    this._predatorThreshold = rawUint16 / 65535;
  }

  get renderMode(): 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal' | 'morphology' | 'nutrient-field' | 'waste-field' | 'pheromone-field' | 'alarm-field' | 'predprey' {
    if (this._renderMode === 1)  return 'lifecycle';
    if (this._renderMode === 2)  return 'variantId';
    if (this._renderMode === 3)  return 'genome';
    if (this._renderMode === 4)  return 'generation';
    if (this._renderMode === 5)  return 'fitness';
    if (this._renderMode === 6)  return 'signal';
    if (this._renderMode === 7)  return 'morphology';
    if (this._renderMode === 8)  return 'nutrient-field';
    if (this._renderMode === 9)  return 'waste-field';
    if (this._renderMode === 10) return 'pheromone-field';
    if (this._renderMode === 11) return 'alarm-field';
    if (this._renderMode === 12) return 'predprey';
    return 'default';
  }

  /**
   * Changes the render mode.  Takes effect on the next {@link render} call.
   *
   * @param mode - New render mode string.
   */
  set renderMode(mode: 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal' | 'morphology' | 'nutrient-field' | 'waste-field' | 'pheromone-field' | 'alarm-field' | 'predprey') {
    if (mode === 'lifecycle')          { this._renderMode = 1; }
    else if (mode === 'variantId')     { this._renderMode = 2; }
    else if (mode === 'genome')        { this._renderMode = 3; }
    else if (mode === 'generation')    { this._renderMode = 4; }
    else if (mode === 'fitness')       { this._renderMode = 5; }
    else if (mode === 'signal')        { this._renderMode = 6; }
    else if (mode === 'morphology')    { this._renderMode = 7; }
    else if (mode === 'nutrient-field')   { this._renderMode = 8; }
    else if (mode === 'waste-field')      { this._renderMode = 9; }
    else if (mode === 'pheromone-field')  { this._renderMode = 10; }
    else if (mode === 'alarm-field')      { this._renderMode = 11; }
    else if (mode === 'predprey')         { this._renderMode = 12; }
    else                               { this._renderMode = 0; }
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

  // --- Phase 22: Cinematic effect setters -----------------------------------

  /**
   * Enables or disables ambient occlusion darkening on Life and Spore cells.
   * AO has no GPU-cost overhead — it is a GLSL-only loop over 8 neighbours.
   *
   * @param enabled - True to darken interior cluster cells.
   */
  set ambientOcclusion(enabled: boolean) {
    this._ambientOcclusion = enabled;
  }

  /** Current ambient occlusion state. */
  get ambientOcclusion(): boolean {
    return this._ambientOcclusion;
  }

  /**
   * Enables or disables the motile-cell trail glow on empty cells.
   * When enabled, the CPU trail buffer is updated every frame and uploaded as
   * two GPU textures (R32F brightness + R8UI variantId).
   *
   * @param enabled - True to show trail glow.
   */
  set trails(enabled: boolean) {
    this._trails = enabled;
  }

  /** Current trail state. */
  get trails(): boolean {
    return this._trails;
  }

  /**
   * Enables or disables the GPU particle system.
   * When enabled, particles are emitted from simulation events and rendered
   * into the HDR FBO before bloom extraction.
   *
   * @param enabled - True to show particles.
   */
  set particles(enabled: boolean) {
    this._particles = enabled;
  }

  /** Current particle state. */
  get particles(): boolean {
    return this._particles;
  }

  /**
   * Enables or disables depth-of-field blur in the composite pass.
   * DoF adds ~9 texture samples per fragment — keep disabled on low-end GPUs.
   *
   * @param enabled - True to apply hexagonal DoF blur.
   */
  set depthOfField(enabled: boolean) {
    this._depthOfField = enabled;
  }

  /** Current depth-of-field state. */
  get depthOfField(): boolean {
    return this._depthOfField;
  }

  /**
   * Enables or disables lateral chromatic aberration in the composite pass.
   * Purely a shader computation — negligible performance cost.
   *
   * @param enabled - True to apply RGB channel offset at canvas edges.
   */
  set chromaticAberration(enabled: boolean) {
    this._chromaticAberration = enabled;
  }

  /** Current chromatic aberration state. */
  get chromaticAberration(): boolean {
    return this._chromaticAberration;
  }

  /**
   * Enables or disables the vignette darkening in the composite pass.
   * Purely a shader computation — negligible performance cost.
   *
   * @param enabled - True to darken the canvas perimeter.
   */
  set vignette(enabled: boolean) {
    this._vignette = enabled;
  }

  /** Current vignette state. */
  get vignette(): boolean {
    return this._vignette;
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

    // --- Upload vx texture (R32F, Phase 19) -----------------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._vxTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED,
      gl.FLOAT,
      buffers.vx,
    );

    // --- Upload vy texture (R32F, Phase 19) -----------------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._vyTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0, 0,
      width, height,
      gl.RED,
      gl.FLOAT,
      buffers.vy,
    );

    // --- Upload chemNutrient texture (R32F, Phase 20) --------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._chemNutrientTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, buffers.chemNutrient);

    // --- Upload chemWaste texture (R32F, Phase 20) ----------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._chemWasteTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, buffers.chemWaste);

    // --- Upload chemPheromone texture (R32F, Phase 20) ------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._chemPheromoneTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, buffers.chemPheromone);

    // --- Upload chemAlarm texture (R32F, Phase 20) ----------------------------
    gl.bindTexture(gl.TEXTURE_2D, this._chemAlarmTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, buffers.chemAlarm);

    // --- Phase 22: Update trail CPU buffers and upload to GPU textures --------
    // Must happen before the draw call so trail data is current this frame.
    if (this._trails) {
      this._updateTrails(buffers, width, height);
    }

    // --- Phase 22: Update particle pool (physics + emission) -----------------
    // Uploads the updated VBO to the GPU; actual rendering happens in
    // _drawHDRPipeline() after the scene pass so particles feed bloom.
    if (this._particles && this._bloomEnabled) {
      this._updateParticles(buffers, width, height);
    }

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

    // Bind vx texture to texture unit 8 (Phase 19).
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this._vxTex);
    gl.uniform1i(this._uVx, 8);

    // Bind vy texture to texture unit 9 (Phase 19).
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, this._vyTex);
    gl.uniform1i(this._uVy, 9);

    // Bind chemNutrient texture to texture unit 10 (Phase 20).
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, this._chemNutrientTex);
    gl.uniform1i(this._uChemNutrient, 10);

    // Bind chemWaste texture to texture unit 11 (Phase 20).
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, this._chemWasteTex);
    gl.uniform1i(this._uChemWaste, 11);

    // Bind chemPheromone texture to texture unit 12 (Phase 20).
    gl.activeTexture(gl.TEXTURE12);
    gl.bindTexture(gl.TEXTURE_2D, this._chemPheromoneTex);
    gl.uniform1i(this._uChemPheromone, 12);

    // Bind chemAlarm texture to texture unit 13 (Phase 20).
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, this._chemAlarmTex);
    gl.uniform1i(this._uChemAlarm, 13);

    // Per-frame uniforms.
    gl.uniform1f(this._uCellSize,      this._cellSize);
    gl.uniform1i(this._uGridWidth,     width);
    gl.uniform1i(this._uGridHeight,    height);
    gl.uniform1i(this._uShowGridLines, this._showGridLines ? 1 : 0);
    gl.uniform1i(this._uRenderMode,    this._renderMode);
    gl.uniform1i(this._uTime,          this._frame);
    gl.uniform1f(this._uAliveDetail,        this._aliveDetail);
    // Phase 21: normalised predator threshold (0 = disabled).
    gl.uniform1f(this._uPredatorThreshold,  this._predatorThreshold);

    // Phase 22: cinematic booleans for the scene shader.
    gl.uniform1i(this._uAmbientOcclusion!, this._ambientOcclusion ? 1 : 0);
    gl.uniform1i(this._uTrails!,           this._trails ? 1 : 0);

    // Bind trail textures to units 14 and 15.
    gl.activeTexture(gl.TEXTURE14);
    gl.bindTexture(gl.TEXTURE_2D, this._trailBrightTex);
    gl.uniform1i(this._uTrailBright!, 14);
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, this._trailVidTex);
    gl.uniform1i(this._uTrailVid!, 15);

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
    // Phase 19: velocity textures (R32F).
    this._allocateTexture(this._vxTex,             width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    this._allocateTexture(this._vyTex,             width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    // Phase 20: chemical ecology textures (R32F) — one per channel.
    this._allocateTexture(this._chemNutrientTex,  width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    this._allocateTexture(this._chemWasteTex,     width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    this._allocateTexture(this._chemPheromoneTex, width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    this._allocateTexture(this._chemAlarmTex,     width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    // Note: _variantPaletteTex is 256×1 and never resizes — skip here.

    // Phase 22: trail textures (resized with the grid).
    // Reallocate CPU trail buffers when grid dimensions change.
    const totalCells = width * height;
    this._trailBuf    = new Float32Array(totalCells);
    this._trailVidBuf = new Uint8Array(totalCells);
    if (this._trailBrightTex !== null) {
      this._allocateTexture(this._trailBrightTex, width, height, gl.R32F,  gl.RED,         gl.FLOAT);
    }
    if (this._trailVidTex !== null) {
      this._allocateTexture(this._trailVidTex,    width, height, gl.R8UI,  gl.RED_INTEGER, gl.UNSIGNED_BYTE);
    }

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

    // --- Pass 1b (Phase 22): Render particles into HDR FBO (additive) --------
    // The HDR FBO is still bound from Pass 1.  Particles are rendered with
    // additive blending so they brighten the scene and feed bloom extraction.
    if (this._particles) {
      this._renderParticles(cW, cH);
    }

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

    // Phase 22: cinematic post-processing toggles for the composite shader.
    gl.uniform1i(this._uCompositeDof!,      this._depthOfField        ? 1 : 0);
    gl.uniform1i(this._uCompositeCa!,       this._chromaticAberration ? 1 : 0);
    gl.uniform1i(this._uCompositeVignette!, this._vignette             ? 1 : 0);

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

  // ---------------------------------------------------------------------------
  // Phase 22 — Trail system helpers
  // ---------------------------------------------------------------------------

  /**
   * Updates the CPU trail buffers for the current frame, then uploads them to
   * the GPU as R32F (brightness) and R8UI (variantId) textures.
   *
   * Called every render frame from `render()` when `_trails` is enabled.
   * The CPU update is O(totalCells) but each iteration is a simple multiply or
   * branch, keeping total cost under 1 ms at 512×512.
   *
   * @param buffers - Current simulation front-buffer (read-only).
   * @param width   - Grid width in cells.
   * @param height  - Grid height in cells.
   */
  private _updateTrails(buffers: GridBuffers, width: number, height: number): void {
    const gl         = this._gl;
    const totalCells = width * height;

    if (this._trailBuf === null || this._trailVidBuf === null) return;

    const trailBuf    = this._trailBuf;
    const trailVidBuf = this._trailVidBuf;

    // --- Decay existing trail brightness by 0.92× per frame -----------------
    for (let i = 0; i < totalCells; i++) {
      const b = trailBuf[i] * 0.92;
      // Clamp tiny values to zero to stop infinitesimal long-lived trails.
      trailBuf[i] = b < 0.008 ? 0 : b;
    }

    // --- Write trail at positions of motile cells ----------------------------
    // A cell is considered motile when its velocity magnitude exceeds 0.05
    // grid-units/tick.  We write to the position the cell currently occupies
    // (not the vacated position) so the trail "leads" slightly ahead — this
    // looks better than trailing behind because most motile cells are still
    // near where they just were.
    const vx = buffers.vx;
    const vy = buffers.vy;
    const ct = buffers.cellType;
    const vi = buffers.variantId;

    for (let i = 0; i < totalCells; i++) {
      // Only Life cells (type 1) can be motile.
      if (ct[i] !== 1) continue;
      const vmag = Math.abs(vx[i]) + Math.abs(vy[i]); // Manhattan approx is fast
      if (vmag > 0.05) {
        // Clamp so repeated writes don't perpetually max out the brightness.
        trailBuf[i]    = Math.min(1.0, trailBuf[i] + 0.8);
        trailVidBuf[i] = vi[i];
      }
    }

    // --- Upload brightness texture (R32F) ------------------------------------
    if (this._trailBrightTex !== null) {
      gl.bindTexture(gl.TEXTURE_2D, this._trailBrightTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        width, height,
        gl.RED, gl.FLOAT, trailBuf,
      );
    }

    // --- Upload variantId texture (R8UI) -------------------------------------
    if (this._trailVidTex !== null) {
      gl.bindTexture(gl.TEXTURE_2D, this._trailVidTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        width, height,
        gl.RED_INTEGER, gl.UNSIGNED_BYTE, trailVidBuf,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 22 — Particle system helpers
  // ---------------------------------------------------------------------------

  /** Number of floats per particle in the VBO. */
  private static readonly PARTICLE_STRIDE = 8;

  /** Maximum simultaneous live particles in the ring buffer. */
  private static readonly PARTICLE_COUNT = 65_536;

  /**
   * Initialises the GPU particle system: compiles the particle shaders,
   * creates the dynamic VBO, and sets up the VAO attribute layout.
   *
   * Called from the constructor only when `EXT_color_buffer_float` is
   * available (HDR pipeline active) so particles always render into the
   * RGBA16F HDR FBO and benefit from the bloom pass.
   */
  private _initParticleSystem(): void {
    const gl = this._gl;

    // Allocate the CPU-side ring buffer (cleared to zero = all particles dead).
    this._particleBuf  = new Float32Array(
      WebGLRenderer.PARTICLE_COUNT * WebGLRenderer.PARTICLE_STRIDE,
    );
    this._particleHead = 0;

    // Compile the particle shader program.
    this._particleProg = this._createProgram(PARTICLE_VERT_SRC, PARTICLE_FRAG_SRC);

    // Cache uniform locations.
    this._uParticleCanvasSize = this._requireUniformIn(this._particleProg, 'u_particleCanvasSize');
    this._uParticleCellSize   = this._requireUniformIn(this._particleProg, 'u_particleCellSize');
    this._uParticleGridH      = this._requireUniformIn(this._particleProg, 'u_particleGridH');

    // Create the dynamic VBO for particle data.  DYNAMIC_DRAW signals to the
    // driver that the buffer content changes every frame.
    const vbo = gl.createBuffer();
    if (vbo === null) throw new Error('WebGLRenderer: particle VBO creation failed.');
    this._particleVbo = vbo;

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this._particleBuf,
      gl.DYNAMIC_DRAW,
    );

    // Set up the VAO with attribute pointers.
    // Layout (STRIDE = 8 floats = 32 bytes per particle):
    //   offset  0: a_px  (1 float)
    //   offset  4: a_py  (1 float)
    //   offset  8: a_vx  (1 float)
    //   offset 12: a_vy  (1 float)
    //   offset 16: a_life(1 float)
    //   offset 20: a_r   (1 float)
    //   offset 24: a_g   (1 float)
    //   offset 28: a_b   (1 float)
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('WebGLRenderer: particle VAO creation failed.');
    this._particleVao = vao;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    const stride = WebGLRenderer.PARTICLE_STRIDE * Float32Array.BYTES_PER_ELEMENT; // 32 bytes

    const bindAttr = (name: string, offset: number): void => {
      const loc = gl.getAttribLocation(this._particleProg!, name);
      if (loc === -1) return; // shader may not expose unused attrs
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
    };

    bindAttr('a_px',   0);
    bindAttr('a_py',   1);
    bindAttr('a_vx',   2);
    bindAttr('a_vy',   3);
    bindAttr('a_life', 4);
    bindAttr('a_r',    5);
    bindAttr('a_g',    6);
    bindAttr('a_b',    7);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(null);
  }

  /**
   * Emits one particle into the ring buffer, overwriting the oldest entry.
   *
   * @param x    - Grid-cell X coordinate.
   * @param y    - Grid-cell Y coordinate.
   * @param vx   - Initial X velocity in grid-units/frame.
   * @param vy   - Initial Y velocity in grid-units/frame.
   * @param life - Initial lifetime [0, 1].
   * @param r    - Linear sRGB red channel [0, 1+].
   * @param g    - Linear sRGB green channel.
   * @param b    - Linear sRGB blue channel.
   */
  private _emitParticle(
    x: number, y: number,
    vx: number, vy: number,
    life: number,
    r: number, g: number, b: number,
  ): void {
    if (this._particleBuf === null) return;

    const base = this._particleHead * WebGLRenderer.PARTICLE_STRIDE;
    const buf  = this._particleBuf;

    buf[base + 0] = x;
    buf[base + 1] = y;
    buf[base + 2] = vx;
    buf[base + 3] = vy;
    buf[base + 4] = life;
    buf[base + 5] = r;
    buf[base + 6] = g;
    buf[base + 7] = b;

    // Advance ring-buffer write head.
    this._particleHead = (this._particleHead + 1) % WebGLRenderer.PARTICLE_COUNT;
  }

  /**
   * Updates the CPU particle pool (moves particles, decays lifetimes) and
   * emits new particles based on the current simulation state.
   *
   * Emission rules (one particle type per simulation event):
   *   Type 0 — Nutrient drift   : teal sparks float up from Nutrient cells.
   *   Type 1 — Division flash   : white burst from JUST_DIVIDED Life cells.
   *   Type 2 — Death exhaust    : grey wisps from dying (energy < 0.05) cells.
   *   Type 3 — Pheromone trail  : faint cyan pulses from quorum-active cells.
   *   Type 4 — Alarm scatter    : orange sparks from cells with high alarm chem.
   *
   * After updating, the full buffer is uploaded to the GPU VBO via
   * `bufferSubData` (the VBO is DYNAMIC_DRAW).
   *
   * @param buffers - Current simulation front-buffer (read-only).
   * @param width   - Grid width in cells.
   * @param height  - Grid height in cells.
   */
  private _updateParticles(buffers: GridBuffers, width: number, height: number): void {
    if (this._particleBuf === null || this._particleVbo === null) return;

    const gl         = this._gl;
    const buf        = this._particleBuf;
    const stride     = WebGLRenderer.PARTICLE_STRIDE;
    const totalCells = width * height;

    // --- Step 1: CPU physics update for all alive particles -------------------
    // Move each particle by its velocity, apply gravity, and decay lifetime.
    for (let i = 0; i < WebGLRenderer.PARTICLE_COUNT; i++) {
      const base = i * stride;
      if (buf[base + 4] <= 0) continue; // dead particle — skip

      buf[base + 0] += buf[base + 2]; // x += vx
      buf[base + 1] += buf[base + 3]; // y += vy

      // Gentle gravity + drag on Y-axis.
      buf[base + 3] -= 0.003;  // gravitational pull downward
      buf[base + 2] *= 0.96;   // X drag
      buf[base + 3] *= 0.96;   // Y drag

      // Lifetime decay — rate varies: fast for flashes, slow for drift.
      buf[base + 4] -= 0.016;
      if (buf[base + 4] < 0) buf[base + 4] = 0;
    }

    // --- Step 2: Emission scan — one pass over the simulation grid -----------
    // Only emit on a fraction of frames to spread the burst budget over time.
    // Also skip if particle budget is already heavily saturated.
    const SCAN_FRACTION  = 0.15; // scan ~15 % of cells per frame (random subset)
    const scanStep       = Math.max(1, Math.round(1 / SCAN_FRACTION));

    for (let i = 0; i < totalCells; i += scanStep) {
      const cellX = i % width;
      const cellY = Math.floor(i / width);
      const ct    = buffers.cellType[i];
      const flags = buffers.flags[i];
      const en    = buffers.energy[i];

      // --- Type 0: Nutrient drift — teal sparks float up from Nutrient cells --
      if (ct === 4 && Math.random() < 0.05) {
        this._emitParticle(
          cellX + Math.random(),
          cellY - 0.2,
          (Math.random() - 0.5) * 0.08,
          -(0.1 + Math.random() * 0.25), // upward
          0.4 + Math.random() * 0.4,
          0.0, 0.85, 0.95,  // teal (#00d9f2 approx, linear)
        );
      }

      // --- Type 1: Division flash — white burst on JUST_DIVIDED cells ---------
      // Flag bit 7 (0x80) = JUST_DIVIDED set in SimulationEngine.
      if (ct === 1 && (flags & 0x80) !== 0) {
        for (let j = 0; j < 6; j++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = 0.2 + Math.random() * 0.5;
          this._emitParticle(
            cellX + 0.5, cellY + 0.5,
            Math.cos(angle) * speed,
            Math.sin(angle) * speed,
            0.25 + Math.random() * 0.2,
            1.2, 1.2, 1.2, // super-white → strong bloom
          );
        }
      }

      // --- Type 2: Death exhaust — grey wisps from dying Life cells -----------
      if (ct === 1 && en < 0.05 && Math.random() < 0.08) {
        this._emitParticle(
          cellX + Math.random(),
          cellY + Math.random(),
          (Math.random() - 0.5) * 0.05,
          -(Math.random() * 0.15), // rise slowly
          0.3 + Math.random() * 0.3,
          0.18, 0.20, 0.22, // dark grey
        );
      }

      // --- Type 3: Quorum pulse — cyan ring from quorum-active cells ----------
      // Flag bit 5 (0x20) = QUORUM_ACTIVE / SIGNALING.
      if (ct === 1 && (flags & 0x20) !== 0 && Math.random() < 0.03) {
        const angle = Math.random() * Math.PI * 2;
        this._emitParticle(
          cellX + 0.5 + Math.cos(angle) * 0.5,
          cellY + 0.5 + Math.sin(angle) * 0.5,
          Math.cos(angle) * 0.15,
          Math.sin(angle) * 0.15,
          0.5 + Math.random() * 0.3,
          0.0, 0.80, 0.95, // GFP cyan
        );
      }

      // --- Type 4: Alarm scatter — orange sparks from high-alarm regions ------
      if (ct === 1 && buffers.chemAlarm[i] > 0.5 && Math.random() < 0.04) {
        const angle = Math.random() * Math.PI * 2;
        this._emitParticle(
          cellX + Math.random(),
          cellY + Math.random(),
          Math.cos(angle) * 0.3,
          Math.sin(angle) * 0.3 - 0.1,
          0.2 + Math.random() * 0.2,
          1.0, 0.45, 0.0, // orange-red (#ff7200 approx)
        );
      }
    }

    // --- Step 3: Upload updated particle pool to GPU VBO ---------------------
    gl.bindBuffer(gl.ARRAY_BUFFER, this._particleVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Renders all alive particles as point sprites into the currently-bound
   * RGBA16F HDR framebuffer using additive blending.
   *
   * Additive blending ensures that overlapping particles brighten the scene
   * instead of occluding each other, and that bright particles (division
   * flashes) exceed the bloom threshold and produce visible glow.
   *
   * @param width  - Canvas pixel width.
   * @param height - Canvas pixel height.
   */
  private _renderParticles(width: number, height: number): void {
    if (
      this._particleProg === null ||
      this._particleVao  === null ||
      this._particleBuf  === null
    ) return;

    const gl = this._gl;

    gl.useProgram(this._particleProg);
    gl.uniform2f(this._uParticleCanvasSize!, width, height);
    gl.uniform1f(this._uParticleCellSize!,   this._cellSize);
    gl.uniform1i(this._uParticleGridH!,      this._gridHeight);

    // Additive blend: particles brighten whatever is behind them.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.bindVertexArray(this._particleVao);
    gl.drawArrays(gl.POINTS, 0, WebGLRenderer.PARTICLE_COUNT);
    gl.bindVertexArray(null);

    // Restore default blend state (GL_ONE, GL_ZERO = opaque).
    gl.disable(gl.BLEND);

    gl.useProgram(null);
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
