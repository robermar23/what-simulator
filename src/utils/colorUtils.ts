/**
 * @fileoverview Colour conversion utilities for the What Simulator renderer.
 *
 * Keeps all HSL ↔ RGB logic in one place so the hot pixel-write path in
 * Renderer.ts only has to read from a pre-built lookup table — never call
 * these conversion functions per-frame.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A colour as separate 0–255 channels. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

// ---------------------------------------------------------------------------
// HSL → RGB
// ---------------------------------------------------------------------------

/**
 * Converts an HSL colour to RGB.
 *
 * @param h - Hue in degrees [0, 360).
 * @param s - Saturation in [0, 1].
 * @param l - Lightness in [0, 1].
 * @returns RGB channels in [0, 255].
 */
export function hslToRgb(h: number, s: number, l: number): RgbColor {
  // Normalise hue to [0, 1).
  const hNorm = ((h % 360) + 360) % 360 / 360;

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToChannel(p, q, hNorm + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, hNorm) * 255),
    b: Math.round(hueToChannel(p, q, hNorm - 1 / 3) * 255),
  };
}

/**
 * Helper for {@link hslToRgb} — converts a single hue to a channel value.
 *
 * @param p - Lower intermediate value.
 * @param q - Upper intermediate value.
 * @param t - Hue offset for this channel.
 * @returns Channel value in [0, 1].
 */
function hueToChannel(p: number, q: number, t: number): number {
  const tNorm = ((t % 1) + 1) % 1; // wrap to [0, 1)
  if (tNorm < 1 / 6) return p + (q - p) * 6 * tNorm;
  if (tNorm < 1 / 2) return q;
  if (tNorm < 2 / 3) return p + (q - p) * (2 / 3 - tNorm) * 6;
  return p;
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

/**
 * Parses a CSS hex colour string (`#rrggbb`) into an {@link RgbColor}.
 *
 * @param hex - Six-digit hex string (with or without leading `#`).
 * @returns Parsed RGB values.
 * @throws {Error} If the string is not a valid six-digit hex colour.
 */
export function hexToRgb(hex: string): RgbColor {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length !== 6) {
    throw new Error(`hexToRgb: expected 6 hex digits, got "${hex}"`);
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/**
 * Packs three 0–255 RGB channels into a single `Uint32` in RGBA byte order
 * (`0xAABBGGRR` on little-endian x86, matching `Uint32Array` over
 * `Uint8ClampedArray` ImageData).
 *
 * @param r - Red channel [0, 255].
 * @param g - Green channel [0, 255].
 * @param b - Blue channel [0, 255].
 * @param a - Alpha channel [0, 255], defaults to 255 (fully opaque).
 * @returns Packed RGBA as a 32-bit unsigned integer.
 */
export function packRgba(r: number, g: number, b: number, a = 255): number {
  // On little-endian machines (all modern x86/ARM), ImageData byte layout is
  // [R, G, B, A] at byte offsets 0–3 within each uint32 word, so:
  //   packed = A << 24 | B << 16 | G << 8 | R
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Scales the luminosity of an {@link RgbColor} by `factor` (0 … 1).
 * Useful for making life cells dimmer when energy is low.
 *
 * @param color - Base colour.
 * @param factor - Brightness multiplier in [0, 1].
 * @returns New colour with scaled channels.
 */
export function scaleBrightness(color: RgbColor, factor: number): RgbColor {
  return {
    r: Math.round(color.r * factor),
    g: Math.round(color.g * factor),
    b: Math.round(color.b * factor),
  };
}

// ---------------------------------------------------------------------------
// Gamma correction — IEC 61966-2-1 sRGB transfer functions (Phase 16a)
//
// These TypeScript implementations are exact mirrors of the GLSL helpers in
// WebGLRenderer.ts (FRAG_SRC).  Keeping them in sync ensures that any
// CPU-side colour computation matches the GPU output.
// ---------------------------------------------------------------------------

/**
 * Converts a normalised sRGB channel value [0, 1] to linear light [0, 1].
 *
 * Uses the IEC 61966-2-1 piecewise transfer function.  All brightness
 * scaling and colour blending should be performed in linear light to
 * produce perceptually correct results.
 *
 * @param c - Gamma-compressed sRGB channel value in [0, 1].
 * @returns Linear light value in [0, 1].
 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Converts a linear light channel value [0, 1] to gamma-compressed sRGB [0, 1].
 *
 * Apply this as the final step when producing display pixel values so the
 * monitor receives correctly encoded sRGB output.
 *
 * @param c - Linear light channel value in [0, 1].
 * @returns sRGB gamma-encoded value in [0, 1].
 */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Converts an {@link RgbColor} from sRGB (0–255 channels) to linear light,
 * returning a new `{r, g, b}` triple with each channel in [0, 1].
 *
 * Useful for CPU-side colour blending that needs to match WebGL shader output.
 *
 * @param color - sRGB colour with channels in [0, 255].
 * @returns Linear light channels in [0, 1].
 */
export function rgbToLinear(color: RgbColor): { readonly r: number; readonly g: number; readonly b: number } {
  return {
    r: srgbToLinear(color.r / 255),
    g: srgbToLinear(color.g / 255),
    b: srgbToLinear(color.b / 255),
  };
}

/**
 * Converts a linear light `{r, g, b}` triple (channels in [0, 1]) to a
 * gamma-encoded {@link RgbColor} with integer channels in [0, 255].
 *
 * @param linear - Linear light channels, each in [0, 1].
 * @returns sRGB colour with channels in [0, 255].
 */
export function linearToRgb(linear: { readonly r: number; readonly g: number; readonly b: number }): RgbColor {
  return {
    r: Math.round(linearToSrgb(Math.max(0, Math.min(1, linear.r))) * 255),
    g: Math.round(linearToSrgb(Math.max(0, Math.min(1, linear.g))) * 255),
    b: Math.round(linearToSrgb(Math.max(0, Math.min(1, linear.b))) * 255),
  };
}
