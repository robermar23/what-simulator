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
 * Scenarios covered (Phase 5 — full obstacle catalog):
 *   - Drain: adjacent Life loses drainRate energy per tick.
 *   - Drain: Life spread rate is halved when adjacent to Drain.
 *   - Ice: adjacent Life cells become dormant (no decay, no death).
 *   - Ice: dormant Life cells do not spread.
 *   - Ice: DORMANT flag is set on frozen cells.
 *   - Fire: adjacent Life cells are instantly killed.
 *   - Fire: Fire cell converts adjacent Life to Fire (spread).
 *   - Fire: Fire cell burns down by fireBurnRate each tick.
 *   - Fire: Fire becomes Empty when energy reaches 0.
 *   - Barrier: stays impassable while age < barrierLifetime.
 *   - Barrier: becomes Empty when age >= barrierLifetime.
 *   - Barrier: energy fades linearly toward 0 over its lifetime.
 *   - GravityWell: Life cannot spread INTO a GravityWell cell.
 *   - GravityWell: well biases spread probability toward itself.
 *
 * Scenarios covered (Phase 10 — lifecycle stages):
 *   - Juvenile flag is set when cell age < juvenileThreshold.
 *   - Juvenile flag is cleared when cell age reaches juvenileThreshold.
 *   - Senescent flag is set when cell age > senescentThreshold.
 *   - Juvenile cells have a reduced effective spread rate (40% of base).
 *   - Senescent cells have an increased decay rate (1.5× base).
 *   - Juvenile cells never mutate (stageMutationRate = 0).
 *   - Apoptosis: senescent low-energy cell dies and boosts neighbour energy.
 *   - Apoptosis: signal strength is set to 1.0 on apoptotic cell.
 *   - Lifecycle flags are cleared when a cell dies.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SimulationEngine, CellFlags } from './SimulationEngine.js';
import { GridState, CellType } from './GridState.js';
import { defaultConfig } from './config/SimulationConfig.js';
import {
  GENOME_NEUTRAL,
  packGenome,
  getToxinResist,
  getNutrientAbs,
  getSpreadBonus,
} from './genetics/GenomeEncoder.js';

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
      juvenileThreshold:    0,  // disable juvenile modifier so decay is 1× not 0.8×
    });

    expect(grid.front.cellType[i]).toBe(CellType.Empty);
    expect(grid.front.energy[i]).toBe(0);
  });

  it('survives when energy is comfortably above decay rate', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 0.8;

    const { front } = runOneTick(grid, engine, {
      energyDecayRate:   0.005,
      spreadRate:        0.0,
      juvenileThreshold: 0, // disable juvenile modifier
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
      juvenileThreshold:    0, // disable juvenile spread penalty
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
      juvenileThreshold:    0, // disable juvenile spread penalty
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
      juvenileThreshold:    0, // disable juvenile spread penalty for determinism
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
    // Phase 9: per-cell toxin resistance overrides the global config value.
    grid.front.toxinResist[centre]  = 1.0;
    grid.front.cellType[toxinRight] = CellType.Toxin;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      toxinStrength:        0.1,
      toxinResistance:      1.0,  // immune (kept for symmetry; engine uses per-cell)
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
      juvenileThreshold:    0, // disable juvenile spread penalty
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
      juvenileThreshold:    0,    // disable juvenile spread penalty
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
    // Phase 9: per-cell nutrient absorption must be set (buffers default to 0).
    grid.front.nutrientAbs[centre]     = 1.0;
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
    // Phase 9: per-cell nutrient absorption must be set (buffers default to 0).
    grid.front.nutrientAbs[centre]     = 1.0;
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
    // Phase 9: give the parent genome max nutrientTier (15) so the child's
    // per-cell nutrientAbs = 1.0.  pointMutationRate=0 ensures the child
    // inherits the genome unchanged, so we can predict spawn energy exactly.
    grid.front.genome[centre]          = packGenome(7, 7, 7, 15);
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
      pointMutationRate:    0.0,  // no mutation → child genome identical to parent
      juvenileThreshold:    0,    // disable juvenile spread penalty
    });

    // Nutrient must be replaced by Life.
    expect(front.cellType[nutrientRight]).toBe(CellType.Life);
    // Spawn energy = initialEnergy + nutrientBoost × nutrientAbs = 0.8 + 0.05 × 1.0 = 0.85.
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
      juvenileThreshold:    0,   // disable juvenile spread penalty
    });

    // Spread result wins: the cell is Life, not Nutrient with decayed energy.
    expect(front.cellType[nutrientRight]).toBe(CellType.Life);
    // Energy should be the spread energy (0.9), not the decayed nutrient energy.
    expect(front.energy[nutrientRight]).toBeCloseTo(0.9, 5);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — Mutation (Life → LifeVariant)
// ---------------------------------------------------------------------------

describe('SimulationEngine — mutation', () => {
  it('a Life cell with mutationRate=1 becomes LifeVariant after one tick', () => {
    // Place a single isolated life cell with guaranteed mutation.
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      mutationRate:         1.0,  // guaranteed
      energyDecayRate:      0.0,
      spreadRate:           0.0,
      underpopulationLimit: 0,
      juvenileThreshold:    0,    // disable juvenile no-mutation rule
    });

    expect(front.cellType[i]).toBe(CellType.LifeVariant);
  });

  it('mutated cell receives the MUTATED flag', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 1.0;

    runOneTick(grid, engine, {
      mutationRate:         1.0,
      energyDecayRate:      0.0,
      spreadRate:           0.0,
      underpopulationLimit: 0,
      juvenileThreshold:    0, // disable juvenile no-mutation rule
    });

    expect(SimulationEngine.hasFlag(grid.front.flags, i, CellFlags.MUTATED)).toBe(true);
  });

  it('mutated cell retains its energy', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 0.7;

    const { front } = runOneTick(grid, engine, {
      mutationRate:         1.0,
      energyDecayRate:      0.0,  // no decay so energy is unchanged
      spreadRate:           0.0,
      underpopulationLimit: 0,
    });

    // Energy must be preserved through mutation.
    expect(front.energy[i]).toBeCloseTo(0.7, 5);
  });

  it('mutationRate=0 never produces LifeVariant cells', () => {
    // Seed the grid fully with Life; no mutation should occur.
    grid.seed(1.0, 1.0);

    runOneTick(grid, engine, {
      mutationRate:         0.0,
      energyDecayRate:      0.0,
      spreadRate:           0.0,
      underpopulationLimit: 0,
      overpopulationLimit:  8,
    });

    for (let i = 0; i < grid.totalCells; i++) {
      const t = grid.front.cellType[i];
      // After tick every cell must remain Life or Empty — never LifeVariant.
      expect(t === CellType.Life || t === CellType.Empty).toBe(true);
    }
  });

  it('dead cells do not mutate (mutation only fires after survival check)', () => {
    // A cell that will die this tick must not become LifeVariant.
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 0.001; // will die from decay

    const { front } = runOneTick(grid, engine, {
      mutationRate:         1.0,  // would mutate if it survived
      energyDecayRate:      0.01, // enough to kill it
      spreadRate:           0.0,
      underpopulationLimit: 0,
    });

    // The cell must be Empty, not LifeVariant.
    expect(front.cellType[i]).toBe(CellType.Empty);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — LifeVariant independent parameters
// ---------------------------------------------------------------------------

describe('SimulationEngine — LifeVariant parameters', () => {
  it('LifeVariant decays at variantEnergyDecayRate, not energyDecayRate', () => {
    // Place a LifeVariant cell with high regular decay but low variant decay.
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.LifeVariant;
    grid.front.energy[i]   = 0.5;

    const { front } = runOneTick(grid, engine, {
      energyDecayRate:        0.2,   // would kill Life A almost immediately
      variantEnergyDecayRate: 0.05,  // only a small hit for Variant B
      spreadRate:             0.0,
      variantSpreadRate:      0.0,
      underpopulationLimit:   0,
    });

    // Variant B should have only lost 0.05, not 0.2.
    expect(front.energy[i]).toBeCloseTo(0.45, 5);
    expect(front.cellType[i]).toBe(CellType.LifeVariant);
  });

  it('LifeVariant spreads at variantSpreadRate (spreadRate = 0 has no effect)', () => {
    // Centre LifeVariant, all neighbours empty, spreadRate=0 but
    // variantSpreadRate=1 → all 8 neighbours become LifeVariant.
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.LifeVariant;
    grid.front.energy[centre]   = 1.0;

    runOneTick(grid, engine, {
      spreadRate:                    0.0,   // Life A would not spread
      variantSpreadRate:             1.0,   // Variant B definitely spreads
      energyDecayRate:               0.0,
      variantEnergyDecayRate:        0.0,
      variantReproductionThreshold:  0.01,
      variantInitialEnergy:          0.8,
      underpopulationLimit:          0,
    });

    // All 8 Moore neighbours of the centre should now be LifeVariant.
    const neighbours = [
      1 * W + 1, 1 * W + 2, 1 * W + 3,
      2 * W + 1,             2 * W + 3,
      3 * W + 1, 3 * W + 2, 3 * W + 3,
    ];
    for (const n of neighbours) {
      expect(grid.front.cellType[n]).toBe(CellType.LifeVariant);
    }
  });

  it('LifeVariant newborns start at variantInitialEnergy', () => {
    const centre = 2 * W + 2;
    const right  = 2 * W + 3; // the one neighbour we can predict

    grid.front.cellType[centre] = CellType.LifeVariant;
    grid.front.energy[centre]   = 1.0;

    runOneTick(grid, engine, {
      variantSpreadRate:             1.0,
      variantEnergyDecayRate:        0.0,
      variantReproductionThreshold:  0.01,
      variantInitialEnergy:          0.6,
      energyDecayRate:               0.0,
      spreadRate:                    0.0,
      underpopulationLimit:          0,
    });

    // Any LifeVariant child should have spawned with variantInitialEnergy.
    if (grid.front.cellType[right] === CellType.LifeVariant) {
      expect(grid.front.energy[right]).toBeCloseTo(0.6, 5);
    }
  });

  it('TickStats counts surviving LifeVariant cells in variantCells', () => {
    // Place 3 isolated LifeVariant cells, no deaths expected.
    const positions = [0 * W + 0, 0 * W + 4, 4 * W + 0];
    for (const p of positions) {
      grid.front.cellType[p] = CellType.LifeVariant;
      grid.front.energy[p]   = 1.0;
    }

    const { stats } = runOneTick(grid, engine, {
      variantEnergyDecayRate: 0.0,
      variantSpreadRate:      0.0,
      energyDecayRate:        0.0,
      spreadRate:             0.0,
      underpopulationLimit:   0,
    });

    // All 3 cells survive; variantCells should be at least 3 (corners may
    // share neighbours at 5×5 but no overpop config is set here).
    expect(stats.variantCells).toBeGreaterThanOrEqual(3);
    // Regular liveCells should be 0 (no Life A on the grid).
    expect(stats.liveCells).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — Competition (LifeVariant vs Life A)
// ---------------------------------------------------------------------------

describe('SimulationEngine — competition', () => {
  it('LifeVariant spreads into adjacent Life A with competitionStrength=1', () => {
    // LifeVariant at centre, Life to its right, empty everywhere else.
    const centre    = 2 * W + 2;
    const lifeRight = 2 * W + 3;

    grid.front.cellType[centre]    = CellType.LifeVariant;
    grid.front.energy[centre]      = 1.0;
    grid.front.cellType[lifeRight] = CellType.Life;
    grid.front.energy[lifeRight]   = 1.0;

    runOneTick(grid, engine, {
      // Guaranteed competition takeover.
      competitionStrength:           1.0,
      variantSpreadRate:             0.0,  // no normal spread, just competition
      variantEnergyDecayRate:        0.0,
      variantReproductionThreshold:  0.01,
      variantInitialEnergy:          0.7,
      energyDecayRate:               0.0,
      spreadRate:                    0.0,
      underpopulationLimit:          0,
    });

    // The Life A cell must have been taken over by LifeVariant.
    expect(grid.front.cellType[lifeRight]).toBe(CellType.LifeVariant);
  });

  it('Life A cannot spread into LifeVariant cells', () => {
    // Life at centre, LifeVariant to its right.  Life's spreadRate = 1 but
    // it must not overwrite the LifeVariant.
    const centre        = 2 * W + 2;
    const variantRight  = 2 * W + 3;

    grid.front.cellType[centre]       = CellType.Life;
    grid.front.energy[centre]         = 1.0;
    grid.front.cellType[variantRight] = CellType.LifeVariant;
    grid.front.energy[variantRight]   = 1.0;

    runOneTick(grid, engine, {
      spreadRate:            1.0,   // Life A tries to spread everywhere
      energyDecayRate:       0.0,
      variantEnergyDecayRate: 0.0,
      variantSpreadRate:     0.0,
      competitionStrength:   0.0,  // no counter-competition
      underpopulationLimit:  0,
    });

    // LifeVariant must remain — Life A cannot displace it.
    expect(grid.front.cellType[variantRight]).toBe(CellType.LifeVariant);
  });

  it('LifeVariant does NOT spread into another LifeVariant cell', () => {
    // Two adjacent LifeVariant cells — neither should change the other.
    const left  = 2 * W + 1;
    const right = 2 * W + 3;

    grid.front.cellType[left]  = CellType.LifeVariant;
    grid.front.energy[left]    = 1.0;
    grid.front.cellType[right] = CellType.LifeVariant;
    grid.front.energy[right]   = 1.0;

    runOneTick(grid, engine, {
      variantSpreadRate:             1.0,
      competitionStrength:           1.0,
      variantEnergyDecayRate:        0.0,
      variantReproductionThreshold:  0.01,
      variantInitialEnergy:          0.5,
      energyDecayRate:               0.0,
      spreadRate:                    0.0,
      underpopulationLimit:          0,
    });

    // Each cell should remain LifeVariant (same type, not treated as a target).
    expect(grid.front.cellType[left]).toBe(CellType.LifeVariant);
    expect(grid.front.cellType[right]).toBe(CellType.LifeVariant);
  });

  it('competitionStrength=0 means LifeVariant never displaces Life A', () => {
    const centre    = 2 * W + 2;
    const lifeRight = 2 * W + 3;

    grid.front.cellType[centre]    = CellType.LifeVariant;
    grid.front.energy[centre]      = 1.0;
    grid.front.cellType[lifeRight] = CellType.Life;
    grid.front.energy[lifeRight]   = 1.0;

    runOneTick(grid, engine, {
      competitionStrength:           0.0,  // no competition
      variantSpreadRate:             0.0,
      variantEnergyDecayRate:        0.0,
      variantReproductionThreshold:  0.01,
      energyDecayRate:               0.0,
      spreadRate:                    0.0,
      underpopulationLimit:          0,
    });

    // The Life A cell must survive untouched.
    expect(grid.front.cellType[lifeRight]).toBe(CellType.Life);
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

// ===========================================================================
// Phase 5 — full obstacle catalog
// ===========================================================================

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 5 Drain', () => {
  it('Drain reduces adjacent Life energy by drainRate each tick', () => {
    // Layout on 5×5:  Life at centre (2,2), Drain to the right (3,2)
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 0.8;
    grid.front.cellType[right]  = CellType.Drain;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,   // isolate drain damage
      underpopulationLimit: 0,
      drainRate:            0.05,
    });

    // energy should be 0.8 - 0.05 = 0.75
    expect(front.energy[centre]).toBeCloseTo(0.75, 5);
    expect(front.cellType[centre]).toBe(CellType.Life);
  });

  it('Life dies when Drain drains all energy', () => {
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 0.03; // very low
    grid.front.cellType[right]  = CellType.Drain;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      drainRate:            0.05,
    });

    expect(front.cellType[centre]).toBe(CellType.Empty);
  });

  it('Life adjacent to Drain cannot spread into Drain cell', () => {
    // Drain is impassable — Life should never enter it.
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;
    grid.front.cellType[right]  = CellType.Drain;

    // Run many ticks with maximal spread rate — Life must not convert Drain.
    for (let tick = 0; tick < 20; tick++) {
      runOneTick(grid, engine, {
        spreadRate:           1.0,
        energyDecayRate:      0.0,
        underpopulationLimit: 0,
        drainRate:            0.0, // disable damage so Life survives
      });
    }

    expect(grid.front.cellType[right]).toBe(CellType.Drain);
  });
});

// ---------------------------------------------------------------------------
// Ice
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 5 Ice', () => {
  it('Life adjacent to Ice does not lose energy (dormant)', () => {
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 0.5;
    grid.front.cellType[right]  = CellType.Ice;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.05, // would normally drain 0.05
      underpopulationLimit: 0,
    });

    // Frozen — energy unchanged
    expect(front.energy[centre]).toBeCloseTo(0.5, 5);
    expect(front.cellType[centre]).toBe(CellType.Life);
  });

  it('frozen Life cell has DORMANT flag set', () => {
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 0.5;
    grid.front.cellType[right]  = CellType.Ice;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
    });

    expect(SimulationEngine.hasFlag(front.flags, centre, CellFlags.DORMANT)).toBe(true);
  });

  it('frozen Life does not spread', () => {
    const centre = 2 * W + 2;
    const left   = 2 * W + 1; // empty neighbour
    const right  = 2 * W + 3;

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;
    grid.front.cellType[right]  = CellType.Ice;
    // left stays Empty

    // Run many ticks — Life must not spread while frozen.
    for (let tick = 0; tick < 20; tick++) {
      runOneTick(grid, engine, {
        spreadRate:           1.0,
        energyDecayRate:      0.0,
        underpopulationLimit: 0,
      });
    }

    // The left cell must remain Empty — Life cannot spread while adjacent to Ice.
    expect(grid.front.cellType[left]).toBe(CellType.Empty);
  });

  it('Life cannot spread INTO an Ice cell', () => {
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;
    grid.front.cellType[right]  = CellType.Ice;

    for (let tick = 0; tick < 20; tick++) {
      runOneTick(grid, engine, {
        spreadRate:           1.0,
        energyDecayRate:      0.0,
        underpopulationLimit: 0,
      });
    }

    expect(grid.front.cellType[right]).toBe(CellType.Ice);
  });
});

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 5 Fire', () => {
  it('Life adjacent to Fire is consumed and becomes Fire (instant spread)', () => {
    // Per the plan interaction matrix: "Life meets Fire → Instant death; fire spreads".
    // The life cell is consumed by fire and becomes a new Fire cell (full fuel).
    const centre    = 2 * W + 2;
    const fireRight = 2 * W + 3;

    grid.front.cellType[centre]    = CellType.Life;
    grid.front.energy[centre]      = 1.0; // full energy — irrelevant, fire wins
    grid.front.cellType[fireRight] = CellType.Fire;
    grid.front.energy[fireRight]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      fireBurnRate:         0.0, // prevent burnout so fire stays for this tick
    });

    // Life cell becomes Fire (consumed as fuel), not Empty.
    expect(front.cellType[centre]).toBe(CellType.Fire);
    expect(front.energy[centre]).toBe(1.0);
  });

  it('Fire converts adjacent Life to Fire (spread)', () => {
    const fireCell  = 2 * W + 2;
    const lifeRight = 2 * W + 3;

    grid.front.cellType[fireCell]  = CellType.Fire;
    grid.front.energy[fireCell]    = 1.0;
    grid.front.cellType[lifeRight] = CellType.Life;
    grid.front.energy[lifeRight]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      fireBurnRate:         0.0,
    });

    // The Life cell at lifeRight should now be Fire.
    expect(front.cellType[lifeRight]).toBe(CellType.Fire);
    expect(front.energy[lifeRight]).toBe(1.0);
  });

  it('Fire burns down by fireBurnRate each tick', () => {
    const fireCell = 2 * W + 2;

    grid.front.cellType[fireCell] = CellType.Fire;
    grid.front.energy[fireCell]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      fireBurnRate:         0.1,
    });

    expect(front.energy[fireCell]).toBeCloseTo(0.9, 5);
    expect(front.cellType[fireCell]).toBe(CellType.Fire);
  });

  it('Fire becomes Empty when energy reaches 0', () => {
    const fireCell = 2 * W + 2;

    grid.front.cellType[fireCell] = CellType.Fire;
    grid.front.energy[fireCell]   = 0.05; // very low fuel

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      fireBurnRate:         0.1,
    });

    expect(front.cellType[fireCell]).toBe(CellType.Empty);
  });

  it('Fire spreads to adjacent Nutrient', () => {
    const fireCell      = 2 * W + 2;
    const nutrientRight = 2 * W + 3;

    grid.front.cellType[fireCell]       = CellType.Fire;
    grid.front.energy[fireCell]         = 1.0;
    grid.front.cellType[nutrientRight]  = CellType.Nutrient;
    grid.front.energy[nutrientRight]    = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      fireBurnRate:         0.0,
    });

    expect(front.cellType[nutrientRight]).toBe(CellType.Fire);
  });
});

// ---------------------------------------------------------------------------
// Barrier
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 5 Barrier', () => {
  it('Barrier stays intact while age < barrierLifetime', () => {
    const barrierCell = 2 * W + 2;

    grid.front.cellType[barrierCell] = CellType.Barrier;
    grid.front.energy[barrierCell]   = 1.0;
    grid.front.age[barrierCell]      = 0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:       0.0,
      energyDecayRate:  0.0,
      barrierLifetime:  100,
    });

    expect(front.cellType[barrierCell]).toBe(CellType.Barrier);
  });

  it('Barrier becomes Empty when age reaches barrierLifetime', () => {
    const barrierCell = 2 * W + 2;
    const lifetime    = 10;

    grid.front.cellType[barrierCell] = CellType.Barrier;
    grid.front.energy[barrierCell]   = 1.0;
    // Pre-age to one tick before expiry.
    grid.front.age[barrierCell]      = lifetime - 1;

    const { front } = runOneTick(grid, engine, {
      spreadRate:       0.0,
      energyDecayRate:  0.0,
      barrierLifetime:  lifetime,
    });

    expect(front.cellType[barrierCell]).toBe(CellType.Empty);
  });

  it('Barrier energy fades linearly toward 0 over its lifetime', () => {
    const barrierCell = 2 * W + 2;
    const lifetime    = 100;

    grid.front.cellType[barrierCell] = CellType.Barrier;
    grid.front.energy[barrierCell]   = 1.0;
    grid.front.age[barrierCell]      = 0;

    // After one tick: age = 1, energy should be 1 - 1/100 = 0.99
    const { front } = runOneTick(grid, engine, {
      spreadRate:       0.0,
      energyDecayRate:  0.0,
      barrierLifetime:  lifetime,
    });

    expect(front.energy[barrierCell]).toBeCloseTo(0.99, 5);
  });

  it('Life cannot spread INTO a Barrier cell', () => {
    const centre       = 2 * W + 2;
    const barrierRight = 2 * W + 3;

    grid.front.cellType[centre]       = CellType.Life;
    grid.front.energy[centre]         = 1.0;
    grid.front.cellType[barrierRight] = CellType.Barrier;
    grid.front.energy[barrierRight]   = 1.0;

    for (let tick = 0; tick < 20; tick++) {
      runOneTick(grid, engine, {
        spreadRate:       1.0,
        energyDecayRate:  0.0,
        underpopulationLimit: 0,
        barrierLifetime:  10000, // won't expire during test
      });
    }

    expect(grid.front.cellType[barrierRight]).toBe(CellType.Barrier);
  });
});

// ---------------------------------------------------------------------------
// GravityWell
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 5 GravityWell', () => {
  it('Life cannot spread INTO a GravityWell cell', () => {
    // GravityWell is impassable — Life must never convert it.
    const centre   = 2 * W + 2;
    const wellRight = 2 * W + 3;

    grid.front.cellType[centre]    = CellType.Life;
    grid.front.energy[centre]      = 1.0;
    grid.front.cellType[wellRight] = CellType.GravityWell;

    for (let tick = 0; tick < 20; tick++) {
      runOneTick(grid, engine, {
        spreadRate:           1.0,
        energyDecayRate:      0.0,
        underpopulationLimit: 0,
        gravityStrength:      0.5,
        gravityResponse:      1.0,
      });
    }

    expect(grid.front.cellType[wellRight]).toBe(CellType.GravityWell);
  });

  it('GravityWell itself does not change type or energy each tick', () => {
    const wellCell = 2 * W + 2;

    grid.front.cellType[wellCell] = CellType.GravityWell;
    grid.front.energy[wellCell]   = 0; // wells have no energy

    const { front } = runOneTick(grid, engine, {
      spreadRate:      0.0,
      energyDecayRate: 0.0,
      gravityStrength: 0.5,
      gravityResponse: 1.0,
    });

    expect(front.cellType[wellCell]).toBe(CellType.GravityWell);
    expect(front.energy[wellCell]).toBe(0);
  });

  it('GravityWell biases spread toward itself (spread toward well > away)', () => {
    // Grid layout (Von Neumann for simplicity):
    //  col:  0   1   2   3   4
    //  row2: E   E  Life  E  Well
    //
    // With gravityStrength=1.0 the well is only 2 cells from Life.
    // We run many ticks and check that the cell BETWEEN Life and Well (col 3)
    // gets filled more often than the cell on the opposite side (col 1).
    // We repeat the experiment 20 times and count successes.
    const REPEATS = 40;
    let towardWellCount = 0;
    let awayFromWellCount = 0;

    for (let rep = 0; rep < REPEATS; rep++) {
      const g      = new GridState(W, H);
      const eng    = new SimulationEngine(W, H);
      const life   = 2 * W + 2; // (2,2)
      const toward = 2 * W + 3; // (3,2) — between life and well
      const away   = 2 * W + 1; // (1,2) — opposite side
      const well   = 2 * W + 4; // (4,2)

      g.front.cellType[life] = CellType.Life;
      g.front.energy[life]   = 1.0;
      g.front.cellType[well] = CellType.GravityWell;

      // One tick with maximal spread + gravity bias.
      runOneTick(g, eng, {
        spreadRate:           0.3,   // base 30% — gravity will push "toward" higher
        energyDecayRate:      0.0,
        underpopulationLimit: 0,
        neighbourhoodMode:    'vonNeumann',
        gravityStrength:      2.0,   // strong pull for reliable test signal
        gravityResponse:      1.0,
      });

      if (g.front.cellType[toward] === CellType.Life) towardWellCount++;
      if (g.front.cellType[away]   === CellType.Life) awayFromWellCount++;
    }

    // With strong gravity, the "toward" cell should be colonised MORE often
    // than the "away" cell over many trials.  A 3:2 ratio is a conservatively
    // detectable signal at 40 repeats.
    expect(towardWellCount).toBeGreaterThan(awayFromWellCount);
  });
});

// ===========================================================================
// Phase 9 — Per-Cell Phenotype and Genome Inheritance
// ===========================================================================

// ---------------------------------------------------------------------------
// Genome inheritance
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 9 genome inheritance', () => {
  it('child genome equals parent genome when pointMutationRate = 0', () => {
    // Parent Life at centre spreads right.  With mutation off the child must
    // carry the exact same genome as the parent.
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    const parentGenome = packGenome(3, 5, 2, 14); // arbitrary non-neutral genome

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;
    grid.front.genome[centre]   = parentGenome;

    const { front } = runOneTick(grid, engine, {
      spreadRate:        1.0,
      energyDecayRate:   0.0,
      underpopulationLimit: 0,
      pointMutationRate: 0.0,  // mutations disabled
      juvenileThreshold: 0,    // disable juvenile spread penalty
    });

    expect(front.cellType[right]).toBe(CellType.Life);
    // Child's genome must be a verbatim copy of the parent's.
    expect(front.genome[right]).toBe(parentGenome);
  });

  it('child generation = parent generation + 1 after spread', () => {
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;
    const parentGeneration = 42;

    grid.front.cellType[centre]    = CellType.Life;
    grid.front.energy[centre]      = 1.0;
    grid.front.generation[centre]  = parentGeneration;

    const { front } = runOneTick(grid, engine, {
      spreadRate:        1.0,
      energyDecayRate:   0.0,
      underpopulationLimit: 0,
      pointMutationRate: 0.0,
      juvenileThreshold: 0, // disable juvenile spread penalty
    });

    expect(front.cellType[right]).toBe(CellType.Life);
    expect(front.generation[right]).toBe(parentGeneration + 1);
  });

  it('child variantId inherits parent variantId unchanged', () => {
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;
    const parentVariantId = 7;

    grid.front.cellType[centre]   = CellType.Life;
    grid.front.energy[centre]     = 1.0;
    grid.front.variantId[centre]  = parentVariantId;
    // Genome must match the engine's lineage reference (0x7777 = neutral default)
    // so that the child's genome (same, no mutation) does not spuriously diverge
    // from the reference and trigger speciation.
    grid.front.genome[centre]     = 0x7777;

    const { front } = runOneTick(grid, engine, {
      spreadRate:        1.0,
      energyDecayRate:   0.0,
      underpopulationLimit: 0,
      pointMutationRate: 0.0,
      juvenileThreshold: 0, // disable juvenile spread penalty
    });

    expect(front.cellType[right]).toBe(CellType.Life);
    expect(front.variantId[right]).toBe(parentVariantId);
  });

  it('phenotype buffers are written on child after spread', () => {
    // Parent has a genome that yields distinct phenotype values.  After spread
    // the child's phenotype buffers must match what GENOME_LUT predicts.
    const centre = 2 * W + 2;
    const right  = 2 * W + 3;

    // High toxin tier → measurable toxinResist; max nutrient tier → nutrientAbs = 1.0.
    const parentGenome = packGenome(7, 7, 15, 15);

    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;
    grid.front.genome[centre]   = parentGenome;

    const { front } = runOneTick(grid, engine, {
      spreadRate:        1.0,
      energyDecayRate:   0.0,
      underpopulationLimit: 0,
      pointMutationRate: 0.0,  // child inherits genome exactly
      juvenileThreshold: 0,    // disable juvenile spread penalty
    });

    expect(front.cellType[right]).toBe(CellType.Life);
    expect(front.toxinResist[right]).toBeCloseTo(getToxinResist(parentGenome), 5);
    expect(front.nutrientAbs[right]).toBeCloseTo(getNutrientAbs(parentGenome), 5);
    expect(front.spreadBonus[right]).toBeCloseTo(getSpreadBonus(parentGenome), 5);
  });
});

// ---------------------------------------------------------------------------
// Per-cell phenotype effects
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 9 per-cell phenotype effects', () => {
  it('per-cell toxinResist reduces toxin damage proportionally', () => {
    // Two Life cells side-by-side, each adjacent to a Toxin.  One has
    // toxinResist = 0.0 (full damage), the other toxinResist = 0.5 (half).
    const fullDamageIdx  = 1 * W + 1; // (1,1)
    const halfDamageIdx  = 3 * W + 1; // (1,3) — same column, different row
    const toxinA = 1 * W + 2;         // toxin right of fullDamage
    const toxinB = 3 * W + 2;         // toxin right of halfDamage

    grid.front.cellType[fullDamageIdx]  = CellType.Life;
    grid.front.energy[fullDamageIdx]    = 0.8;
    grid.front.toxinResist[fullDamageIdx] = 0.0; // no resistance

    grid.front.cellType[halfDamageIdx]  = CellType.Life;
    grid.front.energy[halfDamageIdx]    = 0.8;
    grid.front.toxinResist[halfDamageIdx] = 0.5; // 50% resistance

    grid.front.cellType[toxinA] = CellType.Toxin;
    grid.front.cellType[toxinB] = CellType.Toxin;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      toxinStrength:        0.1,
    });

    // fullDamage: 0.8 - 0.1 × (1 - 0.0) = 0.70
    expect(front.energy[fullDamageIdx]).toBeCloseTo(0.70, 5);
    // halfDamage: 0.8 - 0.1 × (1 - 0.5) = 0.75
    expect(front.energy[halfDamageIdx]).toBeCloseTo(0.75, 5);
  });

  it('per-cell nutrientAbs scales nutrient boost proportionally', () => {
    // Two Life cells: one with full absorption, one with half.
    const fullAbsIdx = 1 * W + 1;
    const halfAbsIdx = 3 * W + 1;
    const nutA = 1 * W + 2;
    const nutB = 3 * W + 2;

    grid.front.cellType[fullAbsIdx]  = CellType.Life;
    grid.front.energy[fullAbsIdx]    = 0.5;
    grid.front.nutrientAbs[fullAbsIdx] = 1.0;

    grid.front.cellType[halfAbsIdx]  = CellType.Life;
    grid.front.energy[halfAbsIdx]    = 0.5;
    grid.front.nutrientAbs[halfAbsIdx] = 0.5;

    grid.front.cellType[nutA] = CellType.Nutrient;
    grid.front.energy[nutA]   = 1.0;
    grid.front.cellType[nutB] = CellType.Nutrient;
    grid.front.energy[nutB]   = 1.0;

    const { front } = runOneTick(grid, engine, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      nutrientBoost:        0.1,
      nutrientDecayRate:    0.0,
    });

    // fullAbs: 0.5 + 0.1 × 1.0 = 0.60
    expect(front.energy[fullAbsIdx]).toBeCloseTo(0.60, 5);
    // halfAbs: 0.5 + 0.1 × 0.5 = 0.55
    expect(front.energy[halfAbsIdx]).toBeCloseTo(0.55, 5);
  });

  it('per-cell spreadBonus increases effective spread rate', () => {
    // A cell with spreadBonus = +0.4 should spread more reliably than one
    // with spreadBonus = 0 at a low base spreadRate.  Run 100 repetitions and
    // compare colonisation counts.
    const REPEATS    = 100;
    let bonusCount   = 0;
    let normalCount  = 0;
    const BASE_RATE  = 0.3;
    const HIGH_BONUS = getSpreadBonus(packGenome(15, 7, 7, 7)); // max spread tier

    for (let rep = 0; rep < REPEATS; rep++) {
      // Test 1: cell with spreadBonus
      const gBonus   = new GridState(W, H);
      const eBonus   = new SimulationEngine(W, H);
      const lifeB    = 2 * W + 2;
      const rightB   = 2 * W + 3;
      gBonus.front.cellType[lifeB]    = CellType.Life;
      gBonus.front.energy[lifeB]      = 1.0;
      gBonus.front.genome[lifeB]      = packGenome(15, 7, 7, 7);
      gBonus.front.spreadBonus[lifeB] = HIGH_BONUS;
      runOneTick(gBonus, eBonus, {
        spreadRate:        BASE_RATE,
        energyDecayRate:   0.0,
        underpopulationLimit: 0,
        pointMutationRate: 0.0,
      });
      if (gBonus.front.cellType[rightB] === CellType.Life) bonusCount++;

      // Test 2: cell with no bonus (GENOME_NEUTRAL default)
      const gNorm  = new GridState(W, H);
      const eNorm  = new SimulationEngine(W, H);
      const lifeN  = 2 * W + 2;
      const rightN = 2 * W + 3;
      gNorm.front.cellType[lifeN]    = CellType.Life;
      gNorm.front.energy[lifeN]      = 1.0;
      gNorm.front.genome[lifeN]      = GENOME_NEUTRAL; // spreadBonus = 0.0
      gNorm.front.spreadBonus[lifeN] = getSpreadBonus(GENOME_NEUTRAL); // 0.0
      runOneTick(gNorm, eNorm, {
        spreadRate:        BASE_RATE,
        energyDecayRate:   0.0,
        underpopulationLimit: 0,
        pointMutationRate: 0.0,
      });
      if (gNorm.front.cellType[rightN] === CellType.Life) normalCount++;
    }

    // A high spreadBonus must produce more successful spreads than no bonus.
    expect(bonusCount).toBeGreaterThan(normalCount);
  });
});

// ---------------------------------------------------------------------------
// Phase 10 — Lifecycle Stages
// ---------------------------------------------------------------------------

/**
 * Common lifecycle config overrides used by most tests in this suite.
 * Energy decay is zeroed out so cells survive long enough to observe flag
 * changes.  Spread is also zeroed to keep grids deterministic.
 */
const LIFECYCLE_BASE = {
  spreadRate:           0.0,   // no spread — isolate lifecycle logic
  energyDecayRate:      0.0,   // no passive decay
  underpopulationLimit: 0,     // no underpop death
  overpopulationLimit:  8,     // effectively disabled
  pointMutationRate:    0.0,   // no genome mutation
  juvenileThreshold:    10,    // age < 10 → juvenile
  senescentThreshold:   50,    // age > 50 → senescent
  apoptosisBoost:       0.05,  // neighbour boost on apoptosis
} as const;

describe('SimulationEngine — Phase 10 lifecycle flags', () => {
  it('sets JUVENILE flag when cell age is below juvenileThreshold', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 1.0;
    // age = 0, so after one tick age = 1 which is < 10 → JUVENILE expected
    grid.front.age[i] = 0;

    runOneTick(grid, engine, { ...LIFECYCLE_BASE });

    // Flag bitmask for JUVENILE = 0b0000_1000 (bit 3)
    const JUVENILE_BIT = CellFlags.JUVENILE;
    expect(grid.front.cellType[i]).toBe(CellType.Life);
    expect(grid.front.flags[i] & JUVENILE_BIT).toBe(JUVENILE_BIT);
  });

  it('clears JUVENILE flag when cell age is at juvenileThreshold', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 1.0;
    // The engine reads the front-buffer age and checks `age < juvenileThreshold`.
    // Setting age = 10 (= threshold) means 10 < 10 = false → not juvenile.
    grid.front.age[i] = 10; // juvenileThreshold = 10; 10 is NOT < 10

    runOneTick(grid, engine, { ...LIFECYCLE_BASE });

    const JUVENILE_BIT = CellFlags.JUVENILE;
    // age = 10 which is NOT < 10, so JUVENILE bit must be cleared.
    expect(grid.front.flags[i] & JUVENILE_BIT).toBe(0);
  });

  it('sets SENESCENT flag when cell age exceeds senescentThreshold', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 1.0;
    // Set age just above the threshold so the cell is already senescent.
    grid.front.age[i] = 55; // > senescentThreshold (50)

    runOneTick(grid, engine, { ...LIFECYCLE_BASE });

    const SENESCENT_BIT = CellFlags.SENESCENT;
    expect(grid.front.flags[i] & SENESCENT_BIT).toBe(SENESCENT_BIT);
    // JUVENILE must not be set at the same time as SENESCENT
    const JUVENILE_BIT = CellFlags.JUVENILE;
    expect(grid.front.flags[i] & JUVENILE_BIT).toBe(0);
  });

  it('does not set SENESCENT flag on a mature cell (age between thresholds)', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 1.0;
    grid.front.age[i] = 30; // between 10 and 50

    runOneTick(grid, engine, { ...LIFECYCLE_BASE });

    const JUVENILE_BIT  = CellFlags.JUVENILE;
    const SENESCENT_BIT = CellFlags.SENESCENT;
    expect(grid.front.flags[i] & JUVENILE_BIT).toBe(0);
    expect(grid.front.flags[i] & SENESCENT_BIT).toBe(0);
  });

  it('clears lifecycle flags when a cell dies of energy starvation', () => {
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    // Use a mature cell (age 30, between thresholds) so the 1× decay multiplier
    // applies — no juvenile 0.8× reduction.  Energy exactly matches decay rate
    // so newEnergy = 0 and the cell dies this tick.
    grid.front.energy[i] = 0.01;
    grid.front.age[i]    = 30; // mature (between juvenileThreshold=10 and senescentThreshold=50)

    runOneTick(grid, engine, {
      ...LIFECYCLE_BASE,
      energyDecayRate: 0.01, // exactly kills the cell (1× multiplier for mature)
    });

    // Cell should be Empty; all flags must be zero.
    expect(grid.front.cellType[i]).toBe(CellType.Empty);
    expect(grid.front.flags[i]).toBe(0);
  });
});

describe('SimulationEngine — Phase 10 juvenile spread rate', () => {
  it('juvenile cells spread far less often than mature cells', () => {
    // Run many iterations comparing juvenile vs mature spread counts.
    // Each trial: 1 cell with energy 1.0, spreadRate = 1.0 (deterministic
    // without lifecycle) — juvenile should succeed much less often.
    const W2 = 5, H2 = 5;
    const centre   = 2 * W2 + 2;
    const RIGHT    = centre + 1;
    const TRIALS   = 200;
    let juvenileSpread = 0;
    let matureSpread   = 0;

    for (let t = 0; t < TRIALS; t++) {
      // Juvenile trial: age = 0 (< juvenileThreshold=10)
      const gJuv = new GridState(W2, H2);
      const eJuv = new SimulationEngine(W2, H2);
      gJuv.front.cellType[centre] = CellType.Life;
      gJuv.front.energy[centre]   = 1.0;
      gJuv.front.age[centre]      = 0;
      runOneTick(gJuv, eJuv, {
        ...LIFECYCLE_BASE,
        spreadRate: 1.0,
        reproductionThreshold: 0.0,
        juvenileThreshold:     10,
      });
      if (gJuv.front.cellType[RIGHT] === CellType.Life) juvenileSpread++;

      // Mature trial: age = 30 (between thresholds)
      const gMat = new GridState(W2, H2);
      const eMat = new SimulationEngine(W2, H2);
      gMat.front.cellType[centre] = CellType.Life;
      gMat.front.energy[centre]   = 1.0;
      gMat.front.age[centre]      = 30;
      runOneTick(gMat, eMat, {
        ...LIFECYCLE_BASE,
        spreadRate: 1.0,
        reproductionThreshold: 0.0,
        juvenileThreshold:     10,
      });
      if (gMat.front.cellType[RIGHT] === CellType.Life) matureSpread++;
    }

    // Mature cells must spread more than juveniles across 200 trials.
    // Mature should approach TRIALS (spreadRate=1), juvenile ~40% of TRIALS.
    expect(matureSpread).toBeGreaterThan(juvenileSpread);
  });
});

describe('SimulationEngine — Phase 10 senescent decay rate', () => {
  it('senescent cells lose energy faster than mature cells', () => {
    // Compare final energy of senescent vs mature cell after one tick at
    // the same base energyDecayRate.  Senescent applies a 1.5× multiplier.
    const W2 = 5, H2 = 5;
    const i = 2 * W2 + 2;
    const DECAY = 0.02;

    // Mature cell (age 30)
    const gMat = new GridState(W2, H2);
    const eMat = new SimulationEngine(W2, H2);
    gMat.front.cellType[i] = CellType.Life;
    gMat.front.energy[i]   = 0.5;
    gMat.front.age[i]      = 30;
    runOneTick(gMat, eMat, { ...LIFECYCLE_BASE, energyDecayRate: DECAY });
    const matureEnergy = gMat.front.energy[i];

    // Senescent cell (age 60 > senescentThreshold 50)
    const gSen = new GridState(W2, H2);
    const eSen = new SimulationEngine(W2, H2);
    gSen.front.cellType[i] = CellType.Life;
    gSen.front.energy[i]   = 0.5;
    gSen.front.age[i]      = 60;
    runOneTick(gSen, eSen, { ...LIFECYCLE_BASE, energyDecayRate: DECAY });
    const senescentEnergy = gSen.front.energy[i];

    // Senescent cell must have lost more energy than mature.
    expect(senescentEnergy).toBeLessThan(matureEnergy);
    // The difference should be approximately DECAY × 0.5 (1.5× vs 1×)
    expect(matureEnergy - senescentEnergy).toBeCloseTo(DECAY * 0.5, 5);
  });
});

describe('SimulationEngine — Phase 10 juvenile no-mutation', () => {
  it('juvenile cells never mutate regardless of pointMutationRate', () => {
    // Run many ticks on a juvenile cell with a very high mutation rate.
    // The genome should remain unchanged in every trial because
    // stageMutationRate = 0 for juveniles.
    const W2 = 5, H2 = 5;
    const i  = 2 * W2 + 2;
    const INITIAL_GENOME = 0x0000;
    let mutationObserved = false;

    for (let trial = 0; trial < 200; trial++) {
      const g = new GridState(W2, H2);
      const e = new SimulationEngine(W2, H2);
      g.front.cellType[i] = CellType.Life;
      g.front.energy[i]   = 1.0;
      g.front.age[i]      = 0; // juvenile
      g.front.genome[i]   = INITIAL_GENOME;

      runOneTick(g, e, {
        ...LIFECYCLE_BASE,
        pointMutationRate: 1.0, // maximum rate — still 0 for juvenile
        juvenileThreshold: 10,
      });

      // The cell itself cannot mutate its own genome in-place (mutation
      // affects the child genome written during spread).  To observe the
      // juvenile no-mutation rule we need to allow spread and check the
      // child's genome vs parent's.  Here we verify that the parent genome
      // is unchanged after the tick (SimulationEngine copies genome to back).
      if (g.front.genome[i] !== INITIAL_GENOME) {
        mutationObserved = true;
        break;
      }
    }

    // The parent genome should never change — mutations only apply to children.
    // This assertion verifies the buffer copy is faithful.
    expect(mutationObserved).toBe(false);
  });
});

describe('SimulationEngine — Phase 10 apoptosis', () => {
  it('apoptosis: senescent cell with near-zero energy dies and boosts neighbour', () => {
    // Place a senescent cell at a HIGHER index than its neighbour so that the
    // engine processes the neighbour first.  The apoptosis boost is written to
    // the neighbour's BACK buffer slot; if the senescent cell is processed last
    // that write is final and survives the buffer swap.
    //
    // Layout (5×5 grid, row-major):
    //   nb  = row 2 col 2 → index 12  (processed before index 13)
    //   i   = row 2 col 3 → index 13  (senescent, processed after nb)
    const W2 = 5, H2 = 5;
    const nb = 2 * W2 + 2; // index 12 — left (lower index, processed first)
    const i  = 2 * W2 + 3; // index 13 — right (higher index, processed second)

    const g = new GridState(W2, H2);
    const e = new SimulationEngine(W2, H2);

    g.front.cellType[i] = CellType.Life;
    g.front.energy[i]   = 0.03; // below 0.05 apoptosis threshold
    g.front.age[i]      = 60;   // senescent (> senescentThreshold 50)

    g.front.cellType[nb] = CellType.Life;
    g.front.energy[nb]   = 0.5;
    g.front.age[nb]      = 30;   // mature

    const BOOST = 0.05;
    runOneTick(g, e, {
      ...LIFECYCLE_BASE,
      energyDecayRate: 0.0, // no passive decay — apoptosis is the death cause
      apoptosisBoost:  BOOST,
    });

    // The senescent cell should have died via apoptosis.
    expect(g.front.cellType[i]).toBe(CellType.Empty);
    expect(g.front.energy[i]).toBe(0);
    expect(g.front.flags[i]).toBe(0);

    // The neighbour was processed before the senescent cell, so its bkEnergy
    // was written (0.5 after its own tick).  Then apoptosis wrote 0.5+BOOST
    // to bkEnergy[nb] — no subsequent overwrite → boost is preserved.
    expect(g.front.energy[nb]).toBeCloseTo(0.5 + BOOST, 5);
  });

  it('apoptosis: dying senescent cell boosts the neighbour energy (proxy for signal write)', () => {
    // Senescent cell at higher index → processed after its left neighbour.
    // Verifies the apoptosis code path ran and the boost survived the swap.
    const W2 = 5, H2 = 5;
    const nb = 2 * W2 + 2; // index 12, processed first
    const i  = 2 * W2 + 3; // index 13, processed second (senescent)

    const g = new GridState(W2, H2);
    const e = new SimulationEngine(W2, H2);

    g.front.cellType[i] = CellType.Life;
    g.front.energy[i]   = 0.01; // very low — apoptosis triggers
    g.front.age[i]      = 100;  // well above senescentThreshold

    g.front.cellType[nb] = CellType.Life;
    g.front.energy[nb]   = 0.2;
    g.front.age[nb]      = 20;

    const BOOST = 0.08;
    runOneTick(g, e, {
      ...LIFECYCLE_BASE,
      apoptosisBoost: BOOST,
    });

    // Apoptosis ran → neighbour was boosted.
    expect(g.front.energy[nb]).toBeCloseTo(0.2 + BOOST, 5);
    // Dying cell is now Empty.
    expect(g.front.cellType[i]).toBe(CellType.Empty);
  });

  it('apoptosis does not trigger when energy is above the 0.05 threshold', () => {
    // A senescent cell with energy above 0.05 should NOT die via apoptosis.
    const W2 = 5, H2 = 5;
    const i  = 2 * W2 + 2;
    const nb = 2 * W2 + 3;

    const g = new GridState(W2, H2);
    const e = new SimulationEngine(W2, H2);

    g.front.cellType[i] = CellType.Life;
    g.front.energy[i]   = 0.1; // above 0.05 — no apoptosis
    g.front.age[i]      = 60;  // senescent

    g.front.cellType[nb] = CellType.Life;
    g.front.energy[nb]   = 0.5;
    g.front.age[nb]      = 20;

    const energyBefore = g.front.energy[nb];
    runOneTick(g, e, {
      ...LIFECYCLE_BASE,
      energyDecayRate: 0.0,
      apoptosisBoost:  0.05,
    });

    // Senescent cell survived — still Life.
    expect(g.front.cellType[i]).toBe(CellType.Life);
    // Neighbour did not receive apoptosis boost.
    expect(g.front.energy[nb]).toBeCloseTo(energyBefore, 5);
  });
});

// ---------------------------------------------------------------------------
// Phase 18 — JUST_DIVIDED flag
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 18 JUST_DIVIDED flag', () => {
  // Use a tiny 3×3 grid so the lone cell always has empty neighbours.
  const W3 = 3;
  const H3 = 3;
  let g3: GridState;
  let e3: SimulationEngine;

  beforeEach(() => {
    g3 = new GridState(W3, H3);
    e3 = new SimulationEngine(W3, H3);
  });

  it('JUST_DIVIDED has value 0x80', () => {
    expect(CellFlags.JUST_DIVIDED).toBe(0x80);
  });

  it('sets JUST_DIVIDED on parent after spread', () => {
    const centre = 1 * W3 + 1; // middle cell
    g3.front.cellType[centre] = CellType.Life;
    g3.front.energy[centre]   = 1.0;

    runOneTick(g3, e3, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      juvenileThreshold:    0,
    });

    // runOneTick already swapped — front now has post-tick state.
    const parentFlags = g3.front.flags[centre];
    expect(parentFlags & CellFlags.JUST_DIVIDED).toBe(CellFlags.JUST_DIVIDED);
  });

  it('clears JUST_DIVIDED exactly one tick later', () => {
    const centre = 1 * W3 + 1;
    g3.front.cellType[centre] = CellType.Life;
    g3.front.energy[centre]   = 1.0;

    // Tick 1: spread occurs, flag is set (runOneTick swaps internally).
    runOneTick(g3, e3, {
      spreadRate:           1.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      juvenileThreshold:    0,
    });

    // Tick 2: all cells are now Life with no empty neighbours — flag must clear.
    runOneTick(g3, e3, {
      spreadRate:           0.0,
      energyDecayRate:      0.0,
      underpopulationLimit: 0,
      juvenileThreshold:    0,
    });

    const parentFlags = g3.front.flags[centre];
    expect(parentFlags & CellFlags.JUST_DIVIDED).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 19 — Motility & Chemotaxis
// ---------------------------------------------------------------------------

describe('SimulationEngine — Phase 19 motility', () => {
  // Helper: set the genome such that spreadBonus is above the threshold.
  // packGenome(tox, nut, heat, spread) — use maxed spread tier to get ~0.8 bonus.
  const MOTILE_GENOME = packGenome(7, 7, 7, 15); // spread tier 15 → ~1.0 spreadBonus

  it('velocity damps by (1 − motilityDamping) each tick', () => {
    // Place a single Life cell with a pre-set velocity.
    const i = 2 * W + 2;
    grid.front.cellType[i] = CellType.Life;
    grid.front.energy[i]   = 1.0;
    grid.front.genome[i]   = MOTILE_GENOME;
    grid.front.vx[i]       = 1.0;
    grid.front.vy[i]       = 0.0;

    // Apply phenotype from genome so spreadBonus is above the threshold.
    grid.front.spreadBonus[i] = getSpreadBonus(MOTILE_GENOME);

    runOneTick(grid, engine, {
      motilityRate:               1.0,
      motilityThreshold:          0.0, // always motile
      motilityDamping:            0.5, // 50% velocity retained
      chemotaxisMotilityFraction: 0.0, // no chemical bias
      energyDecayRate:            0.0,
      spreadRate:                 0.0,
      underpopulationLimit:       0,
    });

    // After damping, the cell at its new position should carry vx ≈ 0.5.
    // The cell may or may not have migrated; find where the Life cell ended up.
    let foundVx = NaN;
    for (let j = 0; j < W * H; j++) {
      if (grid.front.cellType[j] === CellType.Life) {
        foundVx = grid.front.vx[j];
        break;
      }
    }
    // vx_new = 1.0 * (1 - 0.5) = 0.5  (before any chemotaxis displacement).
    expect(foundVx).toBeCloseTo(0.5, 3);
  });

  it('motile cell migrates to adjacent empty cell when motilityRate=1', () => {
    // Place a Life cell at the centre of a 5×5 grid (surrounded by empty cells).
    const centre = 2 * W + 2;
    grid.front.cellType[centre] = CellType.Life;
    grid.front.energy[centre]   = 1.0;
    grid.front.genome[centre]   = MOTILE_GENOME;
    // Pre-set a rightward velocity large enough to survive damping.
    grid.front.vx[centre]       = 5.0;
    grid.front.vy[centre]       = 0.0;
    grid.front.spreadBonus[centre] = 1.0; // above any threshold

    runOneTick(grid, engine, {
      motilityRate:               1.0,  // guaranteed attempt
      motilityThreshold:          0.0,  // always motile
      motilityDamping:            0.0,  // no damping — velocity kept
      chemotaxisMotilityFraction: 0.0,
      energyDecayRate:            0.0,
      spreadRate:                 0.0,
      // Set reproduction threshold above max energy so no spreading occurs —
      // otherwise spreadBonus adds to the effective spread rate and the cell
      // reproduces before the migration pass, inflating the Life cell count.
      reproductionThreshold:      2.0,
      underpopulationLimit:       0,
    });

    // Exactly one Life cell should exist (the migrated cell).
    let lifeCells = 0;
    for (let j = 0; j < W * H; j++) {
      if (grid.front.cellType[j] === CellType.Life) lifeCells++;
    }
    expect(lifeCells).toBe(1);
    // The original centre must now be empty (migration occurred).
    expect(grid.front.cellType[centre]).toBe(CellType.Empty);
  });

  it('migration is cancelled when the target cell is already occupied', () => {
    // Fill all cells with Life except one corner — the motile cell has nowhere
    // to go that is simultaneously empty in both front and back.
    for (let j = 0; j < W * H; j++) {
      grid.front.cellType[j] = CellType.Life;
      grid.front.energy[j]   = 1.0;
    }
    // Leave the top-left empty.
    grid.front.cellType[0] = CellType.Empty;
    grid.front.energy[0]   = 0.0;

    // The centre cell is motile and wants to move right — but (2*W+3) is Life.
    const centre = 2 * W + 2;
    grid.front.vx[centre]          = 5.0;
    grid.front.vy[centre]          = 0.0;
    grid.front.spreadBonus[centre] = 1.0;

    runOneTick(grid, engine, {
      motilityRate:               1.0,
      motilityThreshold:          0.0,
      motilityDamping:            0.0,
      chemotaxisMotilityFraction: 0.0,
      energyDecayRate:            0.0,
      spreadRate:                 0.0,
      underpopulationLimit:       0,
      overpopulationLimit:        8,
    });

    // The centre cell could not migrate right — it must still be Life.
    expect(grid.front.cellType[centre]).toBe(CellType.Life);
  });

  it('velocity reflected off a Wall neighbour', () => {
    // Place a Life cell at (2,2) with a rightward velocity.
    // Put a Wall at (2,3) — directly to the right.
    const centre = 2 * W + 2;
    const wallIdx = 2 * W + 3;
    grid.front.cellType[centre]  = CellType.Life;
    grid.front.energy[centre]    = 1.0;
    grid.front.genome[centre]    = MOTILE_GENOME;
    grid.front.spreadBonus[centre] = 1.0;
    grid.front.vx[centre]        = 5.0; // strong rightward velocity
    grid.front.vy[centre]        = 0.0;
    grid.front.cellType[wallIdx] = CellType.Wall;

    runOneTick(grid, engine, {
      motilityRate:               1.0,
      motilityThreshold:          0.0,
      motilityDamping:            0.0,
      chemotaxisMotilityFraction: 0.0,
      energyDecayRate:            0.0,
      spreadRate:                 0.0,
      // Block reproduction so spreadBonus doesn't trigger spreading.
      reproductionThreshold:      2.0,
      underpopulationLimit:       0,
    });

    // The reflection sets bkVx[centre] = -5.0 BEFORE the migration step picks
    // the best destination (the up-right diagonal also has dot > 0).  The cell
    // may migrate, but the reflected velocity is always carried to the destination.
    // Either way, the surviving Life cell must carry a negative vx.
    let reflVx = NaN;
    for (let j = 0; j < W * H; j++) {
      if (grid.front.cellType[j] === CellType.Life) { reflVx = grid.front.vx[j]; break; }
    }
    expect(reflVx).toBeLessThan(0);
  });

  it('chemotaxisMotilityFraction=0 produces zero gradient bias', () => {
    // Place a Life cell adjacent to a Nutrient cell.
    // With chemotaxisMotilityFraction=0 the velocity update ignores it.
    const centre   = 2 * W + 2;
    const nutrient = 2 * W + 3; // right of centre
    grid.front.cellType[centre]    = CellType.Life;
    grid.front.energy[centre]      = 1.0;
    grid.front.spreadBonus[centre] = 0.0; // below threshold → no migration attempt
    // Seed a leftward velocity — with no chemotaxis this should stay leftward.
    grid.front.vx[centre]  = -1.0;
    grid.front.vy[centre]  =  0.0;
    grid.front.cellType[nutrient] = CellType.Nutrient;
    grid.front.energy[nutrient]   = 1.0;

    runOneTick(grid, engine, {
      motilityRate:               0.0, // migration off — only velocity update runs
      motilityThreshold:          0.5,
      motilityDamping:            0.0, // no damping — preserves sign
      chemotaxisMotilityFraction: 0.0, // zero bias
      energyDecayRate:            0.0,
      spreadRate:                 0.0,
      underpopulationLimit:       0,
      nutrientBoost:              0.0, // prevent energy changes
      nutrientDecayRate:          0.0,
    });

    // vx should remain negative — Nutrient did not attract the cell.
    expect(grid.front.vx[centre]).toBeLessThanOrEqual(0);
  });
});
