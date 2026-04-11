/**
 * @fileoverview Unit tests for math utility functions.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  toIndex, fromIndex,
  vonNeumannNeighbors, mooreNeighbors,
  clamp, lerp, randomInt,
} from './math.js';

// ---------------------------------------------------------------------------
// toIndex / fromIndex round-trip
// ---------------------------------------------------------------------------

describe('toIndex / fromIndex', () => {
  it('converts (0, 0) to index 0', () => {
    expect(toIndex(0, 0, 10)).toBe(0);
  });

  it('converts (x, y) to the expected flat index', () => {
    expect(toIndex(3, 2, 10)).toBe(23); // 2 * 10 + 3
  });

  it('round-trips correctly for various coordinates', () => {
    const W = 16;
    const H = 16;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = toIndex(x, y, W);
        const [rx, ry] = fromIndex(i, W);
        expect(rx).toBe(x);
        expect(ry).toBe(y);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// vonNeumannNeighbors
// ---------------------------------------------------------------------------

describe('vonNeumannNeighbors', () => {
  it('returns 2 neighbours for a corner cell', () => {
    const neighbors = vonNeumannNeighbors(0, 5, 5);
    expect(neighbors.length).toBe(2);
  });

  it('returns 3 neighbours for an edge (non-corner) cell', () => {
    const neighbors = vonNeumannNeighbors(1, 5, 5); // top edge
    expect(neighbors.length).toBe(3);
  });

  it('returns 4 neighbours for an interior cell', () => {
    // Centre of a 5×5 grid = index 12
    const neighbors = vonNeumannNeighbors(12, 5, 5);
    expect(neighbors.length).toBe(4);
  });

  it('does not include the cell itself', () => {
    const i = 12;
    const neighbors = vonNeumannNeighbors(i, 5, 5);
    expect(neighbors).not.toContain(i);
  });

  it('returns only cardinal directions (no diagonals)', () => {
    const i = toIndex(2, 2, 5); // (2,2) = index 12
    const neighbors = vonNeumannNeighbors(i, 5, 5);
    const expected = [
      toIndex(2, 1, 5), // N
      toIndex(2, 3, 5), // S
      toIndex(1, 2, 5), // W
      toIndex(3, 2, 5), // E
    ];
    expect([...neighbors].sort()).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------
// mooreNeighbors
// ---------------------------------------------------------------------------

describe('mooreNeighbors', () => {
  it('returns 8 neighbours for an interior cell', () => {
    const neighbors = mooreNeighbors(12, 5, 5);
    expect(neighbors.length).toBe(8);
  });

  it('returns 3 neighbours for a corner cell', () => {
    const neighbors = mooreNeighbors(0, 5, 5); // top-left corner
    expect(neighbors.length).toBe(3);
  });

  it('returns 5 neighbours for an edge (non-corner) cell', () => {
    const neighbors = mooreNeighbors(1, 5, 5); // top edge
    expect(neighbors.length).toBe(5);
  });

  it('does not include the cell itself', () => {
    const i = 12;
    const neighbors = mooreNeighbors(i, 5, 5);
    expect(neighbors).not.toContain(i);
  });

  it('includes diagonals in addition to cardinals', () => {
    const i = toIndex(2, 2, 5);
    const neighbors = mooreNeighbors(i, 5, 5);
    const topLeft = toIndex(1, 1, 5);
    expect(neighbors).toContain(topLeft);
  });
});

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------

describe('clamp', () => {
  it('returns the value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps below minimum', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it('clamps above maximum', () => {
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('returns min when value equals min', () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lerp
// ---------------------------------------------------------------------------

describe('lerp', () => {
  it('returns a at t=0', () => {
    expect(lerp(0, 100, 0)).toBe(0);
  });

  it('returns b at t=1', () => {
    expect(lerp(0, 100, 1)).toBe(100);
  });

  it('returns midpoint at t=0.5', () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// randomInt
// ---------------------------------------------------------------------------

describe('randomInt', () => {
  it('always returns integers in [0, max)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomInt(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
