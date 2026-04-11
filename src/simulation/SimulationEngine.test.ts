/**
 * @fileoverview Unit tests for SimulationEngine.
 *
 * Tests are written against pure TypedArray buffers — no DOM, no canvas.
 *
 * Scenarios covered:
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
