/**
 * @fileoverview Unit tests for GridState.
 *
 * Tests cover:
 *   - Buffer allocation and dimensions.
 *   - seed() randomness and density.
 *   - clear() zeroing all buffers.
 *   - copyFrontToBack() faithfulness.
 *   - swap() pointer swap.
 *   - paintCell() bounds checking and value writes.
 *   - countCells() correctness.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GridState, CellType } from './GridState.js';
import { GENOME_NEUTRAL } from './genetics/GenomeEncoder.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const W = 8;
const H = 8;
let grid: GridState;

beforeEach(() => {
  grid = new GridState(W, H);
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('GridState — construction', () => {
  it('reports correct dimensions', () => {
    expect(grid.width).toBe(W);
    expect(grid.height).toBe(H);
    expect(grid.totalCells).toBe(W * H);
  });

  it('allocates front and back buffers of the correct length', () => {
    const n = W * H;
    // Round 1 buffers
    expect(grid.front.cellType.length).toBe(n);
    expect(grid.front.energy.length).toBe(n);
    expect(grid.front.age.length).toBe(n);
    expect(grid.front.flags.length).toBe(n);
    // Round 2 genome buffers
    expect(grid.front.genome.length).toBe(n);
    expect(grid.front.variantId.length).toBe(n);
    expect(grid.front.generation.length).toBe(n);
    expect(grid.front.toxinResist.length).toBe(n);
    expect(grid.front.nutrientAbs.length).toBe(n);
    expect(grid.front.heatResist.length).toBe(n);
    expect(grid.front.spreadBonus.length).toBe(n);
    expect(grid.front.signalStrength.length).toBe(n);

    expect(grid.back.cellType.length).toBe(n);
    expect(grid.back.genome.length).toBe(n);
  });

  it('starts with all cells zeroed (Empty)', () => {
    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.front.cellType[i]).toBe(CellType.Empty);
      expect(grid.front.energy[i]).toBe(0);
      // Round 2 genome buffers must also start zeroed.
      expect(grid.front.genome[i]).toBe(0);
      expect(grid.front.variantId[i]).toBe(0);
      expect(grid.front.generation[i]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// seed()
// ---------------------------------------------------------------------------

describe('GridState — seed()', () => {
  it('seeds with density 0 → all empty', () => {
    grid.seed(0);
    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.front.cellType[i]).toBe(CellType.Empty);
    }
  });

  it('seeds with density 1 → all life', () => {
    grid.seed(1.0, 0.8);
    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.front.cellType[i]).toBe(CellType.Life);
      expect(grid.front.energy[i]).toBeCloseTo(0.8);
    }
  });

  it('seeds with density 0.5 → roughly half the cells are Life', () => {
    // Use a large grid for statistical stability.
    const bigGrid = new GridState(100, 100);
    bigGrid.seed(0.5);
    let lifeCount = 0;
    for (let i = 0; i < bigGrid.totalCells; i++) {
      if (bigGrid.front.cellType[i] === CellType.Life) lifeCount++;
    }
    // Allow ±15% from the expected 50%.
    expect(lifeCount).toBeGreaterThan(bigGrid.totalCells * 0.35);
    expect(lifeCount).toBeLessThan(bigGrid.totalCells * 0.65);
  });

  it('resets age and flags to 0', () => {
    // Manually dirty age and flags.
    grid.front.age[0]   = 999;
    grid.front.flags[0] = 0xff;

    grid.seed(1.0);

    expect(grid.front.age[0]).toBe(0);
    expect(grid.front.flags[0]).toBe(0);
  });

  it('seeds Life cells with GENOME_NEUTRAL (0x7777) and variantId=0', () => {
    grid.seed(1.0, 1.0);
    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.front.genome[i]).toBe(GENOME_NEUTRAL);
      expect(grid.front.variantId[i]).toBe(0);
      expect(grid.front.generation[i]).toBe(0);
    }
  });

  it('sets genome=0 for empty cells when density=0', () => {
    grid.seed(0);
    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.front.genome[i]).toBe(0);
    }
  });

  it('initialises phenotype buffers to GENOME_NEUTRAL values for Life cells on seed', () => {
    // Phase 9: seed() initialises per-cell phenotype from GENOME_NEUTRAL so
    // pre-existing dirty values are overwritten — no manual zeroing needed.
    grid.front.toxinResist[0]    = 0.9;
    grid.front.nutrientAbs[0]    = 0.5;
    grid.front.heatResist[0]     = 0.7;
    grid.front.spreadBonus[0]    = 0.3;
    grid.front.signalStrength[0] = 1.0;

    // seed(1.0) fills the entire grid with Life cells.
    grid.seed(1.0);

    // Life cells must carry the neutral phenotype derived from GENOME_NEUTRAL
    // (0x7777 — all traits at tier 7 = mid-scale).
    // toxinResist tier 7 = (7/15)×0.90 ≈ 0.42
    // nutrientAbs tier 7 = 0.20 + (7/15)×0.80 ≈ 0.573
    // spreadBonus tier 7 = 0.00 (exact neutral)
    // heatResist  = toxinResist × 0.5 ≈ 0.21
    expect(grid.front.toxinResist[0]).toBeGreaterThan(0);
    expect(grid.front.nutrientAbs[0]).toBeGreaterThan(0);
    expect(grid.front.heatResist[0]).toBeGreaterThan(0);
    expect(grid.front.spreadBonus[0]).toBeCloseTo(0.0, 2); // tier 7 = neutral = ~0
    // signalStrength is unrelated to phenotype — still zeroed.
    expect(grid.front.signalStrength[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('GridState — clear()', () => {
  it('zeros all values in both front and back buffers', () => {
    grid.seed(1.0, 1.0);

    // Dirty the back buffer too.
    grid.back.cellType[0] = CellType.Wall;
    grid.back.energy[0]   = 0.5;

    grid.clear();

    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.front.cellType[i]).toBe(0);
      expect(grid.front.energy[i]).toBe(0);
      expect(grid.back.cellType[i]).toBe(0);
      expect(grid.back.energy[i]).toBe(0);
    }
  });

  it('zeros all Round 2 genome buffers in both front and back', () => {
    grid.seed(1.0, 1.0);
    // Dirty genome fields manually.
    grid.front.genome[0]     = 0xABCD;
    grid.front.variantId[0]  = 42;
    grid.back.genome[0]      = 0x1234;
    grid.back.signalStrength[0] = 0.8;

    grid.clear();

    expect(grid.front.genome[0]).toBe(0);
    expect(grid.front.variantId[0]).toBe(0);
    expect(grid.back.genome[0]).toBe(0);
    expect(grid.back.signalStrength[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// copyFrontToBack()
// ---------------------------------------------------------------------------

describe('GridState — copyFrontToBack()', () => {
  it('makes back an exact copy of front (Round 1 + Round 2 buffers)', () => {
    grid.seed(0.7, 0.6);
    // Dirty a genome field in front to make the copy non-trivial.
    grid.front.genome[0]        = 0x1234;
    grid.front.variantId[0]     = 5;
    grid.front.signalStrength[0] = 0.75;

    // Differ the back buffer first.
    grid.back.cellType[0] = CellType.Wall;

    grid.copyFrontToBack();

    for (let i = 0; i < grid.totalCells; i++) {
      expect(grid.back.cellType[i]).toBe(grid.front.cellType[i]);
      expect(grid.back.energy[i]).toBeCloseTo(grid.front.energy[i]);
      expect(grid.back.age[i]).toBe(grid.front.age[i]);
      expect(grid.back.flags[i]).toBe(grid.front.flags[i]);
      // Round 2 genome buffers must also be faithfully copied.
      expect(grid.back.genome[i]).toBe(grid.front.genome[i]);
      expect(grid.back.variantId[i]).toBe(grid.front.variantId[i]);
      expect(grid.back.generation[i]).toBe(grid.front.generation[i]);
    }
  });

  it('produces independent copies (mutation of back does not affect front)', () => {
    grid.seed(1.0, 0.5);
    grid.copyFrontToBack();

    // Mutate back.
    grid.back.cellType[3] = CellType.Wall;
    grid.back.energy[3]   = 0.0;

    // Front should be unchanged.
    expect(grid.front.cellType[3]).toBe(CellType.Life);
    expect(grid.front.energy[3]).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// swap()
// ---------------------------------------------------------------------------

describe('GridState — swap()', () => {
  it('swaps front and back references', () => {
    grid.seed(1.0);
    const originalFront = grid.front;
    const originalBack  = grid.back;

    grid.swap();

    expect(grid.front).toBe(originalBack);
    expect(grid.back).toBe(originalFront);
  });

  it('double-swap returns to original references', () => {
    const originalFront = grid.front;
    grid.swap();
    grid.swap();
    expect(grid.front).toBe(originalFront);
  });
});

// ---------------------------------------------------------------------------
// paintCell()
// ---------------------------------------------------------------------------

describe('GridState — paintCell()', () => {
  it('writes the correct type and energy', () => {
    grid.paintCell(5, CellType.Life, 0.75);
    expect(grid.front.cellType[5]).toBe(CellType.Life);
    expect(grid.front.energy[5]).toBeCloseTo(0.75);
    expect(grid.front.age[5]).toBe(0);
    expect(grid.front.flags[5]).toBe(0);
  });

  it('sets energy to 0 for non-life types', () => {
    grid.paintCell(2, CellType.Wall);
    expect(grid.front.energy[2]).toBe(0);
  });

  it('ignores out-of-bounds indices silently', () => {
    expect(() => grid.paintCell(-1, CellType.Life)).not.toThrow();
    expect(() => grid.paintCell(grid.totalCells + 10, CellType.Life)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// countCells()
// ---------------------------------------------------------------------------

describe('GridState — countCells()', () => {
  it('returns 0 on a freshly constructed grid', () => {
    expect(grid.countCells(CellType.Life)).toBe(0);
  });

  it('counts correctly after seeding with density 1', () => {
    grid.seed(1.0);
    expect(grid.countCells(CellType.Life)).toBe(grid.totalCells);
    expect(grid.countCells(CellType.Empty)).toBe(0);
  });

  it('counts a single painted cell', () => {
    grid.paintCell(0, CellType.Wall);
    expect(grid.countCells(CellType.Wall)).toBe(1);
    expect(grid.countCells(CellType.Life)).toBe(0);
  });
});
