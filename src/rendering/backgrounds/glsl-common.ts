/**
 * @fileoverview Shared GLSL source strings for the WebGL background pipeline
 * (Phase 16d).
 *
 * All six WebGL background fragment shaders include GLSL_COMMON at the top so
 * they can use the same hash, noise, and FBM utilities without duplication.
 *
 * BACKGROUND_VERT_SRC is a passthrough vertex shader that converts the
 * clip-space quad position to UV coordinates for the fragment stage.  It is
 * identical in purpose to PP_VERT_SRC but lives here so background classes can
 * compile their own programmes without importing the scene renderer.
 */

// ---------------------------------------------------------------------------
// Vertex shader (shared by all background programmes)
// ---------------------------------------------------------------------------

/**
 * Passthrough vertex shader for background fullscreen quad passes.
 * Converts clip-space `a_position` to normalised UV `v_texCoord` [0, 1].
 */
export const BACKGROUND_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_texCoord;

void main() {
  v_texCoord  = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Common GLSL utilities (prepended to every background fragment shader)
// ---------------------------------------------------------------------------

/**
 * Shared procedural utilities — hash, value noise, and fractal Brownian motion.
 *
 * Include this at the top of every background fragment shader source string
 * (before your own `void main()`).
 *
 * Functions provided:
 *   - `hash1(vec2 p)`  — pseudo-random float in [0, 1] from a 2D seed
 *   - `noise2(vec2 p)` — smooth bilinear value noise in [0, 1]
 *   - `fbm(vec2 p)`    — 4-octave fractal Brownian motion in [0, 1]
 */
export const GLSL_COMMON = /* glsl */ `

/**
 * Pseudo-random float in [0, 1] derived from a 2D integer-grid seed.
 * Deterministic — the same p always returns the same value.
 *
 * @param p - Any 2D floating-point coordinate; non-integer parts are ignored.
 * @returns Pseudo-random float in [0, 1].
 */
float hash1(vec2 p) {
  p  = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

/**
 * Smooth value noise with bilinear interpolation over a hash1 grid.
 * Returns values in approximately [0, 1].
 *
 * @param p - Continuous 2D coordinate; scale to control feature size.
 * @returns Smooth noise value in [0, 1].
 */
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep curve
  return mix(
    mix(hash1(i + vec2(0.0, 0.0)), hash1(i + vec2(1.0, 0.0)), u.x),
    mix(hash1(i + vec2(0.0, 1.0)), hash1(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

/**
 * 4-octave fractal Brownian motion — stacks noise at increasing frequencies.
 * Returns values in approximately [0, 1].
 *
 * @param p - 2D coordinate; scale this to control the base feature size.
 * @returns FBM value in [0, 1].
 */
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise2(p);
    p  = p * 2.0 + vec2(5.2, 1.3);
    a *= 0.5;
  }
  return v;
}
`;
