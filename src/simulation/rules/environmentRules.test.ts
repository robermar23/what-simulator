/**
 * @fileoverview Unit tests for environmentRules.ts (Phase 5).
 *
 * Covers Barrier decay / expiry and Fire burndown / spread helpers.
 * All functions are pure — no DOM, no workers required.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  calcBarrierEnergy,
  isBarrierExpired,
  calcFireBurndown,
  spreadFire,
} from './environmentRules.js';
import { CellType } from '../GridState.js';

// ---------------------------------------------------------------------------
// Barrier tests
// ---------------------------------------------------------------------------

describe('calcBarrierEnergy', () => {
  it('returns 1.0 at age 0 (freshly placed)', () => {
    expect(calcBarrierEnergy(0, 200)).toBeCloseTo(1.0);
  });

  it('returns 0.5 at exactly half lifetime', () => {
    expect(calcBarrierEnergy(100, 200)).toBeCloseTo(0.5);
  });

  it('returns 0 at age == barrierLifetime (exactly expired)', () => {
    expect(calcBarrierEnergy(200, 200)).toBeCloseTo(0);
  });

  it('clamps to 0 when age exceeds lifetime', () => {
    expect(calcBarrierEnergy(300, 200)).toBe(0);
  });

  it('returns 0 when barrierLifetime is 0 (guard against divide-by-zero)', () => {
    expect(calcBarrierEnergy(0, 0)).toBe(0);
  });

  it('produces linearly decreasing values', () => {
    const e1 = calcBarrierEnergy(50, 200);
    const e2 = calcBarrierEnergy(100, 200);
    const e3 = calcBarrierEnergy(150, 200);
    expect(e1).toBeGreaterThan(e2);
    expect(e2).toBeGreaterThan(e3);
  });
});

describe('isBarrierExpired', () => {
  it('returns false when age < barrierLifetime', () => {
    expect(isBarrierExpired(199, 200)).toBe(false);
  });

  it('returns true when age == barrierLifetime', () => {
    expect(isBarrierExpired(200, 200)).toBe(true);
  });

  it('returns true when age > barrierLifetime', () => {
    expect(isBarrierExpired(500, 200)).toBe(true);
  });

  it('returns true at age 0 when lifetime is 0', () => {
    expect(isBarrierExpired(0, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fire burndown tests
// ---------------------------------------------------------------------------

describe('calcFireBurndown', () => {
  it('reduces energy by fireBurnRate', () => {
    expect(calcFireBurndown(1.0, 0.01)).toBeCloseTo(0.99);
  });

  it('clamps to 0 when energy would go negative', () => {
    expect(calcFireBurndown(0.005, 0.01)).toBe(0);
  });

  it('returns exactly 0 when energy equals fireBurnRate', () => {
    expect(calcFireBurndown(0.01, 0.01)).toBeCloseTo(0);
  });

  it('does not go below 0', () => {
    expect(calcFireBurndown(0, 0.005)).toBe(0);
  });

  it('decrements correctly across multiple steps', () => {
    let e = 1.0;
    const rate = 0.1;
    for (let i = 0; i < 10; i++) e = calcFireBurndown(e, rate);
    expect(e).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// Fire spread tests
// ---------------------------------------------------------------------------

describe('spreadFire', () => {
  /**
   * Helper: builds minimal TypedArrays for a 3×1 grid:
   *   index 0 = left, index 1 = centre (fire), index 2 = right
   */
  function makeGridArrays(
    types: number[],
    energies?: number[],
  ): {
    ftType: Uint8Array;
    bkType: Uint8Array;
    bkEnergy: Float32Array;
  } {
    const n = types.length;
    return {
      ftType:   new Uint8Array(types),
      bkType:   new Uint8Array(types),     // starts as copy of front
      bkEnergy: new Float32Array(energies ?? new Array(n).fill(0.5)),
    };
  }

  it('converts adjacent Life cell to Fire at full energy', () => {
    // Grid: [Life, Fire, Empty]
    const { ftType, bkType, bkEnergy } = makeGridArrays([
      CellType.Life, CellType.Fire, CellType.Empty,
    ]);
    const neighborBuf = new Int32Array([0, 2]); // neighbours of index 1

    spreadFire(2, neighborBuf, ftType, bkType, bkEnergy);

    expect(bkType[0]).toBe(CellType.Fire);
    expect(bkEnergy[0]).toBe(1.0);
  });

  it('converts adjacent LifeVariant cell to Fire at full energy', () => {
    const { ftType, bkType, bkEnergy } = makeGridArrays([
      CellType.LifeVariant, CellType.Fire, CellType.Empty,
    ]);
    const neighborBuf = new Int32Array([0, 2]);

    spreadFire(2, neighborBuf, ftType, bkType, bkEnergy);

    expect(bkType[0]).toBe(CellType.Fire);
    expect(bkEnergy[0]).toBe(1.0);
  });

  it('converts adjacent Nutrient cell to Fire at full energy', () => {
    const { ftType, bkType, bkEnergy } = makeGridArrays([
      CellType.Nutrient, CellType.Fire, CellType.Empty,
    ]);
    const neighborBuf = new Int32Array([0, 2]);

    spreadFire(2, neighborBuf, ftType, bkType, bkEnergy);

    expect(bkType[0]).toBe(CellType.Fire);
    expect(bkEnergy[0]).toBe(1.0);
  });

  it('does NOT spread to Empty cells', () => {
    const { ftType, bkType, bkEnergy } = makeGridArrays([
      CellType.Empty, CellType.Fire, CellType.Empty,
    ]);
    const neighborBuf = new Int32Array([0, 2]);

    spreadFire(2, neighborBuf, ftType, bkType, bkEnergy);

    expect(bkType[0]).toBe(CellType.Empty);
    expect(bkType[2]).toBe(CellType.Empty);
  });

  it('does NOT spread to Wall cells', () => {
    const { ftType, bkType, bkEnergy } = makeGridArrays([
      CellType.Wall, CellType.Fire, CellType.Wall,
    ]);
    const neighborBuf = new Int32Array([0, 2]);

    spreadFire(2, neighborBuf, ftType, bkType, bkEnergy);

    expect(bkType[0]).toBe(CellType.Wall);
    expect(bkType[2]).toBe(CellType.Wall);
  });

  it('does NOT spread to Toxin cells', () => {
    const { ftType, bkType, bkEnergy } = makeGridArrays([
      CellType.Toxin, CellType.Fire, CellType.Ice,
    ]);
    const neighborBuf = new Int32Array([0, 2]);

    spreadFire(2, neighborBuf, ftType, bkType, bkEnergy);

    expect(bkType[0]).toBe(CellType.Toxin);
    expect(bkType[2]).toBe(CellType.Ice);
  });

  it('spreads to all eligible neighbours in one call', () => {
    // Grid: [Life, Fire, Nutrient] — fire at index 1, both neighbours are flammable
    const { ftType, bkType, bkEnergy } = makeGridArrays([
      CellType.Life, CellType.Fire, CellType.Nutrient,
    ]);
    const neighborBuf = new Int32Array([0, 2]);

    spreadFire(2, neighborBuf, ftType, bkType, bkEnergy);

    expect(bkType[0]).toBe(CellType.Fire);
    expect(bkType[2]).toBe(CellType.Fire);
  });

  it('handles nLen = 0 without error', () => {
    const { ftType, bkType, bkEnergy } = makeGridArrays([CellType.Fire]);
    const neighborBuf = new Int32Array([]);

    expect(() => spreadFire(0, neighborBuf, ftType, bkType, bkEnergy)).not.toThrow();
  });
});
