/**
 * @fileoverview Unit tests for Phase 12 genome-aware obstacle rule functions.
 *
 * Tests cover the five new helper functions added in Phase 12:
 *   - calcMutagenMutationBoost
 *   - calcRadioWasteDamage
 *   - calcAntibioticKillChance
 *   - hasAdjacentRewinder
 *   - calcColonyEnergyBoost
 *
 * And the updated helpers:
 *   - isEnterable  (now admits Mutagen and Antibiotic)
 *   - calcSpreadEnergy (now handles Antibiotic entry penalty)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { CellType } from '../GridState.js';
import {
  calcMutagenMutationBoost,
  calcRadioWasteDamage,
  calcAntibioticKillChance,
  hasAdjacentRewinder,
  calcColonyEnergyBoost,
  isEnterable,
  calcSpreadEnergy,
} from './obstacleRules.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal test neighbour environment.
 * Returns a neighbour buffer populated with the given cell types and a
 * corresponding Uint8Array cellType array.
 */
function makeNeighbours(types: CellType[]): {
  buf: Int32Array;
  nLen: number;
  frontCellType: Uint8Array;
} {
  const frontCellType = new Uint8Array(types.length);
  const buf = new Int32Array(types.length);
  for (let k = 0; k < types.length; k++) {
    frontCellType[k] = types[k];
    buf[k] = k; // each neighbour index equals its position in the array
  }
  return { buf, nLen: types.length, frontCellType };
}

// ---------------------------------------------------------------------------
// isEnterable — Phase 12 additions
// ---------------------------------------------------------------------------

describe('isEnterable — Phase 12', () => {
  it('admits Mutagen as enterable (Life can spread in and consume it)', () => {
    expect(isEnterable(CellType.Mutagen)).toBe(true);
  });

  it('admits Antibiotic as enterable (Life can spread in, faces kill check)', () => {
    expect(isEnterable(CellType.Antibiotic)).toBe(true);
  });

  it('rejects RadioWaste as impassable (permanent radiation source)', () => {
    expect(isEnterable(CellType.RadioWaste)).toBe(false);
  });

  it('rejects Rewinder as impassable (genome-shift field)', () => {
    expect(isEnterable(CellType.Rewinder)).toBe(false);
  });

  it('rejects Colony as impassable (infrastructure)', () => {
    expect(isEnterable(CellType.Colony)).toBe(false);
  });

  it('still admits Empty, Toxin, Nutrient from Phase 2', () => {
    expect(isEnterable(CellType.Empty)).toBe(true);
    expect(isEnterable(CellType.Toxin)).toBe(true);
    expect(isEnterable(CellType.Nutrient)).toBe(true);
  });

  it('still rejects Wall, Drain, Fire, Ice, Barrier, GravityWell from Phase 5', () => {
    expect(isEnterable(CellType.Wall)).toBe(false);
    expect(isEnterable(CellType.Drain)).toBe(false);
    expect(isEnterable(CellType.Fire)).toBe(false);
    expect(isEnterable(CellType.Ice)).toBe(false);
    expect(isEnterable(CellType.Barrier)).toBe(false);
    expect(isEnterable(CellType.GravityWell)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calcSpreadEnergy — Phase 12 Antibiotic entry penalty
// ---------------------------------------------------------------------------

describe('calcSpreadEnergy — Phase 12 Antibiotic entry', () => {
  it('applies entry penalty when spreading into Antibiotic cell', () => {
    // With full toxin resistance (1.0) the penalty is zero.
    const noResistance = calcSpreadEnergy(
      CellType.Antibiotic, 0.9, 0.05, 0.0, 0.02, 1.0, 0.12,
    );
    // (1 - toxinResist * 0.5) = 1 so penalty = 0.12 * 0.5 * 1 = 0.06
    expect(noResistance).toBeCloseTo(0.9 - 0.06, 5);
  });

  it('penalty is zero when toxin resistance is 1.0', () => {
    const fullResist = calcSpreadEnergy(
      CellType.Antibiotic, 0.9, 0.05, 1.0, 0.02, 1.0, 0.12,
    );
    // (1 - toxinResistance) = 0 at full resist → penalty = 0.12 * 0.5 * 0 = 0
    expect(fullResist).toBeCloseTo(0.9, 5);
  });

  it('clamps result to [0.01, 1.0]', () => {
    // Very harsh conditions — should not go below 0.01.
    const result = calcSpreadEnergy(
      CellType.Antibiotic, 0.01, 0.0, 0.0, 0.0, 1.0, 1.0,
    );
    expect(result).toBe(0.01);
  });

  it('Mutagen entry has no penalty (mutation boost applied per-tick instead)', () => {
    const mutagenResult = calcSpreadEnergy(
      CellType.Mutagen, 0.9, 0.0, 0.0, 0.0, 1.0, 0.0,
    );
    expect(mutagenResult).toBeCloseTo(0.9, 5);
  });
});

// ---------------------------------------------------------------------------
// calcMutagenMutationBoost
// ---------------------------------------------------------------------------

describe('calcMutagenMutationBoost', () => {
  it('returns mutagenBoost multiplier when adjacent to Mutagen', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([
      CellType.Empty, CellType.Mutagen, CellType.Life,
    ]);
    expect(calcMutagenMutationBoost(buf, nLen, frontCellType, 3.0)).toBe(3.0);
  });

  it('returns 1.0 (no boost) when no adjacent Mutagen', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([
      CellType.Life, CellType.Toxin, CellType.Wall,
    ]);
    expect(calcMutagenMutationBoost(buf, nLen, frontCellType, 3.0)).toBe(1.0);
  });

  it('returns 1.0 when neighbour buffer is empty', () => {
    const buf = new Int32Array(0);
    const frontCellType = new Uint8Array(0);
    expect(calcMutagenMutationBoost(buf, 0, frontCellType, 5.0)).toBe(1.0);
  });

  it('respects custom mutagenBoost values', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Mutagen]);
    expect(calcMutagenMutationBoost(buf, nLen, frontCellType, 7.5)).toBe(7.5);
  });

  it('first Mutagen found is sufficient — does not compound multiple Mutagens', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([
      CellType.Mutagen, CellType.Mutagen,
    ]);
    // Should return the multiplier once, not twice.
    expect(calcMutagenMutationBoost(buf, nLen, frontCellType, 3.0)).toBe(3.0);
  });
});

// ---------------------------------------------------------------------------
// calcRadioWasteDamage
// ---------------------------------------------------------------------------

describe('calcRadioWasteDamage', () => {
  it('returns negative energy delta when adjacent to RadioWaste', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.RadioWaste]);
    const damage = calcRadioWasteDamage(buf, nLen, frontCellType, 0.008, 0.0);
    expect(damage).toBeCloseTo(-0.008, 6);
  });

  it('returns 0 when no adjacent RadioWaste', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Wall, CellType.Life]);
    expect(calcRadioWasteDamage(buf, nLen, frontCellType, 0.008, 0.0)).toBe(0);
  });

  it('toxin resistance reduces damage by up to 50%', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.RadioWaste]);
    // toxinResist = 1.0 → factor = 1 - 0.5 = 0.5 → damage = -0.008 * 0.5 = -0.004
    const highResist = calcRadioWasteDamage(buf, nLen, frontCellType, 0.008, 1.0);
    expect(highResist).toBeCloseTo(-0.004, 6);
  });

  it('cap at 50% means highly resistant cells still take half damage', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.RadioWaste]);
    const half = calcRadioWasteDamage(buf, nLen, frontCellType, 0.01, 1.0);
    expect(half).toBeCloseTo(-0.005, 6);
  });

  it('respects custom radioWasteDamage values', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.RadioWaste]);
    const damage = calcRadioWasteDamage(buf, nLen, frontCellType, 0.05, 0.0);
    expect(damage).toBeCloseTo(-0.05, 6);
  });
});

// ---------------------------------------------------------------------------
// calcAntibioticKillChance
// ---------------------------------------------------------------------------

describe('calcAntibioticKillChance', () => {
  it('returns antibioticStrength when adjacent and toxinResist=0', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Antibiotic]);
    const chance = calcAntibioticKillChance(buf, nLen, frontCellType, 0.12, 0.0);
    expect(chance).toBeCloseTo(0.12, 6);
  });

  it('returns 0 when no adjacent Antibiotic', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Wall, CellType.Toxin]);
    expect(calcAntibioticKillChance(buf, nLen, frontCellType, 0.12, 0.0)).toBe(0);
  });

  it('toxin resistance reduces kill chance linearly', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Antibiotic]);
    // 0.12 × (1 − 0.5) = 0.06
    const chance = calcAntibioticKillChance(buf, nLen, frontCellType, 0.12, 0.5);
    expect(chance).toBeCloseTo(0.06, 6);
  });

  it('full toxin resistance reduces kill chance to 0', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Antibiotic]);
    const chance = calcAntibioticKillChance(buf, nLen, frontCellType, 0.12, 1.0);
    expect(chance).toBeCloseTo(0, 6);
  });

  it('accepts custom antibioticStrength values', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Antibiotic]);
    expect(calcAntibioticKillChance(buf, nLen, frontCellType, 0.5, 0.0)).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// hasAdjacentRewinder
// ---------------------------------------------------------------------------

describe('hasAdjacentRewinder', () => {
  it('returns true when at least one neighbour is a Rewinder', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([
      CellType.Life, CellType.Rewinder, CellType.Empty,
    ]);
    expect(hasAdjacentRewinder(buf, nLen, frontCellType)).toBe(true);
  });

  it('returns false when no neighbours are Rewinders', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([
      CellType.Life, CellType.Wall, CellType.Toxin,
    ]);
    expect(hasAdjacentRewinder(buf, nLen, frontCellType)).toBe(false);
  });

  it('returns false for empty neighbour list', () => {
    const buf = new Int32Array(0);
    const frontCellType = new Uint8Array(0);
    expect(hasAdjacentRewinder(buf, 0, frontCellType)).toBe(false);
  });

  it('returns true with multiple Rewinders (first is sufficient)', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([
      CellType.Rewinder, CellType.Rewinder,
    ]);
    expect(hasAdjacentRewinder(buf, nLen, frontCellType)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calcColonyEnergyBoost
// ---------------------------------------------------------------------------

describe('calcColonyEnergyBoost', () => {
  it('returns colonyBoost when adjacent to Colony', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Colony]);
    expect(calcColonyEnergyBoost(buf, nLen, frontCellType, 0.012)).toBeCloseTo(0.012, 6);
  });

  it('returns 0 when no adjacent Colony', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Wall, CellType.Life]);
    expect(calcColonyEnergyBoost(buf, nLen, frontCellType, 0.012)).toBe(0);
  });

  it('returns 0 for empty neighbour list', () => {
    const buf = new Int32Array(0);
    const frontCellType = new Uint8Array(0);
    expect(calcColonyEnergyBoost(buf, 0, frontCellType, 0.012)).toBe(0);
  });

  it('only counts the first Colony (no stacking)', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([
      CellType.Colony, CellType.Colony,
    ]);
    // Should return colonyBoost once, not twice.
    expect(calcColonyEnergyBoost(buf, nLen, frontCellType, 0.012)).toBeCloseTo(0.012, 6);
  });

  it('respects custom colonyBoost values', () => {
    const { buf, nLen, frontCellType } = makeNeighbours([CellType.Colony]);
    expect(calcColonyEnergyBoost(buf, nLen, frontCellType, 0.05)).toBeCloseTo(0.05, 6);
  });
});
