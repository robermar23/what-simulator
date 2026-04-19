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
const FRAG_SRC = /* glsl */ `#version 300 es
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

// --- Output -----------------------------------------------------------------
out vec4 outColor;

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
  // ---- Round 1 types (0–10) ------------------------------------------------
  // 0  Empty        #0a0a12
  if (t ==  0u) return vec3(0.0392, 0.0392, 0.0706);
  // 1  Life A       #00ff88
  if (t ==  1u) return vec3(0.0,    1.0,    0.5333);
  // 2  Wall         #3a3a3a
  if (t ==  2u) return vec3(0.2275, 0.2275, 0.2275);
  // 3  Toxin        #cc00ff
  if (t ==  3u) return vec3(0.8,    0.0,    1.0);
  // 4  Nutrient     #00cc44
  if (t ==  4u) return vec3(0.0,    0.8,    0.2667);
  // 5  Drain        #0044cc
  if (t ==  5u) return vec3(0.0,    0.2667, 0.8);
  // 6  GravityWell  #ff8800
  if (t ==  6u) return vec3(1.0,    0.5333, 0.0);
  // 7  Barrier      #ffee00
  if (t ==  7u) return vec3(1.0,    0.9333, 0.0);
  // 8  Fire         #ff4400
  if (t ==  8u) return vec3(1.0,    0.2667, 0.0);
  // 9  Ice          #aaddff
  if (t ==  9u) return vec3(0.6667, 0.8667, 1.0);
  // 10 LifeVariant  #ffdd00
  if (t == 10u) return vec3(1.0,    0.8667, 0.0);

  // ---- Round 2 types (11–15) -----------------------------------------------
  // 11 Mutagen     #ff00cc — pulsing magenta
  if (t == 11u) return vec3(1.0,    0.0,    0.8);
  // 12 RadioWaste  #99ff00 — sickly green-yellow
  if (t == 12u) return vec3(0.6,    1.0,    0.0);
  // 13 Antibiotic  #f0f0f0 — white crystalline
  if (t == 13u) return vec3(0.9412, 0.9412, 0.9412);
  // 14 Rewinder    #4488ff — blue-silver
  if (t == 14u) return vec3(0.2667, 0.5333, 1.0);
  // 15 Colony      #ffaa22 — warm amber
  if (t == 15u) return vec3(1.0,    0.6667, 0.1333);

  return vec3(0.0); // unknown type — invisible black
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
  if (t ==  7u) return 0.0;    // Barrier (fades to invisible)
  if (t ==  8u) return 0.1;    // Fire
  if (t == 10u) return 0.15;   // Life Variant B
  if (t == 11u) return 0.25;   // Mutagen (dims as it depletes)
  if (t == 15u) return 0.4;    // Colony (dims when energy is low)
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
      // Bright lime — slightly dimmed at low energy but never fully dark.
      float e = max(0.3, energy);
      cellRGB = vec3(0.2667 * e, 1.0 * e, 0.5333 * e);
    } else if (isSenescent) {
      // Purple-pink — fixed dim tone to signal ageing.
      cellRGB = vec3(0.8, 0.2667, 0.7333);
    } else {
      // Mature — same energy-modulated green as the default Life colour.
      float brightness = 0.15 + 0.85 * clamp(energy, 0.0, 1.0);
      cellRGB = vec3(0.0, 1.0, 0.5333) * brightness;
    }

  } else if (u_renderMode == 2 && isLife) {
    // ---- VariantId render mode (Phase 11) — Life/LifeVariant only ----------
    vec3 paletteRGB = texelFetch(u_variantPalette, ivec2(int(vid), 0), 0).rgb;
    float brightness = 0.15 + 0.85 * clamp(energy, 0.0, 1.0);
    cellRGB = paletteRGB * brightness;

  } else if (u_renderMode == 3 && isLife) {
    // ---- Genome render mode (Phase 12) — Life/LifeVariant only -------------
    // 16-bit genome normalised to [0,1]; blue at 0, green at neutral (~0.47), red at 1.
    uint genomeVal = texelFetch(u_genome, cellCoord, 0).r;
    float t        = float(genomeVal) / 65535.0;
    // Hue 240→120→0 as t goes 0→0.47→1; simplified via component lerp.
    float rC = clamp(t * 2.0 - 1.0, 0.0, 1.0);         // 0 until mid, then rises
    float gC = 1.0 - abs(t - 0.5) * 2.0;               // peaks at midpoint
    float bC = clamp(1.0 - t * 2.0, 0.0, 1.0);         // full at 0, fades to 0
    float bright = 0.15 + 0.85 * clamp(energy, 0.0, 1.0);
    cellRGB = vec3(rC, gC, bC) * bright;

  } else if (u_renderMode == 4 && isLife) {
    // ---- Generation render mode (Phase 12) — Life/LifeVariant only ---------
    // Young (gen=0) → cyan (#00ccff); old (gen≥500) → amber (#ffaa22).
    uint genVal = texelFetch(u_generation, cellCoord, 0).r;
    float t     = clamp(float(genVal) / 500.0, 0.0, 1.0);
    float bright = 0.2 + 0.8 * clamp(energy, 0.0, 1.0);
    vec3 young  = vec3(0.0,  0.8,  1.0);   // cyan
    vec3 old    = vec3(1.0,  0.667, 0.133); // amber
    cellRGB = mix(young, old, t) * bright;

  } else if (u_renderMode == 5 && isLife) {
    // ---- Fitness render mode (Phase 12) — Life/LifeVariant only ------------
    // Uses energy as a fitness proxy: low → dark olive, high → vivid gold.
    float fit = clamp(energy, 0.0, 1.0);
    vec3 lo   = vec3(0.2,  0.267, 0.0);   // dark olive
    vec3 hi   = vec3(1.0,  0.867, 0.0);   // vivid gold
    cellRGB = mix(lo, hi, fit);

  } else {
    // ---- Default render mode: cellType + energy → colour -------------------
    vec3 base = baseColor(cellType);
    float brightness;
    if (isEnergyModulated(cellType)) {
      float minB = minBrightness(cellType);
      brightness = minB + (1.0 - minB) * clamp(energy, 0.0, 1.0);
    } else {
      brightness = 1.0;
    }
    cellRGB = base * brightness;
  }

  // ---- Signal overlay (Phase 12) — applied in signal render mode ------------
  // Blends the cell's computed colour with vivid cyan (#00eeff) proportional
  // to the cell's signalStrength.  This reveals Colony chemical signal fields.
  if (u_renderMode == 6) {
    float sig = texelFetch(u_signalStrength, cellCoord, 0).r;
    sig = clamp(sig, 0.0, 1.0);
    vec3 cyanGlow = vec3(0.0, 0.933, 1.0); // #00eeff
    cellRGB = mix(cellRGB, cyanGlow, sig);
  }

  // ---- Grid-line overlay (Phase 6 feature, replicated in WebGL) -------------
  //
  // Draw a subtle white overlay at cell boundaries.  The boundary is defined
  // as the first pixel of each cell (sub-pixel fraction < 1/cellSize).

  if (u_showGridLines && u_cellSize >= 2.0) {
    vec2 inCell = fract(gl_FragCoord.xy / u_cellSize);
    float gridAlpha = 0.08;
    if (inCell.x < (1.0 / u_cellSize) || inCell.y < (1.0 / u_cellSize)) {
      cellRGB = cellRGB + vec3(gridAlpha);
    }
  }

  outColor = vec4(clamp(cellRGB, 0.0, 1.0), 1.0);
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

    // --- Fullscreen quad geometry ---------------------------------------------
    this._vbo = this._createQuadBuffer();
    this._vao = this._createVAO(this._vbo);

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
  get renderMode(): 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal' {
    if (this._renderMode === 1) return 'lifecycle';
    if (this._renderMode === 2) return 'variantId';
    if (this._renderMode === 3) return 'genome';
    if (this._renderMode === 4) return 'generation';
    if (this._renderMode === 5) return 'fitness';
    if (this._renderMode === 6) return 'signal';
    return 'default';
  }

  /**
   * Changes the render mode.  Takes effect on the next {@link render} call.
   *
   * @param mode - New render mode string.
   */
  set renderMode(mode: 'default' | 'lifecycle' | 'variantId' | 'genome' | 'generation' | 'fitness' | 'signal') {
    if (mode === 'lifecycle')   { this._renderMode = 1; }
    else if (mode === 'variantId')  { this._renderMode = 2; }
    else if (mode === 'genome')     { this._renderMode = 3; }
    else if (mode === 'generation') { this._renderMode = 4; }
    else if (mode === 'fitness')    { this._renderMode = 5; }
    else if (mode === 'signal')     { this._renderMode = 6; }
    else                            { this._renderMode = 0; }
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

    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
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
    const canvasW  = width  * this._cellSize;
    const canvasH  = height * this._cellSize;

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
