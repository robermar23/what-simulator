/**
 * @fileoverview WebGL 2 background implementations for the Phase 16d HDR
 * compositing pipeline.
 *
 * Each background renders into an RGBA8 texture (attached to a framebuffer
 * supplied by `WebGLRenderer`) using a dedicated GLSL fragment shader.
 * The texture is then composited with the HDR scene in the final pass.
 *
 * ## Architecture
 *
 * `BaseWebGLBackground` handles the boilerplate (lazy shader compilation, quad
 * VBO/VAO creation, time uniform upload).  Concrete subclasses only supply:
 *   - `readonly fragSrc`      — GLSL fragment shader source string
 *   - `readonly envTintOklab` — optional OKLab env-tint for cell colour bias
 *
 * All fragment shaders output **linear sRGB** values so the composite pass
 * can blend them directly with the linear-space HDR scene texture.
 *
 * ## Colour conventions
 *
 * sRGB hex → linear conversion used for base colours:
 *   `linearVal = (srgbNorm <= 0.04045) ? srgbNorm/12.92 : pow((srgbNorm+0.055)/1.055, 2.4)`
 *
 * @module WebGLBackgrounds
 */

import { type WebGLBackground } from '../BackgroundRenderer.js';
import { BACKGROUND_VERT_SRC, GLSL_COMMON } from './glsl-common.js';

// ---------------------------------------------------------------------------
// Fullscreen quad vertices (clip-space triangle strip)
// ---------------------------------------------------------------------------

/** XY positions for a clip-space fullscreen quad (two triangles). */
const QUAD_VERTS = new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]);

// ---------------------------------------------------------------------------
// Abstract base
// ---------------------------------------------------------------------------

/**
 * Base class for all WebGL background renderers.
 *
 * Handles lazy shader compilation, quad geometry, and time uniform upload.
 * Subclasses provide the fragment shader source and the optional OKLab tint.
 */
abstract class BaseWebGLBackground implements WebGLBackground {
  /** GLSL 3.00 ES fragment shader source (should start with GLSL_COMMON). */
  protected abstract readonly fragSrc: string;

  /** OKLab tint for compositing Life cell colours (or null for no bias). */
  abstract readonly envTintOklab: readonly [number, number, number] | null;

  /** Compiled WebGL programme — null until the first `render()` call. */
  private _prog: WebGLProgram | null = null;

  /** VAO bound to the quad VBO. */
  private _vao: WebGLVertexArrayObject | null = null;

  /** Location of `u_time` in the programme. */
  private _uTime: WebGLUniformLocation | null = null;

  // -------------------------------------------------------------------------
  // WebGLBackground implementation
  // -------------------------------------------------------------------------

  /**
   * Renders one frame of this background into the currently bound framebuffer.
   *
   * Lazily compiles the shader programme on the first call.
   *
   * @param gl     - Active WebGL 2 context.
   * @param width  - Framebuffer width in pixels.
   * @param height - Framebuffer height in pixels.
   * @param frame  - Monotonically increasing frame counter (used for animation).
   */
  render(gl: WebGL2RenderingContext, width: number, height: number, frame: number): void {
    if (this._prog === null) this._init(gl);
    if (this._prog === null || this._vao === null) return;

    gl.useProgram(this._prog);
    gl.viewport(0, 0, width, height);

    // Advance the animation clock (~60fps assumed → 1 frame ≈ 0.016 s).
    if (this._uTime !== null) {
      gl.uniform1f(this._uTime, frame * (1.0 / 60.0));
    }

    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Compiles the programme, creates VBO/VAO, and caches the `u_time` uniform.
   * Called at most once per background instance (lazy init).
   *
   * @param gl - Active WebGL 2 context.
   */
  private _init(gl: WebGL2RenderingContext): void {
    // Compile shaders.
    const vert = this._compile(gl, gl.VERTEX_SHADER,   BACKGROUND_VERT_SRC);
    const frag = this._compile(gl, gl.FRAGMENT_SHADER, this.fragSrc);
    if (vert === null || frag === null) return;

    // Link programme.
    const prog = gl.createProgram();
    if (prog === null) return;
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.detachShader(prog, vert);
    gl.detachShader(prog, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('WebGLBackground: link failed:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return;
    }
    this._prog = prog;

    // Quad VBO.
    const vbo = gl.createBuffer();
    if (vbo === null) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);

    // VAO.
    const vao = gl.createVertexArray();
    if (vao === null) return;
    gl.bindVertexArray(vao);
    const loc = gl.getAttribLocation(prog, 'a_position');
    if (loc !== -1) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(null);
    this._vao = vao;

    // Cache time uniform.
    this._uTime = gl.getUniformLocation(prog, 'u_time');
  }

  /**
   * Compiles a single GLSL shader stage.
   *
   * @param gl     - Active context.
   * @param type   - `VERTEX_SHADER` or `FRAGMENT_SHADER`.
   * @param source - GLSL source text.
   * @returns Compiled shader or `null` on error.
   */
  private _compile(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
  ): WebGLShader | null {
    const shader = gl.createShader(type);
    if (shader === null) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      console.error(`WebGLBackground: ${typeName} compile error:`, gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
}

// ---------------------------------------------------------------------------
// Petri Dish
// ---------------------------------------------------------------------------

/**
 * Warm amber agar-gel surface as seen from directly above the culture plate.
 *
 * Features: radial depth-darkening, faint concentric measurement rings,
 * animated surface shimmer, and hash-placed condensation droplets.
 */
export class PetriDishWebGLBackground extends BaseWebGLBackground {
  // OKLab for warm amber: L≈0.74, a≈0.03, b≈0.09
  readonly envTintOklab = [0.74, 0.03, 0.09] as const;

  protected readonly fragSrc = /* glsl */ `#version 300 es
precision highp float;

${GLSL_COMMON}

uniform float u_time;
in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec2  uv = v_texCoord;
  // Centred coordinates [-1, 1]^2.
  vec2  c  = uv * 2.0 - 1.0;
  float r  = length(c);

  // Agar gel base — warm amber, linear sRGB.
  // sRGB(208, 174, 112) → linear ≈ (0.644, 0.444, 0.179).
  float shimmer = 0.04 * sin(u_time * 0.012);
  vec3  base    = vec3(0.644 + shimmer, 0.444, 0.179);

  // Radial depth-darkening (dish edges cast shadow on the agar surface).
  base *= 1.0 - r * r * 0.55;

  // Faint concentric measurement rings etched into the agar wall.
  float rings = 0.018 * clamp(sin(r * 28.0) * 0.5 + 0.5 - 0.45, 0.0, 1.0);
  base += vec3(rings * 0.5, rings * 0.45, rings * 0.28);

  // Surface grain texture via low-frequency FBM.
  float grain = fbm(uv * 10.0) * 0.08 - 0.04;
  base        = clamp(base + vec3(grain), 0.0, 1.0);

  // 20 hash-placed condensation droplets that drift slowly.
  for (int i = 0; i < 20; i++) {
    float fi    = float(i);
    float ang   = hash1(vec2(fi, 0.3)) * 6.283
                + u_time * (0.0003 + fi * 0.000085);
    float rad   = 0.3 + (mod(fi * 7.0 + 3.0, 13.0) / 13.0) * 0.65;
    vec2  dpos  = vec2(0.5 + cos(ang) * rad * 0.44,
                       0.5 + sin(ang) * rad * 0.44);
    float d     = length(uv - dpos);
    float drop  = smoothstep(0.009, 0.003, d);
    float alpha = 0.12 + 0.18 * abs(sin(u_time * 0.015 + fi * 1.7));
    // Droplets are slightly blue-tinted condensation water.
    base += vec3(0.05, 0.07, 0.10) * drop * alpha;
  }

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Water / Aquatic
// ---------------------------------------------------------------------------

/**
 * Submerged aquatic environment with deep-cyan water column, moving caustics,
 * surface ripple bands, and a depth-gradient darkening toward the bottom.
 */
export class WaterWebGLBackground extends BaseWebGLBackground {
  // OKLab for deep ocean blue: L≈0.40, a≈-0.04, b≈-0.18
  readonly envTintOklab = [0.40, -0.04, -0.18] as const;

  protected readonly fragSrc = /* glsl */ `#version 300 es
precision highp float;

${GLSL_COMMON}

uniform float u_time;
in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec2 uv = v_texCoord;

  // Deep ocean blue base, linear sRGB.
  // sRGB(8, 42, 140) → linear ≈ (0.009, 0.024, 0.271).
  vec3 base = vec3(0.009, 0.024, 0.271);

  // Caustic light patches — two overlapping FBM fields at different speeds.
  float c1 = fbm(uv * 5.0 + vec2(u_time * 0.013, u_time * 0.009));
  float c2 = fbm(uv * 7.0 + vec2(-u_time * 0.008, u_time * 0.014));
  float caustic = pow((c1 + c2) * 0.5, 2.0) * 0.55;
  // Caustics brighten the blue-cyan axis (scattered sunlight effect).
  base += vec3(0.0, caustic * 0.28, caustic);

  // Horizontal ripple bands — surface refraction pattern.
  float ripple = 0.025 * sin(uv.y * 45.0 + u_time * 0.06)
               + 0.012 * sin(uv.y * 80.0 - u_time * 0.04);
  base += vec3(0.0, ripple, ripple * 0.5);

  // Depth gradient — water darkens toward the bottom.
  base *= 1.0 - uv.y * 0.35;

  // Faint bubbles (slow-rising circles placed by hash).
  for (int i = 0; i < 8; i++) {
    float fi   = float(i);
    float bx   = hash1(vec2(fi, 0.0));
    float by   = fract(hash1(vec2(fi, 1.0)) + u_time * (0.0006 + fi * 0.0001));
    float d    = length(uv - vec2(bx, 1.0 - by));
    float ring = abs(d - 0.012);
    base      += vec3(0.0, 0.04, 0.06) * (1.0 - smoothstep(0.0, 0.004, ring));
  }

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Leaf Surface
// ---------------------------------------------------------------------------

/**
 * Chloroplast-rich leaf interior as seen through a microscope.
 *
 * Features: midrib + lateral vein network, hexagonal mesophyll cell walls,
 * and hash-placed chloroplast spots.
 */
export class LeafWebGLBackground extends BaseWebGLBackground {
  // OKLab for leaf green: L≈0.43, a≈-0.12, b≈0.07
  readonly envTintOklab = [0.43, -0.12, 0.07] as const;

  protected readonly fragSrc = /* glsl */ `#version 300 es
precision highp float;

${GLSL_COMMON}

uniform float u_time;
in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec2 uv  = v_texCoord;
  // Centred coordinates for vein geometry.
  vec2 uvc = uv * 2.0 - 1.0;

  // Mesophyll base — mid green, linear sRGB.
  // sRGB(18, 72, 22) → linear ≈ (0.005, 0.072, 0.007).
  vec3 base = vec3(0.005, 0.072, 0.007);

  // Midrib (main central vein) — bright stripe along y-axis.
  float midrib = 1.0 - smoothstep(0.012, 0.04, abs(uvc.x));
  base += vec3(0.02, 0.12, 0.02) * midrib;

  // Lateral veins — symmetric branches at regular y intervals.
  float sideVeins = 0.0;
  for (int i = -5; i <= 5; i++) {
    if (i == 0) continue;
    float vy  = float(i) * 0.18;
    // Branch direction: from midrib toward the leaf edge.
    vec2 branchDir = normalize(vec2(sign(uvc.x) * 0.85, sign(float(i)) * 0.52));
    vec2 origin    = vec2(0.0, vy);
    vec2 toPixel   = uvc - origin;
    float along    = dot(toPixel, branchDir);
    float perp     = dot(toPixel, vec2(-branchDir.y, branchDir.x));
    // Only draw on the correct side; fade at tips.
    float tip      = smoothstep(0.8, 0.0, along / 0.9);
    sideVeins     += tip * (1.0 - smoothstep(0.005, 0.022, abs(perp)));
  }
  base += vec3(0.015, 0.09, 0.015) * clamp(sideVeins, 0.0, 1.0);

  // Hexagonal cell-wall texture (mesophyll cells).
  // Two offset hex grids create the interlocking pattern.
  vec2 hexUv = uv * 18.0;
  vec2 hex   = fract(hexUv + vec2(0.0, 0.5 * floor(hexUv.x))) - 0.5;
  float wall = 1.0 - smoothstep(0.36, 0.46, length(hex));
  base       = mix(base, base * 0.78, wall * 0.4);

  // Chloroplast spots — small bright-green discs placed by hash.
  for (int j = 0; j < 32; j++) {
    float fj  = float(j);
    vec2  cp  = vec2(hash1(vec2(fj, 0.0)), hash1(vec2(fj, 1.0)));
    float d   = length(uv - cp);
    float cl  = smoothstep(0.013, 0.006, d);
    base     += vec3(0.0, 0.15, 0.01) * cl;
  }

  // Slow breathing shimmer (photosynthesis pulse).
  base *= 0.92 + 0.08 * sin(u_time * 0.018);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Soil
// ---------------------------------------------------------------------------

/**
 * Dark humus soil cross-section with irregular grain texture, embedded
 * gravel particles, and a moisture gradient at the bottom.
 */
export class SoilWebGLBackground extends BaseWebGLBackground {
  // OKLab for humus brown: L≈0.38, a≈0.06, b≈0.09
  readonly envTintOklab = [0.38, 0.06, 0.09] as const;

  protected readonly fragSrc = /* glsl */ `#version 300 es
precision highp float;

${GLSL_COMMON}

uniform float u_time;
in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec2 uv = v_texCoord;

  // Dark loam base, linear sRGB.
  // sRGB(55, 28, 8) → linear ≈ (0.042, 0.012, 0.001).
  vec3 base = vec3(0.042, 0.012, 0.001);

  // High-frequency grain — two FBM octaves at different scales.
  float grain = fbm(uv * 22.0) * 0.14 + fbm(uv * 48.0) * 0.06 - 0.08;
  base = clamp(base * (0.75 + grain * 2.0), 0.0, 1.0);

  // Root channels — dark sinuous tunnels placed by hash.
  for (int i = 0; i < 6; i++) {
    float fi  = float(i);
    float x0  = hash1(vec2(fi, 0.0));
    float wave = 0.06 * sin(uv.y * (8.0 + fi * 2.0) + fi * 2.1);
    float d   = abs(uv.x - x0 - wave);
    float root = 1.0 - smoothstep(0.003, 0.012, d);
    base      = mix(base, vec3(0.008, 0.003, 0.0), root * 0.8);
  }

  // Gravel and mineral particles — circular inclusions.
  for (int i = 0; i < 28; i++) {
    float fi     = float(i);
    vec2  gp     = vec2(hash1(vec2(fi, 2.0)), hash1(vec2(fi, 3.0)));
    float gr     = hash1(vec2(fi, 4.0)) * 0.024 + 0.007;
    float d      = length(uv - gp);
    float stone  = 1.0 - smoothstep(gr, gr + 0.005, d);
    // Colour range: dark slate to pale quartz.
    float hv     = hash1(vec2(fi, 5.0));
    vec3 stoneC  = mix(vec3(0.07, 0.05, 0.03),
                       vec3(0.22, 0.18, 0.12), hv);
    // Slight bevel highlight on top edge.
    float hi     = 1.0 - smoothstep(0.0, gr * 0.4, d);
    stoneC      += vec3(0.06) * hi;
    base         = mix(base, stoneC, stone * 0.85);
  }

  // Moisture darkening at bottom — waterlogged lower horizon.
  base *= 1.0 - uv.y * 0.45;

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Deep Space
// ---------------------------------------------------------------------------

/**
 * Deep-space void: two star-field layers for parallax depth, soft nebula
 * clouds from FBM, and a distant galaxy smear.  Stars twinkle via per-star
 * sinusoidal brightness modulation.
 */
export class SpaceWebGLBackground extends BaseWebGLBackground {
  // OKLab for deep violet-void: L≈0.22, a≈0.04, b≈-0.12
  readonly envTintOklab = [0.22, 0.04, -0.12] as const;

  protected readonly fragSrc = /* glsl */ `#version 300 es
precision highp float;

${GLSL_COMMON}

uniform float u_time;
in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec2 uv = v_texCoord;

  // Near-black cosmic void base, linear sRGB.
  vec3 base = vec3(0.001, 0.001, 0.004);

  // Nebula cloud 1: warm purple (emission nebula).
  float neb1 = fbm(uv * 2.8 + vec2(u_time * 0.0008, 0.0));
  base += vec3(0.012, 0.002, 0.055) * pow(neb1, 2.2);

  // Nebula cloud 2: cool blue (reflection nebula).
  float neb2 = fbm(uv * 3.5 + vec2(0.7, u_time * 0.0006));
  base += vec3(0.002, 0.015, 0.075) * pow(neb2, 2.0);

  // Cosmic dust lane: diagonal low-opacity streak.
  float dust = fbm(uv * 1.5 + vec2(0.3, 0.8));
  base      += vec3(0.006, 0.003, 0.015) * dust * smoothstep(0.4, 0.55, dust);

  // Two star-field layers (near = dense, far = sparse) for parallax depth.
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 160.0 : 310.0;
    float bias  = float(layer) * 73.0;
    vec2 sv     = uv * scale;
    vec2 cell   = floor(sv);
    vec2 local  = fract(sv) - 0.5;
    float s     = hash1(cell + vec2(bias, bias * 0.7));
    // Only 5–8% of cells contain a star.
    float exist = step(layer == 0 ? 0.92 : 0.95, s);
    float twinkle = 0.55 + 0.45 * sin(u_time * (0.04 + s * 0.12) + s * 6.28);
    float radius  = (0.35 + s * 0.5) * 0.28;
    float star    = smoothstep(radius, radius * 0.25, length(local));
    float bright  = (layer == 0 ? 0.55 : 0.80) * exist * twinkle * star;
    // Faint stars: blue-white; bright stars: warm white.
    vec3 starCol  = layer == 0
        ? vec3(bright * 0.88, bright * 0.92, bright)
        : vec3(bright, bright * 0.96, bright * 0.90);
    base += starCol;
  }

  // Distant galaxy smear (ellipse at upper-right).
  float galaxyR = length((uv - vec2(0.78, 0.22)) * vec2(0.5, 1.3));
  base += vec3(0.06, 0.05, 0.03) * exp(-galaxyR * 12.0);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Deep Sea
// ---------------------------------------------------------------------------

/**
 * Abyssal deep-sea environment: near-black blue-green base, animated
 * bioluminescent particles, pressure-caustic ripples, and a faint
 * attenuated light shaft descending from above.
 */
export class DeepSeaWebGLBackground extends BaseWebGLBackground {
  // OKLab for abyssal blue: L≈0.28, a≈-0.03, b≈-0.14
  readonly envTintOklab = [0.28, -0.03, -0.14] as const;

  protected readonly fragSrc = /* glsl */ `#version 300 es
precision highp float;

${GLSL_COMMON}

uniform float u_time;
in  vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec2 uv = v_texCoord;

  // Abyssal blue-green base, linear sRGB.
  // sRGB(0, 18, 72) → linear ≈ (0.0, 0.005, 0.072).
  vec3 base = vec3(0.0, 0.005, 0.072);

  // Pressure caustic ripples — two moving FBM fields.
  float c1 = fbm(uv * 7.0 + vec2(u_time * 0.014, u_time * 0.009));
  float c2 = fbm(uv * 5.0 + vec2(-u_time * 0.007, u_time * 0.012));
  float caustic = pow((c1 + c2) * 0.5, 1.6) * 0.08;
  base += vec3(0.0, caustic * 0.35, caustic);

  // Depth darkening — surface is slightly lighter than the abyss.
  base *= 0.6 + 0.4 * (1.0 - uv.y);

  // Bioluminescent particles — 38 slow-drifting glowing specks.
  for (int i = 0; i < 38; i++) {
    float fi    = float(i);
    float speed = 0.00025 + fi * 0.000045;
    // Particles drift upward and oscillate horizontally.
    float bx  = fract(hash1(vec2(fi, 0.0))
                    + 0.04 * sin(u_time * 0.015 + fi * 2.3));
    float by  = fract(1.0 - (hash1(vec2(fi, 1.0)) + u_time * speed));
    float d   = length(uv - vec2(bx, by));
    float pulse = 0.45 + 0.55 * sin(u_time * 0.09 + fi * 2.1);
    // Bright core + soft glow halo.
    float core = smoothstep(0.004, 0.001, d);
    float halo = smoothstep(0.022, 0.0,   d) * 0.35;
    float glow = (core + halo) * pulse;
    // Bioluminescent teal — L* equal-energy hue
    base += vec3(0.0, glow * 0.32, glow * 0.85);
  }

  // Attenuated light shaft descending from top centre.
  float shaft = exp(-abs(uv.x - 0.5) * 9.0)
              * (1.0 - uv.y) * (0.0 + 0.09 * sin(u_time * 0.011));
  shaft       = max(shaft, 0.0);
  base       += vec3(0.0, shaft * 0.45, shaft);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// WebGL background factory
// ---------------------------------------------------------------------------

/**
 * Returns the correct `BaseWebGLBackground` implementation for the given
 * background type key.
 *
 * `'none'` returns `null` — the composite pass will render without a background.
 *
 * @param type - Background environment key.
 * @returns A `WebGLBackground` instance, or `null` for `'none'`.
 */
export function createWebGLBackground(
  type: 'none' | 'petri' | 'water' | 'leaf' | 'soil' | 'space' | 'deepsea',
): BaseWebGLBackground | null {
  switch (type) {
    case 'none':    return null;
    case 'petri':   return new PetriDishWebGLBackground();
    case 'water':   return new WaterWebGLBackground();
    case 'leaf':    return new LeafWebGLBackground();
    case 'soil':    return new SoilWebGLBackground();
    case 'space':   return new SpaceWebGLBackground();
    case 'deepsea': return new DeepSeaWebGLBackground();
  }
}
