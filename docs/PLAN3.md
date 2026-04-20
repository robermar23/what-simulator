# Phase 16 — HDR + Color Science Implementation Plan

## Vision

Move the What Simulator beyond standard 8-bit sRGB rendering toward a high-dynamic-range,
perceptually-correct color pipeline. The result is a simulation that looks like biology under
a microscope — glowing, atmospheric, and physically plausible — rather than a flat pixel art grid.

---

## Background: What Is Actually Limiting Realism

### What the current system is

The renderer is **NOT** limited to 16-bit color. It uses standard 8-bit-per-channel RGBA output
(24-bit color depth, ~16.7 million colors). The "16-bit" numbers in the codebase (`R16UI` textures
for `genome` and `generation`) are simulation data, not color data.

### What actually limits realism

| Problem | Location | Root Cause |
|---|---|---|
| Brightness math is wrong | `WebGLRenderer.ts` FRAG_SRC, line ~438 | `cellRGB = base * brightness` multiplies in gamma-compressed sRGB space, not linear light |
| Variant colors look unequal | `ColorMap.ts` VARIANT_PALETTE (~line 287) | HSL at constant lightness = perceptually unequal brightness across hues |
| No glow / bloom | Entire render pipeline | No HDR framebuffer; colors clamped to [0,1] before output |
| Env tints look muddy | `WebGLRenderer.ts` FRAG_SRC, line ~551 | `mix()` in non-linear sRGB gives wrong mid-blend |
| Backgrounds isolated from cells | `BackgroundRenderer.ts` | Backgrounds on separate Canvas 2D; no GPU compositing |

---

## Phases

---

### Phase 16a — Linear Gamma Correction + sRGB Output
**Effort:** ~2 hours | **Files:** `WebGLRenderer.ts` (FRAG_SRC only) | **Risk:** Low

#### Problem

All brightness scaling (`cellRGB = base * brightness`) and color blending (`mix()`) in the
fragment shader operates in gamma-compressed sRGB space. Human display hardware expects colors
in sRGB (gamma ≈ 2.2), but mathematical operations like lerps, multiplications, and additions
only give perceptually correct results in **linear light** space.

Consequence: A Life cell at 50% energy appears at ~22% of maximum perceived brightness instead
of 50%. Dark cells look murkier than they should; bright cells look too similar to each other.

#### What to change

**In the fragment shader (`FRAG_SRC` in `WebGLRenderer.ts`):**

Add two helper functions at the top of the GLSL source, before `baseColor()`:

```glsl
/**
 * Converts a gamma-compressed sRGB channel value [0,1] to linear light [0,1].
 * Uses the IEC 61966-2-1 standard piecewise function (not a pure power curve)
 * for accuracy in dark regions where the power approximation breaks down.
 *
 * @param c - Single sRGB channel value in [0, 1].
 * @returns Linear light value in [0, 1].
 */
float srgbToLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Converts a linear light RGB triple to gamma-compressed sRGB output [0,1].
 * Applied per-channel as the very last step before writing outColor.
 *
 * @param c - Linear light channel value in [0, 1].
 * @returns sRGB gamma-encoded value in [0, 1].
 */
float linearToSrgb(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0/2.4) - 0.055;
}

/** Applies linearToSrgb per-channel to a vec3. */
vec3 linearToSrgbVec(vec3 c) {
  return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
}
```

Update `baseColor()` to return **linear** values. Each hardcoded vec3 currently represents
sRGB channel values divided by 255. Apply `srgbToLinear` to each component:

```glsl
// Example — current:
if (t ==  1u) return vec3(0.0, 1.0, 0.5333);   // Life A #00ff88

// Updated (pre-computed, linearized):
if (t ==  1u) return vec3(0.0, 1.0, 0.2510);   // Life A #00ff88 linearized
```

> **Implementation note:** Pre-compute all 16 linearized base color vec3 values offline using
> the formula `pow((hex/255.0 + 0.055)/1.055, 2.4)` for each channel ≥ 0.04045/12.92.
> Store them as constants in the GLSL, not computed at runtime per fragment.

Update the final output line from:
```glsl
outColor = vec4(clamp(cellRGB, 0.0, 1.0), 1.0);
```
to:
```glsl
outColor = vec4(linearToSrgbVec(clamp(cellRGB, 0.0, 1.0)), 1.0);
```

Update the env tint uniform decode to linearize before blending:
```glsl
// Before (in main, near bottom):
if (u_envTint.a > 0.0) {
  cellRGB = mix(cellRGB, u_envTint.rgb, u_envTint.a);
}

// After:
if (u_envTint.a > 0.0) {
  vec3 tintLinear = vec3(
    srgbToLinear(u_envTint.r),
    srgbToLinear(u_envTint.g),
    srgbToLinear(u_envTint.b)
  );
  cellRGB = mix(cellRGB, tintLinear, u_envTint.a);
}
```

#### Tests to write

In `WebGLRenderer.test.ts`, assert that:
- A Life cell at energy=0.5 produces an output pixel with perceived brightness ≈ 50% of a full-energy cell
  (measure via luminance = 0.2126*R + 0.7152*G + 0.0722*B of the rendered pixel)
- A Wall cell's rendered RGB matches the known sRGB→linearize→sRGB round-trip of `#252830`
- Env tint blend at alpha=0.5 between two grey values produces the perceptually correct midpoint

#### Visual outcome

- Energy-modulated cells (Life, Fire, Colony, Mutagen) look correctly calibrated — a half-energy cell looks half as bright
- Color gradients in lifecycle / genome / generation render modes flow smoothly without the "dark mud at the midpoint" problem
- Environment tints feel atmospheric rather than grey-washing the cells

---

### Phase 16b — OKLab Perceptual Color Space for Variant and Genome Palettes
**Effort:** ~3 hours | **Files:** `ColorMap.ts`, `WebGLRenderer.ts` (FRAG_SRC) | **Risk:** Low

#### Problem

The 256-entry `VARIANT_PALETTE` is generated using HSL at fixed saturation=85%, lightness=55%
with the golden-angle hue step. HSL's "lightness" is perceptually non-uniform: a yellow-green
variant at hue 90° appears far brighter than a blue variant at hue 240° at the same L=55%.

Consequence: colonies of adjacent variants look like some are "glowing" while others are dull —
not because of energy differences, but because of HSL's broken lightness math.

The `genomeColorFor()` function in `ColorMap.ts` also uses a linear hue lerp across blue→green→red
which has the same perceptual uniformity problem.

#### What OKLab is

OKLab (Björn Ottosson, 2020) is a perceptually uniform color space where:
- Equal Euclidean distances correspond to equal perceived color differences
- The "L" axis truly represents perceived lightness, independent of hue
- It supersedes CIELab for most practical purposes

Converting from OKLab to linear sRGB (for shader output) requires a matrix multiply and a
cube-root (already available in GLSL as `cbrt` or `pow(x, 1.0/3.0)`).

#### Changes to `ColorMap.ts`

Replace `hslToRgb` in the `VARIANT_PALETTE` IIFE with an `oklabToRgb` implementation:

```typescript
/**
 * Converts OKLab coordinates to linear sRGB [0, 255].
 *
 * OKLab axes:
 *   L = perceived lightness [0, 1]
 *   a = green-red axis [-0.5, 0.5]
 *   b = blue-yellow axis [-0.5, 0.5]
 *
 * @param L - Lightness in [0, 1].
 * @param a - Green-red chroma component.
 * @param b - Blue-yellow chroma component.
 * @returns Linear sRGB channels, each in [0, 255].
 */
function oklabToLinearSrgb(L: number, a: number, b: number): RgbColor {
  // Step 1: OKLab → LMS (cube root domain)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  // Step 2: Undo cube root (LMS in linear domain)
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  // Step 3: LMS → linear sRGB
  const rLinear =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLinear = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLinear = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  // Step 4: Linear sRGB → gamma-encoded sRGB [0, 255]
  const toSrgb = (c: number): number => {
    const cClamped = Math.max(0, Math.min(1, c));
    const encoded = cClamped <= 0.0031308
      ? cClamped * 12.92
      : 1.055 * Math.pow(cClamped, 1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  };

  return { r: toSrgb(rLinear), g: toSrgb(gLinear), b: toSrgb(bLinear) };
}
```

Update the `VARIANT_PALETTE` generation to use OKLab:

```typescript
// Replace HSL golden-angle generation with OKLab:
// L = 0.72 (constant perceived lightness across ALL hues)
// C = chroma radius = 0.12 (adjust for desired saturation)
// h = golden-angle hue in radians
const L_OK = 0.72;
const C_OK = 0.12;
const GOLDEN_ANGLE_RAD = 2.399963; // 137.508° in radians

for (let v = 1; v < VARIANT_COUNT; v++) {
  const hue = (v * GOLDEN_ANGLE_RAD) % (2 * Math.PI);
  const a   = C_OK * Math.cos(hue);
  const b   = C_OK * Math.sin(hue);
  const { r, g, blue } = oklabToLinearSrgb(L_OK, a, b);
  palette[v] = packRgba(r, g, blue);
}
```

Update `genomeColorFor()` to interpolate through OKLab rather than HSL:

```typescript
export function genomeColorFor(genome: number, energy: number): number {
  const t = genome / 0xFFFF;
  // Interpolate OKLab from blue (low genome) to green (neutral) to red (high genome)
  // Blue:  OKLab(0.55, -0.05, -0.22)
  // Green: OKLab(0.72,  -0.17,  0.12)
  // Red:   OKLab(0.55,  0.18,  0.10)
  const blue   = { L: 0.55, a: -0.05, b: -0.22 };
  const green  = { L: 0.72, a: -0.17, b:  0.12 };
  const red    = { L: 0.55, a:  0.18, b:  0.10 };
  const mid    = t < 0.5 ? lerp3(blue, green, t * 2) : lerp3(green, red, (t - 0.5) * 2);
  const bright = 0.15 + 0.85 * Math.max(0, Math.min(1, energy));
  const { r, g, b: bChannel } = oklabToLinearSrgb(mid.L * bright, mid.a, mid.b);
  return packRgba(r, g, bChannel);
}
```

#### Changes to `WebGLRenderer.ts` (FRAG_SRC)

Add OKLab→linear sRGB conversion function to the GLSL:

```glsl
/**
 * Converts OKLab (L, a, b) to linear sRGB [0, 1].
 * L in [0,1], a/b approximately in [-0.5, 0.5].
 */
vec3 oklabToLinearRgb(float L, float a, float b) {
  float l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  float m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  float s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  float l  = l_ * l_ * l_;
  float m  = m_ * m_ * m_;
  float s  = s_ * s_ * s_;
  return clamp(vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ), 0.0, 1.0);
}
```

Replace the genome render mode color computation (render mode 3) with OKLab interpolation.

#### Tests to write

In `ColorMap.test.ts`, assert that:
- The maximum luminance difference across all 256 `VARIANT_PALETTE` entries is < 5% (perceptual uniformity check)
- `oklabToLinearSrgb(0.72, 0, 0)` returns near-grey (achromatic point test)
- `genomeColorFor(0x0000, 1.0)` and `genomeColorFor(0xFFFF, 1.0)` have similar perceived luminance

#### Visual outcome

- All 256 variant colony lineages look equally bright — differences are purely hue-based
- The genome heatmap flows smoothly from blue→green→red without any hue appearing to "pop"
- Colony invasions become visually dramatic: every competing variant has a distinct, equally legible color

---

### Phase 16c — HDR Framebuffer + Bloom Post-Processing Pass
**Effort:** ~1 day | **Files:** `WebGLRenderer.ts` | **Risk:** Medium

#### Problem

The WebGL output currently writes directly to the 8-bit display framebuffer. Any color component
above 1.0 is silently clamped, meaning:
- Fire cells at maximum energy cannot "glow" brighter than white
- Colony cells cluster together without visible energy radiation
- Background blending cannot produce the atmospheric haze of deep-sea environments

#### Architecture

Replace the single-pass renderer with a two-pass pipeline:

```
Pass 1 (SCENE PASS)
  Target: RGBA16F offscreen framebuffer (HDR)
  Shader: current FRAG_SRC with all clamp() guards removed
  Output: HDR scene texture with values potentially > 1.0 for bright cells

Pass 2 (BLOOM EXTRACT)
  Target: second RGBA16F texture at 50% resolution
  Shader: sample scene texture; output max(0, luminance - threshold) * color
  Threshold: 0.85 (configurable uniform)

Pass 3 (BLOOM BLUR — horizontal)
  Target: third RGBA16F texture (half-res)
  Shader: 9-tap Gaussian blur, horizontal

Pass 4 (BLOOM BLUR — vertical)
  Target: fourth RGBA16F texture (half-res)
  Shader: 9-tap Gaussian blur, vertical

Pass 5 (COMPOSITE + TONEMAP)
  Target: display framebuffer (8-bit sRGB)
  Shader: scene + additive bloom + Reinhard tonemapping + sRGB encode
```

#### WebGLRenderer changes

Add new private fields:

```typescript
/** HDR offscreen framebuffer and its RGBA16F texture. */
private _hdrFBO: WebGLFramebuffer | null = null;
private _hdrTex: WebGLTexture;

/** Half-resolution bloom textures and FBOs. */
private _bloomExtractFBO: WebGLFramebuffer | null = null;
private _bloomExtractTex: WebGLTexture;
private _bloomBlurHTex:   WebGLTexture;
private _bloomBlurVTex:   WebGLTexture;
private _bloomBlurHFBO:   WebGLFramebuffer | null = null;
private _bloomBlurVFBO:   WebGLFramebuffer | null = null;

/** Bloom post-processing shader programs. */
private _bloomExtractProgram: WebGLProgram;
private _bloomBlurHProgram:   WebGLProgram;
private _bloomBlurVProgram:   WebGLProgram;
private _compositeProgram:    WebGLProgram;

/** Whether HDR bloom is currently enabled. */
private _bloomEnabled = true;

/** Luminance threshold above which pixels contribute to bloom (0–1). */
private _bloomThreshold = 0.85;

/** Bloom intensity multiplier. */
private _bloomStrength = 0.6;
```

Add new public setters:

```typescript
/** Enables/disables the bloom post-processing pass. */
set bloomEnabled(enabled: boolean): void;

/** Luminance threshold for bloom extraction [0, 1]. Default: 0.85. */
set bloomThreshold(t: number): void;

/** Bloom additive blend strength [0, 1]. Default: 0.6. */
set bloomStrength(s: number): void;
```

#### Bloom extract GLSL

```glsl
// BLOOM EXTRACT PASS
// Outputs: max(0, luminance - threshold) * color
// Only bright cells (fire, colony, barrier at full energy) contribute.

uniform sampler2D u_scene;
uniform float u_threshold;
out vec4 outColor;

void main() {
  vec3 color = texture(u_scene, texCoord).rgb;
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float contribution = max(0.0, luminance - u_threshold);
  outColor = vec4(color * contribution, 1.0);
}
```

#### Gaussian blur GLSL (9-tap, separable)

```glsl
// Applied twice: once horizontal, once vertical.
// Weights follow a Gaussian with sigma ≈ 1.5.

const float WEIGHTS[5] = float[](0.227027, 0.194595, 0.121622, 0.054054, 0.016216);

void main() {
  vec2 texOffset = 1.0 / vec2(textureSize(u_source, 0));
  vec3 result = texture(u_source, texCoord).rgb * WEIGHTS[0];
  for (int i = 1; i < 5; ++i) {
    vec2 off = u_horizontal ? vec2(texOffset.x * float(i), 0.0)
                            : vec2(0.0, texOffset.y * float(i));
    result += texture(u_source, texCoord + off).rgb * WEIGHTS[i];
    result += texture(u_source, texCoord - off).rgb * WEIGHTS[i];
  }
  outColor = vec4(result, 1.0);
}
```

#### Composite + tonemap GLSL

```glsl
// Reinhard extended tone mapping — maps HDR [0, ∞) to [0, 1].
// Formula: x * (1 + x/white²) / (1 + x)  where white = scene peak
// Followed by sRGB gamma encoding.

uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;

vec3 reinhardExtended(vec3 c) {
  const float whitePoint = 4.0; // HDR values above this map to near-white
  return c * (1.0 + c / (whitePoint * whitePoint)) / (1.0 + c);
}

void main() {
  vec3 scene = texture(u_scene, texCoord).rgb;
  vec3 bloom = texture(u_bloom, texCoord).rgb * u_bloomStrength;
  vec3 hdr   = scene + bloom;                      // additive bloom
  vec3 ldr   = reinhardExtended(hdr);              // tone map HDR → [0,1]
  outColor   = vec4(linearToSrgbVec(ldr), 1.0);   // gamma encode
}
```

#### HDR bright color values for key cell types

Cells that should contribute to bloom need base colors > 1.0 in linear space. Update these
in `baseColor()` for the HDR pass:

| Cell Type | Current Linear | HDR Linear | Rationale |
|---|---|---|---|
| Fire (#dd2200) at max energy | (0.72, 0.02, 0) | (2.0, 0.08, 0) | Burning flame should glow |
| Barrier (#ffdd22) at max energy | (1.0, 0.73, 0.02) | (1.8, 1.3, 0.04) | Electric lemon crackle |
| Colony (#cc8811) at max energy | (0.6, 0.25, 0.003) | (1.2, 0.5, 0.006) | Warm honeycomb glow |
| Life A at full energy | (0, 1.0, 0.251) | (0, 1.4, 0.35) | Vivid healthy colony |

#### EXT_color_buffer_float requirement

Add a capability check at `WebGLRenderer` construction:

```typescript
// HDR requires EXT_color_buffer_float for RGBA16F framebuffer attachments.
const hdrSupported = !!gl.getExtension('EXT_color_buffer_float');
if (!hdrSupported) {
  // Graceful fallback: disable bloom, continue with standard 8-bit pipeline.
  this._bloomEnabled = false;
  console.warn('WebGLRenderer: EXT_color_buffer_float not available; bloom disabled.');
}
```

#### Tests to write

In `WebGLRenderer.test.ts`, assert that:
- With bloom enabled and a Fire cell at max energy, the rendered pixel at an adjacent empty cell has non-zero brightness (bloom spillover)
- With bloom disabled (`bloomEnabled = false`), the render path skips the extra FBO passes
- `reinhardExtended(vec3(4.0))` produces a value near `vec3(0.94)` (known tone-map output)
- `isWebGL2Available()` still works correctly after the HDR init (no context leak)

#### Visual outcome

- Fire cells emit a visible orange glow into neighboring empty cells
- Barrier cells crackle with a bright electric fringe
- High-energy Life colonies appear to radiate light, making population density visible at a glance
- The overall scene gains depth and atmosphere without changing the simulation logic

---

### Phase 16d — Background WebGL Integration (Unified Compositing)
**Effort:** ~2 days | **Files:** `BackgroundRenderer.ts`, `BackgroundManager.ts`, `WebGLRenderer.ts`, all `backgrounds/*.ts` | **Risk:** High

#### Problem

The six procedural backgrounds (Petri, Water, Leaf, Soil, Space, DeepSea) are drawn to a
separate `<canvas id="bg-canvas">` element using Canvas 2D API. The simulation WebGL canvas
sits on top via CSS `z-index`. This means:

- GPU bloom cannot bleed into the background (different render contexts)
- Environment tint is a crude uniform color blend, not spatially-aware
- Backgrounds cannot react to cell density, colony positions, or energy levels
- Animating backgrounds causes repaints on a CPU 2D canvas — expensive for large grids

#### Architecture

Convert backgrounds from Canvas 2D drawers to **WebGL texture generators** that feed into
the composite pass added in Phase 16c.

```
Background WebGL sub-pass (per frame if background is active):
  1. Background procedural shader renders to a dedicated RGBA16F texture
     (same resolution as the sim canvas)
  2. Scene pass composites: background * (1 - cellAlpha) + cell * cellAlpha
     where cellAlpha=0 for Empty cells (transparent), 1 for all others
  3. Bloom pass operates on the merged scene, so background bright spots bloom too
```

#### New types and interfaces

```typescript
/**
 * WebGL-based background that renders into a GPU texture each frame.
 * Replaces the Canvas 2D `Background` interface for the GPU pipeline.
 */
export interface WebGLBackground {
  /**
   * Render one frame of this background into the bound framebuffer.
   * The renderer will have already bound the background FBO before calling this.
   *
   * @param gl     - Active WebGL2 context.
   * @param width  - Framebuffer width in pixels.
   * @param height - Framebuffer height in pixels.
   * @param frame  - Monotonically increasing frame counter.
   */
  render(gl: WebGL2RenderingContext, width: number, height: number, frame: number): void;

  /**
   * Returns the environment tint for this background as an OKLab color.
   * Used by the composite pass to bias Life cell colors toward the environment palette.
   * Returns null if no tint should be applied.
   */
  readonly envTintOklab: readonly [number, number, number] | null;
}
```

#### Background GLSL architecture

Each background gets a dedicated fragment shader using noise-based procedural generation.
Common GLSL utilities shared across all backgrounds (in a new `backgrounds/glsl-common.ts`):

```glsl
// === Shared procedural utilities ===

/** 2D value noise — maps integer grid coordinate to pseudo-random float. */
float hash2(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

/** Smooth 2D value noise with bilinear interpolation. */
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep curve
  return mix(
    mix(hash2(i + vec2(0,0)), hash2(i + vec2(1,0)), u.x),
    mix(hash2(i + vec2(0,1)), hash2(i + vec2(1,1)), u.x),
    u.y
  );
}

/** 4-octave fractal Brownian motion. */
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise2(p);
    p  = p * 2.0 + vec2(5.2, 1.3);
    a *= 0.5;
  }
  return v;
}
```

#### Per-background shader summaries

**Petri Dish shader:**
- Warm amber radial gradient (`L=0.78, C=0.06, h=75°` in OKLab)
- Concentric ring darkening using `fract(length(uv) * 8.0)`
- Condensation droplets via `smoothstep` circles at `hash2`-determined positions
- Slow shimmer: `sin(u_time * 0.012)` on the L channel only

**Water shader:**
- Deep cyan-blue base (`L=0.55, C=0.08, h=215°`)
- Caustic light patches: sum of 3 moving `fbm` calls at different frequencies
- Surface ripple: horizontal sine bands at `sin(uv.y * 40 + u_time * 0.05)`
- Light rays: vertical gradients at random X positions, animated width

**Leaf shader:**
- Vein network: SDF distance to a fractal branching skeleton baked as a texture offset
- Cell wall texture: hexagonal grid pattern `length(fract(uv * hex_scale) - 0.5)`
- Chloroplast spots: small circular `smoothstep` discs at `hash2` grid positions
- Color: bright green veins on darker mesophyll; OKLab interpolation

**Soil shader:**
- Dark loam base with high-frequency `fbm` grain
- Gravel particles: large-radius `hash2`-placed ellipses with brightness variation
- Root channels: darker elongated regions using `smoothstep` along rotated UVs
- Moisture darkening at bottom (linear gradient in Y)

**Space shader:**
- Near-black with `fbm` nebula clouds (deep purple/blue OKLab hues)
- Star field: `step(0.995, hash2(floor(uv * 1200)))` — sharp point stars
- Star glow: `exp(-dist * 20)` falloff from each star position
- Animated parallax: two star layers at different speeds

**DeepSea shader:**
- Very dark blue-green base
- Bioluminescent particles: sinusoidal opacity cycling at different phases
- Pressure caustic ripples: `fbm` at moving coordinates
- Vertical light shaft: single attenuated cone descending from top center

#### Composite shader update

The Pass 5 composite shader (from Phase 16c) is extended:

```glsl
uniform sampler2D u_background; // new: background texture from background sub-pass
uniform bool      u_hasBackground;

void main() {
  vec4 sceneColor = texture(u_scene, texCoord);
  float cellAlpha = sceneColor.a; // 0.0 for Empty cells, 1.0 for all others

  vec3 finalColor;
  if (u_hasBackground) {
    vec3 bg = texture(u_background, texCoord).rgb;
    finalColor = mix(bg, sceneColor.rgb, cellAlpha);
  } else {
    finalColor = sceneColor.rgb;
  }

  vec3 bloom = texture(u_bloom, texCoord).rgb * u_bloomStrength;
  vec3 hdr   = finalColor + bloom;
  outColor   = vec4(linearToSrgbVec(reinhardExtended(hdr)), 1.0);
}
```

This requires the scene pass to output alpha = 0 for Empty cells (instead of the current
opaque near-black). Update the scene shader's empty cell branch:

```glsl
// In default render mode, for Empty cells:
if (cellType == 0u) {
  outColor = vec4(0.0, 0.0, 0.0, 0.0); // transparent — show background
  return;
}
```

#### Migration strategy for existing Canvas 2D backgrounds

Keep the Canvas 2D `Background` interface intact and all existing implementations as-is.
`BackgroundManager` will detect whether `WebGLRenderer` is active and choose the pipeline:

```typescript
// In BackgroundManager.ts:
if (renderer instanceof WebGLRenderer && background instanceof WebGLBackground) {
  // GPU path: background renders into the renderer's background texture slot
  renderer.setWebGLBackground(background);
} else {
  // Fallback: Canvas 2D path (existing behaviour, unchanged)
  this._renderCanvas2D(background, ctx, width, height, frame);
}
```

#### Tests to write

In `backgrounds/backgrounds.test.ts`, add:
- Each WebGL background shader compiles without errors in a headless WebGL2 context
- `envTintOklab` returns values that round-trip correctly through OKLab→sRGB
- The composite shader with `u_hasBackground = false` produces identical output to Phase 16c
- The composite shader with `cellAlpha = 0` shows background color, `cellAlpha = 1` shows cell color

---

## Implementation Sequence

```
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 16a   Linear Gamma Correction                        ~2h     │
│  ─────────────────────────────────────────────────────────────────  │
│  1. Add srgbToLinear / linearToSrgb helpers to FRAG_SRC             │
│  2. Pre-compute linearized base color vec3 values for all 16 types  │
│  3. Wrap final outColor assignment with linearToSrgbVec()           │
│  4. Linearize env tint before mix()                                 │
│  5. Write tests                                                     │
└─────────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 16b   OKLab Perceptual Palettes                      ~3h     │
│  ─────────────────────────────────────────────────────────────────  │
│  1. Add oklabToLinearSrgb() to ColorMap.ts                          │
│  2. Regenerate VARIANT_PALETTE using OKLab golden-angle             │
│  3. Update genomeColorFor() to interpolate in OKLab                 │
│  4. Add oklabToLinearRgb() GLSL helper to FRAG_SRC                  │
│  5. Replace genome render mode GLSL with OKLab version              │
│  6. Write tests                                                     │
└─────────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 16c   HDR Framebuffer + Bloom                        ~1d     │
│  ─────────────────────────────────────────────────────────────────  │
│  1. Add EXT_color_buffer_float capability check                     │
│  2. Create RGBA16F HDR FBO + texture                                │
│  3. Write bloom extract shader (threshold-based)                    │
│  4. Write separable Gaussian blur shader (horizontal + vertical)    │
│  5. Write composite + Reinhard tonemap shader                       │
│  6. Wire 5-pass pipeline in render() method                         │
│  7. Update HDR bright values for Fire, Barrier, Colony, Life        │
│  8. Add bloomEnabled / bloomThreshold / bloomStrength setters       │
│  9. Write tests                                                     │
└─────────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 16d   Background WebGL Integration                   ~2d     │
│  ─────────────────────────────────────────────────────────────────  │
│  1. Create WebGLBackground interface                                │
│  2. Create glsl-common.ts (hash2, noise2, fbm)                      │
│  3. Implement PetriDish WebGL background shader                     │
│  4. Implement Water WebGL background shader                         │
│  5. Implement Leaf WebGL background shader                          │
│  6. Implement Soil WebGL background shader                          │
│  7. Implement Space WebGL background shader                         │
│  8. Implement DeepSea WebGL background shader                       │
│  9. Update composite shader to blend background texture             │
│  10. Update Empty cell output to alpha=0 in scene pass              │
│  11. Update BackgroundManager with GPU/CPU path selection           │
│  12. Write tests                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Files Modified per Phase

| Phase | Modified | New |
|---|---|---|
| 16a | `src/rendering/WebGLRenderer.ts` | — |
| 16b | `src/rendering/ColorMap.ts`, `src/rendering/WebGLRenderer.ts` | — |
| 16c | `src/rendering/WebGLRenderer.ts` | — |
| 16d | `src/rendering/WebGLRenderer.ts`, `src/rendering/BackgroundRenderer.ts`, `src/rendering/BackgroundManager.ts` | `src/rendering/backgrounds/glsl-common.ts`, 6 × WebGL background classes |

---

## Key Decisions and Trade-offs

### Why not WebGPU?

WebGPU would allow compute shaders (the simulation itself could move to the GPU) but has
~85% browser coverage vs ~98% for WebGL 2 as of 2026. The Phase 16 plan stays on WebGL 2 with
`EXT_color_buffer_float` (universally supported on WebGL 2 desktop hardware). A WebGPU migration
is a Phase 17+ consideration.

### Why Reinhard extended and not ACES?

ACES filmic tonemapping produces cinematic results (used in AAA games) but has a characteristic
S-curve that desaturates midtones and has a warm bias. For a biology simulator where color
accuracy conveys cell state (variant ID, genome value), Reinhard extended is more appropriate —
it brightens highlights without shifting hue.

### Why OKLab over CIELab?

OKLab is a successor to CIELab that fixes its non-uniform perceptual spacing (some hue regions
in CIELab have denser color perception than others). For the golden-angle variant palette, OKLab
guarantees that ALL 256 variants are equally perceptually distinct. OKLab is also simpler to
implement in GLSL — one matrix multiply and a cube root, vs. CIELab's piecewise function.

### Canvas 2D fallback preservation

The existing Canvas 2D background implementations are kept intact throughout Phase 16d.
If `EXT_color_buffer_float` is unavailable (e.g. mobile Safari), `BackgroundManager` falls back
to the Phase 14 Canvas 2D pipeline. No user-visible regression.

---

## Definition of Done (per phase)

- [ ] All existing tests continue to pass (`npm test`)
- [ ] TypeScript compiles with zero errors (`npm run build`)
- [ ] New unit tests written for all new public functions
- [ ] Visual spot-check: load app, enable background, verify bloom visible on Fire cells
- [ ] Performance: render loop stays ≥ 30 fps at 1024×1024 grid, 2px cell size
