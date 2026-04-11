/**
 * @fileoverview Unit tests for SimulationEngine.
 *
 * Tests are written against pure TypedArray buffers — no DOM, no canvas.
 *
 * Scenarios covered (Phase 1):
 *   - Energy decay kills a cell when energy drops to 0.
 *   - A Live cell spreads into an adjacent Empty cell when spreadRate = 1.
 *   - No spread occurs at spreadRate = 0.
 *   - Overpopulation kills a cell.
 *   - Underpopulation kills a cell.
 *   - Spread does not occur below the reproduction threshold.
 *   - Moore vs. Von Neumann neighbourhood modes.
 *   - TickStats: births and deaths are counted correctly.
 *   - CellFlags static helpers set/clear/check flags.
 *
 * Scenarios covered (Phase 2 — obstacles):
 *   - Wall cells are impassable: life cannot spread through them.
 *   - Toxin cells damage adjacent life each tick.
 *   - Life with full toxin resistance takes no damage from toxin.
 *   - Life spreads INTO a Toxin cell (consuming it) with reduced energy.
 *   - Nutrient cells boost adjacent life energy.
 *   - Life energy does not exceed 1.0 after nutrient boost.
 *   - Life spreads INTO a Nutrient cell (consuming it) with boosted energy.
 *   - Nutrient cells deplete over time and become Empty when exhausted.
 *   - Nutrient cell claimed by spread is not overwritten by its own decay.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SimulationEngine, CellFlags } from './SimulationEngine.js';
import { GridState, CellType } from './GridState.js';
import { defaultConfig } from './config/SimulationConfig.js';

// ---------------------------------------------------------------------------
// Helper: single-tick convenience
// ---------------------------------------------------------------------------

/**
 * Runs one tick on `grid` using `engine` + `config`, swaps buffers, and
 * returns the resulting front buffer.
 */
function runOneTick(
  grid: GridState,
  engine: SimulationEngine,
  configOverrides: Partial<ReturnType<typeof defaultConfig>> = {},
) {
  const config = { ...defaultConfig(), ...configOverrides };
  grid.copyFrontToBack();
  const stats = engine.tick(grid.front, grid.back, config);
  grid.swap();
  return { front: grid.front, stats };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const W = 5;
const H = 5;
let grid: GridState;
let engine: SimulationEngine;

beforeEach(() => {
  grid   = new GridState(W, H);
  engine = new SimulationEngine(W, H);
});

// ---------------------------------------------------------------------------
// Energy decay → death
// ---------------------------------------------------------------------------

describe('SimulationEngine — energy decay', () => {
  it('kills a cell whose energy reaches 0 after decay', () => {
    // Place a single life cell with just enough energy to die this tick.
    const i = 2 * W + 2; // centre
    grid.front.cellType[i] = CellType.Life;
    // Set energy to exactly the decay rate so newEnergy = 0.
    grid.front.energy[i] = 0.01;

    runOneTick(grid, engine, {
      energyDecayRate:      0.01,
      spreadRate:           0.0,
      underpopulationLimit: 0,  // disable underpop
    });

    expect(grid.front.cellType[i]).toBe(CellType.Empty);
    expect(grid.front.energy[i]).toBe(0);
  });

  it('survives when energy is comfortably above decay rate', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 0.8;

    const { front } = runOneTick(grid, engine, {
      energyDecayRate: 0.005,
      spreadRate:      0.0,
    });

    expect(front.cellType[i]).toBe(CellType.Life);
    expect(front.energy[i]).toBeCloseTo(0.795, 3);
  });
});

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

describe('SimulationEngine — spread', () => {
  it('spreads into all empty neighbours at spreadRate = 1', () => {
    // Single centre cell on a 5×5 grid, all defaults except spreadRate = 1.
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;

    runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
    });

    // All 8 Moore neighbours (centre is not on an edge) should now be Life.
    const neighbours = [
      1 * W + 1, 1 * W + 2, 1 * W + 3,
      2 * W + 1,             2 * W + 3,
      3 * W + 1, 3 * W + 2, 3 * W + 3,
    ];
    for (const n of neighbours) {
      expect(grid.front.cellType[n]).toBe(CellType.Life);
    }
  });

  it('does not spread at spreadRate = 0', () => {
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;

    runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
    });

    // No neighbours should become Life.
    for (let i = 0; i < grid.totalCells; i++) {
      if (i !== centre) {
        expect(grid.front.cellType[i]).toBe(CellType.Empty);
      }
    }
  });

  it('does not spread when energy < reproductionThreshold', () => {
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 0.05; // below threshold

    runOneTick(grid, engine, {
      spreadRate:            1.0,
      energyDecayRate:       0.001,
      reproductionThreshold: 0.1,
      underpopulationLimit:  0,
    });

    for (let i = 0; i < grid.totalCells; i++) {
      if (i !== centre) {
        expect(grid.front.cellType[i]).toBe(CellType.Empty);
      }
    }
  });

  it('only spreads into Empty cells, not already-Life cells', () => {
    // Fill the whole grid with Life.
    grid.seed(1.0, 1.0);
    const before = grid.front.cellType.slice();

    runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      overpopulationLimit:  8, // disable overpop
    });

    // Cell types should not change (no empty slots to spread into).
    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.front.cellType[i]).toBe(before[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// Overpopulation
// ---------------------------------------------------------------------------

describe('SimulationEngine — overpopulation', () => {
  it('kills a cell surrounded by too many neighbours', () => {
    // Fill the grid so the centre has 8 living neighbours.
    grid.seed(1.0, 1.0);
    const centre = 2 * W + 2;

    runOneTick(grid, engine, {
      overpopulationLimit:  3,   // dies with > 3 neighbours
      underpopulationLimit: 0,
      energyDecayRate:      0.0,
      spreadRate:           0.0,
    });

    // Centre has 8 live neighbours → should die.
    expect(grid.front.cellType[centre]).toBe(CellType.Empty);
  });
});

// ---------------------------------------------------------------------------
// Underpopulation
// ---------------------------------------------------------------------------

describe('SimulationEngine — underpopulation', () => {
  it('kills an isolated cell (0 neighbours) when limit > 0', () => {
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;

    runOneTick(grid, engine, {
      underpopulationLimit: 1,   // needs at least 1 neighbour
      energyDecayRate:      0.0,
      spreadRate:           0.0,
    });

    expect(grid.front.cellType[centre]).toBe(CellType.Empty);
  });
});

// ---------------------------------------------------------------------------
// Von Neumann neighbourhood
// ---------------------------------------------------------------------------

describe('SimulationEngine — Von Neumann neighbourhood', () => {
  it('spreads to exactly 4 (non-diagonal) neighbours at spreadRate = 1', () => {
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;

    runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      neighbourhoodMode:    'vonNeumann',
    });

    const cardinalNeighbours = [
      1 * W + 2, // N
      3 * W + 2, // S
      2 * W + 1, // W
      2 * W + 3, // E
    ];

    const diagonalNeighbours = [
      1 * W + 1, 1 * W + 3,
      3 * W + 1, 3 * W + 3,
    ];

    for (const n of cardinalNeighbours) {
      expect(grid.front.cellType[n]).toBe(CellType.Life);
    }
    for (const n of diagonalNeighbours) {
      expect(grid.front.cellType[n]).toBe(CellType.Empty);
    }
  });
});

// ---------------------------------------------------------------------------
// TickStats
// ---------------------------------------------------------------------------

describe('SimulationEngine — TickStats', () => {
  it('reports births when spread occurs', () => {
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;

    const { stats } = runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
    });

    // 8 Moore neighbours, all should be born.
    expect(stats.births).toBeGreaterThanOrEqual(1);
  });

  it('reports deaths when a cell decays', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 0.001;

    const { stats } = runOneTick(grid, engine, {
      energyDecayRate:      0.01,
      spreadRate:           0.0,
      underpopulationLimit: 0,
    });

    expect(stats.deaths).toBeGreaterThanOrEqual(1);
  });

  it('reports live cell count matching the actual grid', () => {
    grid.seed(1.0, 1.0);

    const { stats } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      overpopulationLimit:  8,
    });

    const actualLive = grid.countCells(CellType.Life);
    expect(stats.liveCells).toBe(actualLive);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — Wall obstacle
// ---------------------------------------------------------------------------

describe('SimulationEngine — Wall obstacle', () => {
  it('life cannot spread into an adjacent Wall cell', () => {
    // Place life at centre, wall to its right.
    const centre    = 2 * W + 2;
    const wallRight = 2 * W + 3;

    grid.front.cellType[centre]    = CellType.Life;
    grid.front.energy[centre]      = 1.0;
    grid.front.cellType[wallRight] = CellType.Wall;

    runOneTick(grid, engine, {
      spreadRate:           1.0,  // guaranteed spread attempt
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
    });

    // The wall cell must remain a Wall.
    expect(grid.front.cellType[wallRight]).toBe(CellType.Wall);
  });

  it('wall has no effect on energy of the life cell', () => {
    // A wall alone should not hurt the adjacent life cell.
    const centre    = 2 * W + 2;
    const wallRight = 2 * W + 3;

    grid.front.cellType[centre]    = CellType.Life;
    grid.front.energy[centre]      = 0.8;
    grid.front.cellType[wallRight] = CellType.Wall;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
    });

    // Energy should be unchanged (no decay configured, wall does not damage).
    expect(front.energy[centre]).toBeCloseTo(0.8, 5);
    expect(front.cellType[centre]).toBe(CellType.Life);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — Toxin obstacle
// ---------------------------------------------------------------------------

describe('SimulationEngine — Toxin obstacle', () => {
  it('toxin cell damages adjacent life each tick', () => {
    // Life at centre, Toxin to its right.
    const centre     = 2 * W + 2;
    const toxinRight = 2 * W + 3;

    grid.front.cellType[centre]     = CellType.Life;
    grid.front.energy[centre]       = 0.8;
    grid.front.cellType[toxinRight] = CellType.Toxin;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,   // no base decay — isolate toxin damage
      underpopulationLimit: 0,
      toxinStrength:        0.1,
      toxinResistance:      0.0,
    });

    // Energy should have dropped by toxinStrength.
    expect(front.energy[centre]).toBeCloseTo(0.7, 5);
    expect(front.cellType[centre]).toBe(CellType.Life);
  });

  it('full toxin resistance (1.0) prevents all toxin damage', () => {
    const centre     = 2 * W + 2;
    const toxinRight = 2 * W + 3;

    grid.front.cellType[centre]     = CellType.Life;
    grid.front.energy[centre]       = 0.8;
    grid.front.cellType[toxinRight] = CellType.Toxin;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      toxinStrength:        0.1,
      toxinResistance:      1.0,  // immune
    });

    expect(front.energy[centre]).toBeCloseTo(0.8, 5);
  });

  it('life dies when toxin damage drains all energy', () => {
    const centre     = 2 * W + 2;
    const toxinRight = 2 * W + 3;

    grid.front.cellType[centre]     = CellType.Life;
    grid.front.energy[centre]       = 0.05; // barely alive
    grid.front.cellType[toxinRight] = CellType.Toxin;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      toxinStrength:        0.1,
      toxinResistance:      0.0,
    });

    expect(front.cellType[centre]).toBe(CellType.Empty);
  });

  it('life can spread INTO a toxin cell, consuming it', () => {
    // Life at centre, Toxin to its right.  spreadRate = 1 guarantees spread.
    const centre     = 2 * W + 2;
    const toxinRight = 2 * W + 3;

    grid.front.cellType[centre]     = CellType.Life;
    grid.front.energy[centre]       = 1.0;
    grid.front.cellType[toxinRight] = CellType.Toxin;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      toxinStrength:        0.1,
      toxinResistance:      0.0,
      initialEnergy:        0.9,
    });

    // Toxin cell must have been replaced by Life.
    expect(front.cellType[toxinRight]).toBe(CellType.Life);
    // Spawn energy = initialEnergy - toxinStrength = 0.9 - 0.1 = 0.8.
    expect(front.energy[toxinRight]).toBeCloseTo(0.8, 5);
  });

  it('life spread into toxin clamps spawn energy to minimum 0.01', () => {
    // toxinStrength=0.5: spreader loses 0.5 energy (1.0 → 0.5, survives),
    // but the spawn initialEnergy (0.02) - 0.5 = -0.48 → clamped to 0.01.
    const centre     = 2 * W + 2;
    const toxinRight = 2 * W + 3;

    grid.front.cellType[centre]     = CellType.Life;
    grid.front.energy[centre]       = 1.0;  // survives 0.5 adjacency damage
    grid.front.cellType[toxinRight] = CellType.Toxin;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      toxinStrength:        0.5,  // spreader: 1.0 - 0.5 = 0.5 (lives)
      toxinResistance:      0.0,
      initialEnergy:        0.02, // spawn: 0.02 - 0.5 = -0.48 → clamped to 0.01
    });

    expect(front.cellType[toxinRight]).toBe(CellType.Life);
    // Float32Array stores 0.01 as ~0.009999999776; use toBeCloseTo.
    expect(front.energy[toxinRight]).toBeCloseTo(0.01, 4);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — Nutrient obstacle
// ---------------------------------------------------------------------------

describe('SimulationEngine — Nutrient obstacle', () => {
  it('nutrient boosts adjacent life energy each tick', () => {
    const centre        = 2 * W + 2;
    const nutrientRight = 2 * W + 3;

    grid.front.cellType[centre]        = CellType.Life;
    grid.front.energy[centre]          = 0.5;
    grid.front.cellType[nutrientRight] = CellType.Nutrient;
    grid.front.energy[nutrientRight]   = 1.0; // full nutrient

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      nutrientBoost:        0.05,
      nutrientAbsorption:   1.0,
      nutrientDecayRate:    0.0,  // don't deplete during test
    });

    // Energy should increase by nutrientBoost.
    expect(front.energy[centre]).toBeCloseTo(0.55, 5);
    expect(front.cellType[centre]).toBe(CellType.Life);
  });

  it('nutrient boost does not push life energy above 1.0', () => {
    const centre        = 2 * W + 2;
    const nutrientRight = 2 * W + 3;

    grid.front.cellType[centre]        = CellType.Life;
    grid.front.energy[centre]          = 0.99; // nearly full
    grid.front.cellType[nutrientRight] = CellType.Nutrient;
    grid.front.energy[nutrientRight]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      nutrientBoost:        0.1,
      nutrientAbsorption:   1.0,
      nutrientDecayRate:    0.0,
    });

    expect(front.energy[centre]).toBeLessThanOrEqual(1.0);
  });

  it('life can spread INTO a nutrient cell, consuming it', () => {
    const centre        = 2 * W + 2;
    const nutrientRight = 2 * W + 3;

    grid.front.cellType[centre]        = CellType.Life;
    grid.front.energy[centre]          = 1.0;
    grid.front.cellType[nutrientRight] = CellType.Nutrient;
    grid.front.energy[nutrientRight]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      nutrientBoost:        0.05,
      nutrientAbsorption:   1.0,
      nutrientDecayRate:    0.0,
      initialEnergy:        0.8,
    });

    // Nutrient must be replaced by Life.
    expect(front.cellType[nutrientRight]).toBe(CellType.Life);
    // Spawn energy = initialEnergy + nutrientBoost = 0.8 + 0.05 = 0.85.
    expect(front.energy[nutrientRight]).toBeCloseTo(0.85, 5);
  });

  it('nutrient depletes over time and becomes Empty when exhausted', () => {
    const nutrientIdx = 2 * W + 2;

    grid.front.cellType[nutrientIdx] = CellType.Nutrient;
    grid.front.energy[nutrientIdx]   = 0.005; // nearly depleted

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      nutrientDecayRate:    0.01, // decay > remaining energy
    });

    expect(front.cellType[nutrientIdx]).toBe(CellType.Empty);
    expect(front.energy[nutrientIdx]).toBe(0);
  });

  it('nutrient does not deplete when life spread into it this tick', () => {
    // Life spreads into Nutrient → Nutrient becomes Life.
    // The Nutrient decay path must NOT overwrite that result.
    const centre        = 2 * W + 2;
    const nutrientRight = 2 * W + 3;

    grid.front.cellType[centre]        = CellType.Life;
    grid.front.energy[centre]          = 1.0;
    grid.front.cellType[nutrientRight] = CellType.Nutrient;
    grid.front.energy[nutrientRight]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      nutrientBoost:        0.0,
      nutrientAbsorption:   0.0,
      nutrientDecayRate:    0.5, // large decay — would set energy to 0.5
      initialEnergy:        0.9,
    });

    // Spread result wins: the cell is Life, not Nutrient with decayed energy.
    expect(front.cellType[nutrientRight]).toBe(CellType.Life);
    // Energy should be the spread energy (0.9), not the decayed nutrient energy.
    expect(front.energy[nutrientRight]).toBeCloseTo(0.9, 5);
  });
});

// ---------------------------------------------------------------------------
// CellFlags static helpers
// ---------------------------------------------------------------------------

describe('SimulationEngine — CellFlags static helpers', () => {
  it('hasFlag returns false initially', () => {
    const flags = new Uint8Array(4);
    expect(SimulationEngine.hasFlag(flags, 0, CellFlags.MUTATED)).toBe(false);
  });

  it('setFlag + hasFlag round-trips', () => {
    const flags = new Uint8Array(4);
    SimulationEngine.setFlag(flags, 2, CellFlags.MUTATED);
    expect(SimulationEngine.hasFlag(flags, 2, CellFlags.MUTATED)).toBe(true);
    expect(SimulationEngine.hasFlag(flags, 0, CellFlags.MUTATED)).toBe(false);
  });

  it('clearFlag removes only the target flag', () => {
    const flags = new Uint8Array(4);
    SimulationEngine.setFlag(flags, 1, CellFlags.MUTATED | CellFlags.DORMANT);
    SimulationEngine.clearFlag(flags, 1, CellFlags.MUTATED);
    expect(SimulationEngine.hasFlag(flags, 1, CellFlags.MUTATED)).toBe(false);
    expect(SimulationEngine.hasFlag(flags, 1, CellFlags.DORMANT)).toBe(true);
  });
});
