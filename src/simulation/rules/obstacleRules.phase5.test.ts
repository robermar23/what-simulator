/**
 * @fileoverview Phase 5 unit tests for obstacleRules.ts additions.
 *
 * Covers the Phase 5 helper functions:
 *   - hasAdjacentDrain
 *   - hasAdjacentIce
 *   - hasAdjacentFire
 *   - calcGravityBias
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  hasAdjacentDrain,
  hasAdjacentIce,
  hasAdjacentFire,
  calcGravityBias,
} from './obstacleRules.js';
import { CellType } from '../GridState.js';

// ---------------------------------------------------------------------------
// hasAdjacentDrain
// ---------------------------------------------------------------------------

describe('hasAdjacentDrain', () => {
  it('returns true when a neighbour is Drain', () => {
    const cellType    = new Uint8Array([CellType.Empty, CellType.Drain, CellType.Life]);
    const neighborBuf = new Int32Array([1, 2]);
    expect(hasAdjacentDrain(neighborBuf, 2, cellType)).toBe(true);
  });

  it('returns false when no neighbour is Drain', () => {
    const cellType    = new Uint8Array([CellType.Life, CellType.Wall, CellType.Empty]);
    const neighborBuf = new Int32Array([0, 1, 2]);
    expect(hasAdjacentDrain(neighborBuf, 3, cellType)).toBe(false);
  });

  it('returns false with zero neighbours', () => {
    const cellType    = new Uint8Array([CellType.Drain]);
    const neighborBuf = new Int32Array([]);
    expect(hasAdjacentDrain(neighborBuf, 0, cellType)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasAdjacentIce
// ---------------------------------------------------------------------------

describe('hasAdjacentIce', () => {
  it('returns true when a neighbour is Ice', () => {
    const cellType    = new Uint8Array([CellType.Life, CellType.Ice]);
    const neighborBuf = new Int32Array([1]);
    expect(hasAdjacentIce(neighborBuf, 1, cellType)).toBe(true);
  });

  it('returns false when no neighbour is Ice', () => {
    const cellType    = new Uint8Array([CellType.Life, CellType.Toxin]);
    const neighborBuf = new Int32Array([1]);
    expect(hasAdjacentIce(neighborBuf, 1, cellType)).toBe(false);
  });

  it('returns false with zero neighbours', () => {
    const cellType    = new Uint8Array([CellType.Ice]);
    const neighborBuf = new Int32Array([]);
    expect(hasAdjacentIce(neighborBuf, 0, cellType)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasAdjacentFire
// ---------------------------------------------------------------------------

describe('hasAdjacentFire', () => {
  it('returns true when a neighbour is Fire', () => {
    const cellType    = new Uint8Array([CellType.Empty, CellType.Fire, CellType.Life]);
    const neighborBuf = new Int32Array([0, 1]);
    expect(hasAdjacentFire(neighborBuf, 2, cellType)).toBe(true);
  });

  it('returns false when no neighbour is Fire', () => {
    const cellType    = new Uint8Array([CellType.Wall, CellType.Toxin]);
    const neighborBuf = new Int32Array([0, 1]);
    expect(hasAdjacentFire(neighborBuf, 2, cellType)).toBe(false);
  });

  it('returns false with zero neighbours', () => {
    const cellType    = new Uint8Array([CellType.Fire]);
    const neighborBuf = new Int32Array([]);
    expect(hasAdjacentFire(neighborBuf, 0, cellType)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calcGravityBias
// ---------------------------------------------------------------------------

describe('calcGravityBias', () => {
  it('returns gravityStrength * gravityResponse when target IS the well (dist=0)', () => {
    // Well at (5, 5), target also at (5, 5) → dist² = 0 → maximum pull
    const bias = calcGravityBias(5, 5, 5, 5, 0.5, 1.0);
    expect(bias).toBeCloseTo(0.5);
  });

  it('decreases as distance increases (inverse-square falloff)', () => {
    const strength = 0.5;
    const response = 1.0;
    // Target at distance 1
    const bias1 = calcGravityBias(5, 5, 6, 5, strength, response);
    // Target at distance 2
    const bias2 = calcGravityBias(5, 5, 7, 5, strength, response);

    expect(bias1).toBeGreaterThan(bias2);
  });

  it('returns 0 when gravityStrength is 0', () => {
    const bias = calcGravityBias(0, 0, 1, 0, 0, 1.0);
    expect(bias).toBe(0);
  });

  it('returns 0 when gravityResponse is 0', () => {
    const bias = calcGravityBias(0, 0, 1, 0, 0.5, 0);
    expect(bias).toBe(0);
  });

  it('scales linearly with gravityResponse', () => {
    const bias1 = calcGravityBias(0, 0, 1, 0, 1.0, 0.5);
    const bias2 = calcGravityBias(0, 0, 1, 0, 1.0, 1.0);
    expect(bias2).toBeCloseTo(bias1 * 2);
  });

  it('is capped at gravityStrength', () => {
    // Very strong pull at dist=0 — result should not exceed gravityStrength.
    const bias = calcGravityBias(0, 0, 0, 0, 0.5, 1.0);
    expect(bias).toBeLessThanOrEqual(0.5 + 1e-10);
  });

  it('produces positive values for any non-zero strength/response', () => {
    const bias = calcGravityBias(10, 10, 11, 10, 0.3, 0.7);
    expect(bias).toBeGreaterThan(0);
  });
});
