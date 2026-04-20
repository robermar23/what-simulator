/**
 * @fileoverview Unit tests for ColorMap.ts — colour lookup table, OKLab
 * conversions, and per-render-mode colour functions.
 *
 * Covers Phase 16b additions:
 *   - oklabToSrgb: conversion accuracy, achromatic axis, gamut clamping
 *   - VARIANT_PALETTE: perceptual uniformity across variants 1–255
 *   - genomeColorFor: OKLab interpolation endpoints and energy modulation
 *   - genomeColorFor: hue ordering (blue < neutral < red)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  buildColorLUT,
  lookupColor,
  ENERGY_STEPS,
  COLOR_LUT,
  VARIANT_PALETTE,
  VARIANT_COUNT,
  LIFECYCLE_COLORS,
  lifecycleColorFor,
  LIFECYCLE_FLAG_JUVENILE,
  LIFECYCLE_FLAG_SENESCENT,
  genomeColorFor,
  generationColorFor,
  fitnessColorFor,
  signalColorFor,
  oklabToSrgb,
} from './ColorMap.js';
import { srgbToLinear } from '../utils/colorUtils.js';
import { CellType } from '../simulation/GridState.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unpacks the R, G, B channels from a little-endian packed Uint32 RGBA word.
 * Format: (A << 24) | (B << 16) | (G << 8) | R
 */
function unpackRgb(packed: number): { r: number; g: number; b: number } {
  return {
    r:  packed        & 0xFF,
    g: (packed >>  8) & 0xFF,
    b: (packed >> 16) & 0xFF,
  };
}

/**
 * Computes the relative luminance (Y) of an sRGB colour (channels 0–255).
 * Y = 0.2126·R_lin + 0.7152·G_lin + 0.0722·B_lin
 *
 * Used to verify perceptual uniformity of the VARIANT_PALETTE.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r / 255)
       + 0.7152 * srgbToLinear(g / 255)
       + 0.0722 * srgbToLinear(b / 255);
}

// ---------------------------------------------------------------------------
// buildColorLUT / lookupColor (existing — smoke tests)
// ---------------------------------------------------------------------------

describe('buildColorLUT', () => {
  it('returns a Uint32Array of the expected size', () => {
    const lut = buildColorLUT();
    expect(lut).toBeInstanceOf(Uint32Array);
    expect(lut.length).toBe(16 * ENERGY_STEPS);
  });

  it('COLOR_LUT singleton has the same length as a fresh build', () => {
    expect(COLOR_LUT.length).toBe(buildColorLUT().length);
  });

  it('lookupColor clamps energy outside [0,1] without throwing', () => {
    expect(() => lookupColor(COLOR_LUT, CellType.Life, -0.5)).not.toThrow();
    expect(() => lookupColor(COLOR_LUT, CellType.Life,  1.5)).not.toThrow();
  });

  it('Life cell at full energy returns a non-zero packed colour', () => {
    const packed = lookupColor(COLOR_LUT, CellType.Life, 1.0);
    expect(packed).toBeGreaterThan(0);
  });

  it('Empty cell is fully opaque (alpha byte = 255)', () => {
    const packed = lookupColor(COLOR_LUT, CellType.Empty, 0);
    expect((packed >>> 24) & 0xFF).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// oklabToSrgb (Phase 16b)
// ---------------------------------------------------------------------------

describe('oklabToSrgb', () => {
  it('black: OKLab(0, 0, 0) → (0, 0, 0)', () => {
    const { r, g, b } = oklabToSrgb(0, 0, 0);
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('white: OKLab(1, 0, 0) → approximately (255, 255, 255)', () => {
    const { r, g, b } = oklabToSrgb(1, 0, 0);
    // At L=1, a=0, b=0 → linear sRGB = (1,1,1) → sRGB (255,255,255).
    // Allow ±2 for floating-point rounding.
    expect(r).toBeGreaterThanOrEqual(253);
    expect(g).toBeGreaterThanOrEqual(253);
    expect(b).toBeGreaterThanOrEqual(253);
  });

  it('achromatic: OKLab(0.72, 0, 0) → r ≈ g ≈ b (neutral grey)', () => {
    // On the OKLab L axis (a=b=0) all hues collapse to grey; channels must match.
    const { r, g, b } = oklabToSrgb(0.72, 0, 0);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
    // At L=0.72: linear grey = 0.72^3 ≈ 0.373 → sRGB ≈ 164
    expect(r).toBeGreaterThan(150);
    expect(r).toBeLessThan(180);
  });

  it('clamps out-of-gamut values: no channel exceeds 255 or goes below 0', () => {
    // Extreme chroma values that push outside the sRGB cube.
    const cases: Array<[number, number, number]> = [
      [0.72,  0.5,  0.5],
      [0.72, -0.5, -0.5],
      [0.5,   0.3,  0.0],
      [0.9,   0.0,  0.5],
    ];
    for (const [L, a, b] of cases) {
      const { r, g, b: bCh } = oklabToSrgb(L, a, b);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(bCh).toBeGreaterThanOrEqual(0);
      expect(bCh).toBeLessThanOrEqual(255);
    }
  });

  it('returns integer channel values (no fractional bytes)', () => {
    const { r, g, b } = oklabToSrgb(0.65, 0.08, -0.10);
    expect(Number.isInteger(r)).toBe(true);
    expect(Number.isInteger(g)).toBe(true);
    expect(Number.isInteger(b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VARIANT_PALETTE — perceptual uniformity (Phase 16b)
// ---------------------------------------------------------------------------

describe('VARIANT_PALETTE', () => {
  it('has exactly VARIANT_COUNT entries', () => {
    expect(VARIANT_PALETTE.length).toBe(VARIANT_COUNT);
    expect(VARIANT_COUNT).toBe(256);
  });

  it('variant 0 is the base Life green #00ff88', () => {
    const { r, g, b } = unpackRgb(VARIANT_PALETTE[0]);
    expect(r).toBe(0x00);
    expect(g).toBe(0xff);
    expect(b).toBe(0x88);
  });

  it('all entries are fully opaque (alpha = 255)', () => {
    for (let v = 0; v < VARIANT_COUNT; v++) {
      expect((VARIANT_PALETTE[v] >>> 24) & 0xFF).toBe(255);
    }
  });

  it('variants 1–255 have equal perceived brightness (luminance variation < 0.10)', () => {
    // OKLab guarantees constant perceived lightness (L=0.72) across all hues.
    // The luminance spread should be far smaller than it was with HSL.
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = 1; v < VARIANT_COUNT; v++) {
      const { r, g, b } = unpackRgb(VARIANT_PALETTE[v]);
      const Y = relativeLuminance(r, g, b);
      if (Y < minY) minY = Y;
      if (Y > maxY) maxY = Y;
    }
    // The spread must be under 10% of the [0,1] luminance range.
    expect(maxY - minY).toBeLessThan(0.10);
  });

  it('adjacent variants have distinct colours (golden-angle spread)', () => {
    // No two adjacent variant IDs (1–255) should produce identical packed values.
    let duplicates = 0;
    for (let v = 1; v < VARIANT_COUNT - 1; v++) {
      if (VARIANT_PALETTE[v] === VARIANT_PALETTE[v + 1]) duplicates++;
    }
    expect(duplicates).toBe(0);
  });

  it('all variants 1–255 produce non-grey colours (chroma > 0)', () => {
    // With C=0.12, every variant should have clear colour (r≠g or g≠b).
    let greyCount = 0;
    for (let v = 1; v < VARIANT_COUNT; v++) {
      const { r, g, b } = unpackRgb(VARIANT_PALETTE[v]);
      if (Math.abs(r - g) < 5 && Math.abs(g - b) < 5) greyCount++;
    }
    // At most a handful of near-grey entries due to gamut clamping near neutral.
    expect(greyCount).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// genomeColorFor — OKLab interpolation (Phase 16b)
// ---------------------------------------------------------------------------

describe('genomeColorFor', () => {
  it('returns a fully-opaque packed colour', () => {
    const packed = genomeColorFor(0x8000, 1.0);
    expect((packed >>> 24) & 0xFF).toBe(255);
  });

  it('low genome (0x0000) produces a blue-dominant colour', () => {
    const { r, g, b } = unpackRgb(genomeColorFor(0x0000, 1.0));
    // Blue endpoint: OKLab(0.55, -0.05, -0.22) → strong blue component.
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('high genome (0xFFFF) produces a red-dominant colour', () => {
    const { r, g, b } = unpackRgb(genomeColorFor(0xFFFF, 1.0));
    // Red endpoint: OKLab(0.55, +0.18, +0.10) → strong red component.
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('mid genome (~0x8000) produces a green-dominant colour', () => {
    const { r, g, b } = unpackRgb(genomeColorFor(0x8000, 1.0));
    // Green midpoint: OKLab(0.72, -0.17, +0.12) → green dominates.
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('low energy dims the colour proportionally', () => {
    const full = unpackRgb(genomeColorFor(0x8000, 1.0));
    const dim  = unpackRgb(genomeColorFor(0x8000, 0.0));
    // At energy=0, brightness = 0.15 (minBrightness) → all channels much darker.
    expect(dim.r).toBeLessThan(full.r);
    expect(dim.g).toBeLessThan(full.g);
  });

  it('energy=0 still produces a non-black colour (minBrightness=15%)', () => {
    // The genome colour should never go fully black.
    const { r, g, b } = unpackRgb(genomeColorFor(0x8000, 0.0));
    expect(r + g + b).toBeGreaterThan(0);
  });

  it('is monotonically darker as energy decreases from 1 to 0', () => {
    // Sample the green midpoint at several energy levels.
    let prevLuminance = relativeLuminance(
      ...Object.values(unpackRgb(genomeColorFor(0x8000, 1.0))) as [number, number, number],
    );
    for (const energy of [0.75, 0.5, 0.25, 0.0]) {
      const { r, g, b } = unpackRgb(genomeColorFor(0x8000, energy));
      const Y = relativeLuminance(r, g, b);
      expect(Y).toBeLessThan(prevLuminance);
      prevLuminance = Y;
    }
  });

  it('low and high genome endpoints have similar perceived brightness at full energy', () => {
    // OKLab ensures perceptually equal lightness at the endpoints (both L=0.55).
    const { r: r0, g: g0, b: b0 } = unpackRgb(genomeColorFor(0x0000, 1.0));
    const { r: r1, g: g1, b: b1 } = unpackRgb(genomeColorFor(0xFFFF, 1.0));
    const Y0 = relativeLuminance(r0, g0, b0);
    const Y1 = relativeLuminance(r1, g1, b1);
    // With OKLab both endpoints have L=0.55 — luminances should be much closer
    // than they were with HSL (which has a ≈ 3× difference between blue and red).
    expect(Math.abs(Y0 - Y1)).toBeLessThan(0.12);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle colour helpers (existing — smoke tests)
// ---------------------------------------------------------------------------

describe('lifecycleColorFor', () => {
  it('JUVENILE flag returns bright lime (high green channel)', () => {
    const packed = lifecycleColorFor(LIFECYCLE_FLAG_JUVENILE, 1.0);
    const { g } = unpackRgb(packed);
    expect(g).toBeGreaterThan(200);
  });

  it('SENESCENT flag returns purple-pink (red ≈ blue, both > green)', () => {
    const packed = lifecycleColorFor(LIFECYCLE_FLAG_SENESCENT, 1.0);
    const { r, g, b } = unpackRgb(packed);
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
  });

  it('neither flag returns a green-dominant colour (mature)', () => {
    const packed = lifecycleColorFor(0, 1.0);
    const { r, g, b } = unpackRgb(packed);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('LIFECYCLE_COLORS constants are fully opaque', () => {
    expect((LIFECYCLE_COLORS.JUVENILE  >>> 24) & 0xFF).toBe(255);
    expect((LIFECYCLE_COLORS.MATURE    >>> 24) & 0xFF).toBe(255);
    expect((LIFECYCLE_COLORS.SENESCENT >>> 24) & 0xFF).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// generationColorFor / fitnessColorFor / signalColorFor (smoke tests)
// ---------------------------------------------------------------------------

describe('generationColorFor', () => {
  it('returns a fully-opaque colour', () => {
    expect((generationColorFor(0, 1.0) >>> 24) & 0xFF).toBe(255);
  });

  it('young cells (gen=0) are more cyan than amber', () => {
    const { r, b } = unpackRgb(generationColorFor(0, 1.0));
    expect(b).toBeGreaterThan(r);
  });

  it('old cells (gen=500+) are more amber than cyan', () => {
    const { r, b } = unpackRgb(generationColorFor(1000, 1.0));
    expect(r).toBeGreaterThan(b);
  });
});

describe('fitnessColorFor', () => {
  it('low fitness produces a dark olive (dim overall)', () => {
    const { r, g, b } = unpackRgb(fitnessColorFor(0.0, 0.0));
    expect(r + g + b).toBeLessThan(200);
  });

  it('high fitness produces a bright gold (high red + green, low blue)', () => {
    const { r, g, b } = unpackRgb(fitnessColorFor(1.0, 0.3));
    expect(r).toBeGreaterThan(150);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(50);
  });
});

describe('signalColorFor', () => {
  it('zero signal returns the base colour unchanged', () => {
    const base = 0xFF336699; // arbitrary packed RGBA
    expect(signalColorFor(0, base)).toBe(base);
  });

  it('full signal blends toward cyan (high green + blue, low red)', () => {
    const { r, g, b } = unpackRgb(signalColorFor(1.0, 0xFF000000));
    expect(g).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(r);
  });
});
