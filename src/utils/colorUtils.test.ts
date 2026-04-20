/**
 * @fileoverview Unit tests for colorUtils.ts — colour conversion helpers.
 *
 * Covers:
 *   - hexToRgb: basic parsing and error handling
 *   - packRgba / scaleBrightness: existing packing helpers
 *   - srgbToLinear / linearToSrgb: Phase 16a gamma transfer functions
 *   - rgbToLinear / linearToRgb: convenience round-trip helpers
 *
 * The gamma tests are especially important because the GLSL shader in
 * WebGLRenderer.ts uses identical piecewise constants; any drift between
 * the TypeScript and GLSL implementations would produce inconsistent
 * CPU/GPU colour output.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  packRgba,
  scaleBrightness,
  hslToRgb,
  srgbToLinear,
  linearToSrgb,
  rgbToLinear,
  linearToRgb,
  type RgbColor,
} from './colorUtils.js';

// ---------------------------------------------------------------------------
// hexToRgb
// ---------------------------------------------------------------------------

describe('hexToRgb', () => {
  it('parses a six-digit hex string with leading #', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0,   b: 0   });
    expect(hexToRgb('#00ff00')).toEqual({ r: 0,   g: 255, b: 0   });
    expect(hexToRgb('#0000ff')).toEqual({ r: 0,   g: 0,   b: 255 });
  });

  it('parses a six-digit hex string without leading #', () => {
    expect(hexToRgb('ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('throws when the string does not have exactly six digits (after stripping #)', () => {
    // The implementation validates length only; these are too short or too long.
    expect(() => hexToRgb('#fff')).toThrow();
    expect(() => hexToRgb('#fffffff')).toThrow();
    expect(() => hexToRgb('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// packRgba
// ---------------------------------------------------------------------------

describe('packRgba', () => {
  it('packs pure red as 0xFF0000FF (little-endian RGBA)', () => {
    // byte 0 = R=255, byte 1 = G=0, byte 2 = B=0, byte 3 = A=255
    // packed = (255 << 24) | (0 << 16) | (0 << 8) | 255 = 0xFF0000FF
    expect(packRgba(255, 0, 0)).toBe(0xFF0000FF >>> 0);
  });

  it('alpha defaults to 255 (fully opaque)', () => {
    const withDefault  = packRgba(0, 255, 0);
    const withExplicit = packRgba(0, 255, 0, 255);
    expect(withDefault).toBe(withExplicit);
  });

  it('alpha 0 produces a fully transparent pixel', () => {
    const packed = packRgba(255, 255, 255, 0);
    // byte 3 = A should be 0
    expect((packed >>> 24) & 0xFF).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scaleBrightness
// ---------------------------------------------------------------------------

describe('scaleBrightness', () => {
  it('factor 1.0 returns the original colour channels', () => {
    const color: RgbColor = { r: 100, g: 150, b: 200 };
    expect(scaleBrightness(color, 1)).toEqual(color);
  });

  it('factor 0 returns black', () => {
    expect(scaleBrightness({ r: 255, g: 128, b: 64 }, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('factor 0.5 halves each channel (rounded)', () => {
    const result = scaleBrightness({ r: 200, g: 100, b: 50 }, 0.5);
    expect(result.r).toBe(100);
    expect(result.g).toBe(50);
    expect(result.b).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// hslToRgb
// ---------------------------------------------------------------------------

describe('hslToRgb', () => {
  it('hue 0° (red) at full saturation and 50% lightness returns #ff0000', () => {
    const { r, g, b } = hslToRgb(0, 1, 0.5);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('hue 120° (green) returns #00ff00', () => {
    const { r, g, b } = hslToRgb(120, 1, 0.5);
    expect(r).toBe(0);
    expect(g).toBe(255);
    expect(b).toBe(0);
  });

  it('saturation 0 produces a grey (r == g == b)', () => {
    const { r, g, b } = hslToRgb(200, 0, 0.5);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// srgbToLinear (Phase 16a)
// ---------------------------------------------------------------------------

describe('srgbToLinear', () => {
  it('maps 0.0 to 0.0 (black)', () => {
    expect(srgbToLinear(0)).toBe(0);
  });

  it('maps 1.0 to 1.0 (white)', () => {
    expect(srgbToLinear(1)).toBeCloseTo(1, 10);
  });

  it('uses the linear segment for values below the threshold (c <= 0.04045)', () => {
    // At exactly the threshold boundary: 0.04045 / 12.92 ≈ 0.003130
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 8);
  });

  it('uses the power segment for values above the threshold', () => {
    // 0.5 sRGB → linear: ((0.5 + 0.055) / 1.055) ^ 2.4 ≈ 0.21404
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404, 4);
  });

  it('is monotonically increasing across the full range', () => {
    // Sample 20 evenly spaced points; each must be > the previous.
    let prev = srgbToLinear(0);
    for (let i = 1; i <= 20; i++) {
      const curr = srgbToLinear(i / 20);
      expect(curr).toBeGreaterThan(prev);
      prev = curr;
    }
  });

  it('is continuous at the piecewise boundary (0.04045)', () => {
    // Both sides of the boundary must produce values within floating-point rounding.
    const below = srgbToLinear(0.04044);
    const above = srgbToLinear(0.04046);
    expect(Math.abs(above - below)).toBeLessThan(0.0001);
  });

  it('produces a value less than the sRGB input for mid-range values (gamma effect)', () => {
    // In sRGB, 0.5 appears brighter than 50% linear — so linear(0.5) < 0.5.
    expect(srgbToLinear(0.5)).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// linearToSrgb (Phase 16a)
// ---------------------------------------------------------------------------

describe('linearToSrgb', () => {
  it('maps 0.0 to 0.0', () => {
    expect(linearToSrgb(0)).toBe(0);
  });

  it('maps 1.0 to 1.0', () => {
    expect(linearToSrgb(1)).toBeCloseTo(1, 10);
  });

  it('uses the linear segment for values below the threshold (c <= 0.0031308)', () => {
    expect(linearToSrgb(0.001)).toBeCloseTo(0.001 * 12.92, 8);
  });

  it('produces a value greater than the linear input for mid-range values (gamma encode)', () => {
    // Gamma encoding makes mid-range linear values appear brighter on screen.
    expect(linearToSrgb(0.5)).toBeGreaterThan(0.5);
  });

  it('is monotonically increasing', () => {
    let prev = linearToSrgb(0);
    for (let i = 1; i <= 20; i++) {
      const curr = linearToSrgb(i / 20);
      expect(curr).toBeGreaterThan(prev);
      prev = curr;
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip: srgbToLinear ↔ linearToSrgb (Phase 16a)
// ---------------------------------------------------------------------------

describe('srgbToLinear / linearToSrgb round-trip', () => {
  const samplePoints = [0, 0.04045, 0.1, 0.2, 0.5, 0.75, 0.9, 1.0];

  it('round-trips sRGB → linear → sRGB within floating-point tolerance', () => {
    for (const v of samplePoints) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });

  it('round-trips linear → sRGB → linear within floating-point tolerance', () => {
    for (const v of samplePoints) {
      expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 6);
    }
  });

  it('a 50% energy cell appears at approximately 50% perceived brightness', () => {
    // The Life cell at 50% energy has brightness = 0.15 + 0.85 * 0.5 = 0.575.
    // In linear space, 0.575 linear of the sRGB base green (#00ff88 = linear 1.0 green).
    // The sRGB-encoded output should be linearToSrgb(0.575) ≈ 0.782.
    // This test verifies that the output is NOT 0.575 (i.e. gamma IS being applied).
    const linearBrightness = 0.575;
    const srgbOut = linearToSrgb(linearBrightness);
    expect(srgbOut).toBeGreaterThan(linearBrightness); // gamma > 1 lifts mid-tones
    expect(srgbOut).toBeCloseTo(0.782, 2);
  });
});

// ---------------------------------------------------------------------------
// rgbToLinear / linearToRgb (Phase 16a convenience helpers)
// ---------------------------------------------------------------------------

describe('rgbToLinear', () => {
  it('converts #ff0000 (pure red) to linear (1, 0, 0)', () => {
    const lin = rgbToLinear({ r: 255, g: 0, b: 0 });
    expect(lin.r).toBeCloseTo(1, 5);
    expect(lin.g).toBeCloseTo(0, 5);
    expect(lin.b).toBeCloseTo(0, 5);
  });

  it('converts #000000 (black) to (0, 0, 0)', () => {
    const lin = rgbToLinear({ r: 0, g: 0, b: 0 });
    expect(lin.r).toBe(0);
    expect(lin.g).toBe(0);
    expect(lin.b).toBe(0);
  });

  it('mid-grey #808080 converts to approximately linear 0.216', () => {
    // 128/255 ≈ 0.502 sRGB → srgbToLinear(0.502) ≈ 0.216
    const lin = rgbToLinear({ r: 128, g: 128, b: 128 });
    expect(lin.r).toBeCloseTo(0.216, 2);
    expect(lin.r).toBe(lin.g);
    expect(lin.g).toBe(lin.b);
  });
});

describe('linearToRgb', () => {
  it('converts linear (1, 0, 0) back to #ff0000', () => {
    expect(linearToRgb({ r: 1, g: 0, b: 0 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('converts linear (0, 0, 0) to #000000', () => {
    expect(linearToRgb({ r: 0, g: 0, b: 0 })).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('clamps out-of-range linear values', () => {
    const result = linearToRgb({ r: 2.0, g: -0.5, b: 0.5 });
    expect(result.r).toBe(255); // clamped to 1 before encode
    expect(result.g).toBe(0);   // clamped to 0 before encode
    expect(result.b).toBeGreaterThan(0);
    expect(result.b).toBeLessThan(255);
  });

  it('round-trips an sRGB colour through rgbToLinear → linearToRgb within ±1 channel', () => {
    // ±1 rounding error is acceptable for 8-bit integer round-trips.
    const original: RgbColor = { r: 100, g: 150, b: 200 };
    const linear  = rgbToLinear(original);
    const roundTripped = linearToRgb(linear);
    expect(Math.abs(roundTripped.r - original.r)).toBeLessThanOrEqual(1);
    expect(Math.abs(roundTripped.g - original.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(roundTripped.b - original.b)).toBeLessThanOrEqual(1);
  });
});
