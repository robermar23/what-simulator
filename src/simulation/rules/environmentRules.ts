/**
 * @fileoverview Environmental cell update rules for the What Simulator.
 *
 * Pure helper functions for the Phase 5 dynamic obstacles: Fire and Barrier.
 * These cells change state over time, unlike the passive Toxin/Nutrient cells
 * from Phase 2 which are fully handled inside SimulationEngine directly.
 *
 * Design contract: zero allocations, no DOM access, no side effects.
 * Every function is unit-testable in a plain Node/Vitest environment.
 *
 * ## Fire lifecycle
 *
 *   A Fire cell:
 *   1. Burns through its energy supply at `fireBurnRate` per tick.
 *   2. Attempts to spread to adjacent Life cells (killing them by converting
 *      them to Fire at full energy).
 *   3. Attempts to spread to adjacent Nutrient cells (consuming them as fuel,
 *      converting them to Fire at full energy).
 *   4. Dies (→ Empty) when energy ≤ 0.
 *
 * ## Barrier lifecycle
 *
 *   A Barrier cell:
 *   1. Increments its `age` counter each tick (handled by the main engine loop).
 *   2. Updates its `energy` field to `1 - age/barrierLifetime` so the
 *      ColorMap can render a fade effect without extra state.
 *   3. Becomes Empty when `age ≥ barrierLifetime`.
 */

import { CellType } from '../GridState.js';

// ---------------------------------------------------------------------------
// Barrier
// ---------------------------------------------------------------------------

/**
 * Computes the new energy value for a Barrier cell based on its age.
 *
 * Energy starts at 1.0 when the barrier is placed (age = 0) and linearly
 * decays to 0 at age = barrierLifetime.  The energy field is used purely for
 * visual fading — the ColorMap renders Barrier with energy-modulated
 * brightness, so the barrier visually fades out before it crumbles.
 *
 * @param age - Current age of the barrier in ticks.
 * @param barrierLifetime - Total ticks before the barrier crumbles.
 * @returns Energy value in [0, 1].  0 means the barrier should die.
 */
export function calcBarrierEnergy(age: number, barrierLifetime: number): number {
  if (barrierLifetime <= 0) return 0;
  // Linear fade from 1.0 → 0.0 over barrierLifetime ticks.
  return Math.max(0, 1 - age / barrierLifetime);
}

/**
 * Returns `true` if a Barrier cell has reached the end of its lifetime.
 *
 * @param age - Current age of the barrier in ticks.
 * @param barrierLifetime - Ticks before the barrier crumbles to Empty.
 * @returns True when the barrier should be replaced by Empty.
 */
export function isBarrierExpired(age: number, barrierLifetime: number): boolean {
  return age >= barrierLifetime;
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

/**
 * Calculates the new energy (remaining fuel) for a Fire cell after one tick.
 *
 * Fire cells burn through their energy at `fireBurnRate` per tick.  A freshly
 * painted Fire cell starts at energy = 1.0.  When energy reaches 0 the fire
 * cell should become Empty.
 *
 * @param currentEnergy - Fire cell's current energy in [0, 1].
 * @param fireBurnRate - Energy consumed per tick.
 * @returns New energy, clamped to [0, 1].  0 means the fire has burned out.
 */
export function calcFireBurndown(currentEnergy: number, fireBurnRate: number): number {
  return Math.max(0, currentEnergy - fireBurnRate);
}

/**
 * Attempts to spread a Fire cell to one eligible adjacent cell.
 *
 * Fire spreads to:
 *   - Adjacent **Life** or **LifeVariant** cells: converts them to Fire at
 *     full energy (the consumed organic matter becomes fuel).
 *   - Adjacent **Nutrient** cells: converts them to Fire at full energy (the
 *     nutrient acts as additional fuel).
 *
 * Spread is attempted once per neighbour, with a fixed probability of 1.0
 * per tick — fire spreads deterministically to every eligible neighbour.
 * This matches the plan's "fire spreads to adjacent life/nutrient" design.
 *
 * The caller is responsible for:
 *   - Providing the neighbour index buffer (no allocation here).
 *   - Writing the result to `bkType` and `bkEnergy`.
 *
 * @param nLen - Number of valid entries in `neighborBuf`.
 * @param neighborBuf - Pre-filled flat neighbour-index array.
 * @param ftType - Front cell-type array (read-only).
 * @param bkType - Back cell-type array (written).
 * @param bkEnergy - Back energy array (written).
 */
export function spreadFire(
  nLen: number,
  neighborBuf: Int32Array,
  ftType: Uint8Array,
  bkType: Uint8Array,
  bkEnergy: Float32Array,
): void {
  for (let k = 0; k < nLen; k++) {
    const ni    = neighborBuf[k];
    const nType = ftType[ni];

    // Fire spreads into Life, LifeVariant, and Nutrient cells.
    if (
      nType === CellType.Life     ||
      nType === CellType.LifeVariant ||
      nType === CellType.Nutrient
    ) {
      // Convert the neighbour to a fresh, fully-fuelled Fire cell.
      bkType[ni]   = CellType.Fire;
      bkEnergy[ni] = 1.0;
    }
  }
}
