/**
 * @fileoverview Unit tests for obstacleRules.ts.
 *
 * All tests use plain TypedArrays — no DOM, no canvas, no simulation engine.
 *
 * Scenarios covered:
 *   calcToxinDamage:
 *     - Returns 0 when no adjacent Toxin cell.
 *     - Returns negative delta when a Toxin neighbour is present.
 *     - Full toxinResistance (1.0) reduces damage to zero.
 *     - Partial resistance reduces damage proportionally.
 *
 *   calcNutrientBoost:
 *     - Returns 0 when no adjacent Nutrient cell.
 *     - Returns positive delta when a Nutrient neighbour is present.
 *     - Zero nutrientAbsorption gives no boost.
 *     - Partial absorption scales the boost.
 *
 *   isEnterable:
 *     - Empty, Toxin, Nutrient → true (passable).
 *     - Wall, Life, LifeVariant → false (blocked or occupied).
 *
 *   calcSpreadEnergy:
 *     - Empty target → base initialEnergy unchanged.
 *     - Toxin target → energy reduced by entry damage.
 *     - Toxin target with full resistance → no reduction.
 *     - Nutrient target → energy boosted above initialEnergy.
 *     - Result is clamped to [0.01, 1.0] in extreme cases.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  calcToxinDamage,
  calcNutrientBoost,
  isEnterable,
  calcSpreadEnergy,
} from './obstacleRules.js';
import { CellType } from '../GridState.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal neighbor buffer and cell-type array
// ---------------------------------------------------------------------------

/**
 * Creates a test fixture with a pre-filled neighborBuf and cellType array.
 *
 * @param neighborTypes - CellType for each neighbor slot (index 0..n-1).
 * @param totalCells - Size of the cellType array (must be ≥ neighborTypes.length).
 * @returns `{ neighborBuf, nLen, frontCellType }` ready to pass to rule functions.
 */
function makeFixture(
  neighborTypes: readonly CellType[],
  totalCells = 16,
): { neighborBuf: Int32Array; nLen: number; frontCellType: Uint8Array } {
  // Assign each neighbor a sequential cell index starting at 0.
  const neighborBuf   = new Int32Array(8);
  const frontCellType = new Uint8Array(totalCells);

  for (let k = 0; k < neighborTypes.length; k++) {
    neighborBuf[k]          = k;
    frontCellType[k]        = neighborTypes[k];
  }

  return { neighborBuf, nLen: neighborTypes.length, frontCellType };
}

// ---------------------------------------------------------------------------
// calcToxinDamage
// ---------------------------------------------------------------------------

describe('calcToxinDamage', () => {
  it('returns 0 when no neighbours are Toxin', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([
      CellType.Empty, CellType.Life, CellType.Wall,
    ]);
    const result = calcToxinDamage(neighborBuf, nLen, frontCellType, 0.05, 0.0);
    expect(result).toBe(0);
  });

  it('returns a negative delta when a Toxin neighbour is present', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([
      CellType.Empty, CellType.Toxin,
    ]);
    const result = calcToxinDamage(neighborBuf, nLen, frontCellType, 0.05, 0.0);
    // Damage = -(0.05 * (1 - 0)) = -0.05
    expect(result).toBeCloseTo(-0.05, 5);
  });

  it('full toxinResistance (1.0) reduces damage to zero', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([CellType.Toxin]);
    const result = calcToxinDamage(neighborBuf, nLen, frontCellType, 0.05, 1.0);
    expect(result).toBeCloseTo(0, 5);
  });

  it('partial resistance scales damage proportionally', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([CellType.Toxin]);
    // resistance 0.5 → damage = -(0.1 * 0.5) = -0.05
    const result = calcToxinDamage(neighborBuf, nLen, frontCellType, 0.1, 0.5);
    expect(result).toBeCloseTo(-0.05, 5);
  });

  it('only uses the first Toxin found (multiple toxins do not stack)', () => {
    // Two Toxin neighbours — still returns one hit worth of damage.
    const { neighborBuf, nLen, frontCellType } = makeFixture([
      CellType.Toxin, CellType.Toxin,
    ]);
    const result = calcToxinDamage(neighborBuf, nLen, frontCellType, 0.05, 0.0);
    // Should be exactly -0.05, not -0.10.
    expect(result).toBeCloseTo(-0.05, 5);
  });

  it('returns 0 for an empty neighbour buffer (nLen = 0)', () => {
    const neighborBuf   = new Int32Array(8);
    const frontCellType = new Uint8Array(4);
    expect(calcToxinDamage(neighborBuf, 0, frontCellType, 0.1, 0.0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calcNutrientBoost
// ---------------------------------------------------------------------------

describe('calcNutrientBoost', () => {
  it('returns 0 when no neighbours are Nutrient', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([
      CellType.Empty, CellType.Wall, CellType.Life,
    ]);
    const result = calcNutrientBoost(neighborBuf, nLen, frontCellType, 0.02, 1.0);
    expect(result).toBe(0);
  });

  it('returns a positive delta when a Nutrient neighbour is present', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([CellType.Nutrient]);
    const result = calcNutrientBoost(neighborBuf, nLen, frontCellType, 0.02, 1.0);
    expect(result).toBeCloseTo(0.02, 5);
  });

  it('zero nutrientAbsorption gives no boost', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([CellType.Nutrient]);
    const result = calcNutrientBoost(neighborBuf, nLen, frontCellType, 0.02, 0.0);
    expect(result).toBeCloseTo(0, 5);
  });

  it('partial absorption scales the boost', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([CellType.Nutrient]);
    // absorption 0.5 → boost = 0.04 * 0.5 = 0.02
    const result = calcNutrientBoost(neighborBuf, nLen, frontCellType, 0.04, 0.5);
    expect(result).toBeCloseTo(0.02, 5);
  });

  it('only uses first Nutrient found (multiple nutrients do not stack)', () => {
    const { neighborBuf, nLen, frontCellType } = makeFixture([
      CellType.Nutrient, CellType.Nutrient,
    ]);
    const result = calcNutrientBoost(neighborBuf, nLen, frontCellType, 0.02, 1.0);
    // Should equal one boost, not two.
    expect(result).toBeCloseTo(0.02, 5);
  });

  it('returns 0 for an empty neighbour buffer (nLen = 0)', () => {
    const neighborBuf   = new Int32Array(8);
    const frontCellType = new Uint8Array(4);
    expect(calcNutrientBoost(neighborBuf, 0, frontCellType, 0.02, 1.0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isEnterable
// ---------------------------------------------------------------------------

describe('isEnterable', () => {
  it('returns true for Empty', () => {
    expect(isEnterable(CellType.Empty)).toBe(true);
  });

  it('returns true for Toxin (passable environmental)', () => {
    expect(isEnterable(CellType.Toxin)).toBe(true);
  });

  it('returns true for Nutrient (passable environmental)', () => {
    expect(isEnterable(CellType.Nutrient)).toBe(true);
  });

  it('returns false for Wall (impassable)', () => {
    expect(isEnterable(CellType.Wall)).toBe(false);
  });

  it('returns false for Life (already occupied)', () => {
    expect(isEnterable(CellType.Life)).toBe(false);
  });

  it('returns false for LifeVariant (already occupied)', () => {
    expect(isEnterable(CellType.LifeVariant)).toBe(false);
  });

  it('returns false for Drain, GravityWell, Barrier, Fire, Ice (Phase 5+)', () => {
    // These types are not yet enterable in Phase 2.
    expect(isEnterable(CellType.Drain)).toBe(false);
    expect(isEnterable(CellType.GravityWell)).toBe(false);
    expect(isEnterable(CellType.Barrier)).toBe(false);
    expect(isEnterable(CellType.Fire)).toBe(false);
    expect(isEnterable(CellType.Ice)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calcSpreadEnergy
// ---------------------------------------------------------------------------

describe('calcSpreadEnergy', () => {
  const BASE_ENERGY     = 0.9;
  const TOXIN_STRENGTH  = 0.1;
  const TOXIN_RES       = 0.0;
  const NUTRI_BOOST     = 0.05;
  const NUTRI_ABSORB    = 1.0;

  it('Empty target → returns base initialEnergy unchanged', () => {
    const result = calcSpreadEnergy(
      CellType.Empty, BASE_ENERGY,
      TOXIN_STRENGTH, TOXIN_RES,
      NUTRI_BOOST, NUTRI_ABSORB,
    );
    expect(result).toBeCloseTo(BASE_ENERGY, 5);
  });

  it('Toxin target → energy reduced by entry damage', () => {
    const result = calcSpreadEnergy(
      CellType.Toxin, BASE_ENERGY,
      TOXIN_STRENGTH, TOXIN_RES,
      NUTRI_BOOST, NUTRI_ABSORB,
    );
    // 0.9 - 0.1*(1-0) = 0.8
    expect(result).toBeCloseTo(0.8, 5);
  });

  it('Toxin target with full resistance → no reduction', () => {
    const result = calcSpreadEnergy(
      CellType.Toxin, BASE_ENERGY,
      TOXIN_STRENGTH, 1.0,  // full resistance
      NUTRI_BOOST, NUTRI_ABSORB,
    );
    expect(result).toBeCloseTo(BASE_ENERGY, 5);
  });

  it('Nutrient target → energy boosted above base', () => {
    const result = calcSpreadEnergy(
      CellType.Nutrient, BASE_ENERGY,
      TOXIN_STRENGTH, TOXIN_RES,
      NUTRI_BOOST, NUTRI_ABSORB,
    );
    // 0.9 + 0.05 = 0.95
    expect(result).toBeCloseTo(0.95, 5);
  });

  it('result is clamped to 1.0 when nutrient overflows', () => {
    const result = calcSpreadEnergy(
      CellType.Nutrient, 1.0,   // already at max
      TOXIN_STRENGTH, TOXIN_RES,
      0.5, 1.0,                 // large boost
    );
    expect(result).toBe(1.0);
  });

  it('result is clamped to 0.01 when toxin would kill on spawn', () => {
    const result = calcSpreadEnergy(
      CellType.Toxin, 0.02,    // very low initial energy
      0.5, 0.0,                // strong toxin, no resistance
      NUTRI_BOOST, NUTRI_ABSORB,
    );
    // 0.02 - 0.5 = -0.48 → clamped to 0.01
    expect(result).toBe(0.01);
  });
});
