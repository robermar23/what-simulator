/**
 * @fileoverview Obstacle interaction rules for the What Simulator.
 *
 * Pure, side-effect-free helper functions used by {@link SimulationEngine}
 * to compute the energy effects that environmental obstacle cells have on
 * adjacent or entering Life cells.
 *
 * Wall blocking is handled directly in SimulationEngine._trySpread by
 * checking the cell type before allowing spread — no separate function is
 * needed for walls.
 *
 * Design contract: these functions must not allocate objects, mutate buffers,
 * or access the DOM.  The hot-path caller (SimulationEngine) combines these
 * checks into a single neighbour-scan loop for maximum cache efficiency —
 * these helpers exist primarily for unit-testing and documentation clarity.
 *
 * ## Phase 2 obstacle rules
 *   - Wall:     Impassable — Life cannot spread into Wall cells.
 *   - Toxin:    Passable — damages adjacent Life each tick; Life spreading in
 *               starts with reduced energy.  Toxin is static (no depletion).
 *   - Nutrient: Passable — boosts adjacent Life energy each tick and depletes
 *               over time; Life spreading into Nutrient starts with a boost.
 *
 * ## Phase 5 obstacle rules (additions)
 *   - Drain:      Impassable. Reduces energy of adjacent Life cells each tick.
 *                 Also halves their spread probability (handled in engine).
 *   - GravityWell: Impassable. Creates a directional spread bias toward the
 *                 well center.  Energy effects handled in engine.
 *   - Barrier:    Impassable until it decays (age ≥ barrierLifetime).
 *   - Fire:       Impassable. Kills adjacent Life on contact; can spread to
 *                 adjacent Life/Nutrient cells; burns down over time.
 *   - Ice:        Impassable. Makes adjacent Life cells dormant (no spread/death).
 */

import { CellType } from '../GridState.js';

// ---------------------------------------------------------------------------
// Adjacency energy effects (applied to a Life cell each tick)
// ---------------------------------------------------------------------------

/**
 * Calculates the energy damage a Life cell takes from adjacent Toxin cells.
 *
 * Only the first found Toxin neighbour contributes per tick in Phase 2 —
 * multiple adjacent Toxins do not stack (Phase 5 may revise this).
 *
 * @param neighborBuf - Pre-filled flat neighbour-index buffer.
 * @param nLen - Number of valid entries in `neighborBuf`.
 * @param frontCellType - Front-buffer cell-type array (read-only).
 * @param toxinStrength - Base energy damage per tick from one Toxin cell.
 * @param toxinResistance - Life's damage resistance multiplier [0, 1].
 *   0 = no resistance (full damage); 1 = immune (zero damage).
 * @returns Negative energy delta to subtract from the Life cell's energy.
 *   Returns 0 if no adjacent Toxin cell is found.
 */
export function calcToxinDamage(
  neighborBuf: Int32Array,
  nLen: number,
  frontCellType: Uint8Array,
  toxinStrength: number,
  toxinResistance: number,
): number {
  for (let k = 0; k < nLen; k++) {
    if (frontCellType[neighborBuf[k]] === CellType.Toxin) {
      // Damage is reduced by resistance: 0 resistance = full hit, 1 = immune.
      return -(toxinStrength * (1 - toxinResistance));
    }
  }
  return 0;
}

/**
 * Calculates the energy bonus a Life cell gains from adjacent Nutrient cells.
 *
 * Only the first found Nutrient neighbour contributes per tick in Phase 2.
 *
 * @param neighborBuf - Pre-filled flat neighbour-index buffer.
 * @param nLen - Number of valid entries in `neighborBuf`.
 * @param frontCellType - Front-buffer cell-type array (read-only).
 * @param nutrientBoost - Base energy gain per tick from one Nutrient cell.
 * @param nutrientAbsorption - Life's absorption efficiency multiplier [0, 1].
 *   0 = no benefit; 1 = full benefit.
 * @returns Positive energy delta to add to the Life cell's energy.
 *   Returns 0 if no adjacent Nutrient cell is found.
 */
export function calcNutrientBoost(
  neighborBuf: Int32Array,
  nLen: number,
  frontCellType: Uint8Array,
  nutrientBoost: number,
  nutrientAbsorption: number,
): number {
  for (let k = 0; k < nLen; k++) {
    if (frontCellType[neighborBuf[k]] === CellType.Nutrient) {
      return nutrientBoost * nutrientAbsorption;
    }
  }
  return 0;
}

/**
 * Determines whether a Life cell adjacent to a Drain cell is affected.
 *
 * Returns `true` if any neighbour of the Life cell is a Drain cell.
 * The engine subtracts `drainRate` from energy and halves the spread
 * probability when this returns `true`.
 *
 * Phase 5 note: Like Toxin, only the first adjacent Drain contributes per
 * tick (stacking is not implemented).
 *
 * @param neighborBuf - Pre-filled flat neighbour-index buffer.
 * @param nLen - Number of valid entries in `neighborBuf`.
 * @param frontCellType - Front-buffer cell-type array (read-only).
 * @returns True if at least one adjacent neighbour is a Drain cell.
 */
export function hasAdjacentDrain(
  neighborBuf: Int32Array,
  nLen: number,
  frontCellType: Uint8Array,
): boolean {
  for (let k = 0; k < nLen; k++) {
    if (frontCellType[neighborBuf[k]] === CellType.Drain) return true;
  }
  return false;
}

/**
 * Determines whether a Life cell adjacent to an Ice cell is dormant.
 *
 * Returns `true` if any neighbour is an Ice cell.  Dormant Life cells:
 *   - Do not decay (no energy loss).
 *   - Do not spread.
 *   - Cannot die (no death checks).
 *
 * @param neighborBuf - Pre-filled flat neighbour-index buffer.
 * @param nLen - Number of valid entries in `neighborBuf`.
 * @param frontCellType - Front-buffer cell-type array (read-only).
 * @returns True if at least one adjacent neighbour is an Ice cell.
 */
export function hasAdjacentIce(
  neighborBuf: Int32Array,
  nLen: number,
  frontCellType: Uint8Array,
): boolean {
  for (let k = 0; k < nLen; k++) {
    if (frontCellType[neighborBuf[k]] === CellType.Ice) return true;
  }
  return false;
}

/**
 * Determines whether a Life cell is adjacent to a Fire cell.
 *
 * Fire kills adjacent Life on contact — the engine marks affected Life cells
 * as dead when this returns `true`.
 *
 * @param neighborBuf - Pre-filled flat neighbour-index buffer.
 * @param nLen - Number of valid entries in `neighborBuf`.
 * @param frontCellType - Front-buffer cell-type array (read-only).
 * @returns True if at least one adjacent neighbour is a Fire cell.
 */
export function hasAdjacentFire(
  neighborBuf: Int32Array,
  nLen: number,
  frontCellType: Uint8Array,
): boolean {
  for (let k = 0; k < nLen; k++) {
    if (frontCellType[neighborBuf[k]] === CellType.Fire) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GravityWell directional spread bias
// ---------------------------------------------------------------------------

/**
 * Computes a directional spread weight modifier toward a single GravityWell
 * cell for a candidate spread target.
 *
 * The weight falls off as inverse-square of the Euclidean distance between
 * the well center and the candidate neighbour cell.  Close cells get a strong
 * pull; distant cells get a weak pull.
 *
 * The result is added to the base spread probability for the candidate target,
 * clamped to [0, 1] by the caller before random sampling.
 *
 * @param wellX - Grid X of the GravityWell cell.
 * @param wellY - Grid Y of the GravityWell cell.
 * @param targetX - Grid X of the candidate spread-target cell.
 * @param targetY - Grid Y of the candidate spread-target cell.
 * @param gravityStrength - Pull-force magnitude configured in SimulationConfig.
 * @param gravityResponse - Life's sensitivity to the pull [0, 1].
 *   0 = ignores wells; 1 = full effect.
 * @returns Positive spread-probability bonus [0, gravityStrength].
 */
export function calcGravityBias(
  wellX: number,
  wellY: number,
  targetX: number,
  targetY: number,
  gravityStrength: number,
  gravityResponse: number,
): number {
  const dx   = targetX - wellX;
  const dy   = targetY - wellY;
  const dist2 = dx * dx + dy * dy;
  if (dist2 === 0) {
    // Target IS the well — maximum attraction.
    return gravityStrength * gravityResponse;
  }
  // Inverse-square falloff, capped at gravityStrength.
  return Math.min(gravityStrength * gravityResponse / dist2, gravityStrength);
}

// ---------------------------------------------------------------------------
// Spread-target evaluation
// ---------------------------------------------------------------------------

/**
 * Returns `true` if a Life cell may spread into a cell of `targetCellType`.
 *
 * Enterable types (Phase 2): Empty, Toxin, Nutrient (all passable).
 * All Phase 5 obstacles are impassable (Wall, Drain, GravityWell, Barrier,
 * Fire, Ice all block spread).
 *
 * @param targetCellType - The CellType value of the spread-target cell.
 * @returns Whether Life can legally spread into that cell type.
 */
export function isEnterable(targetCellType: number): boolean {
  return (
    targetCellType === CellType.Empty    ||
    targetCellType === CellType.Toxin    ||
    targetCellType === CellType.Nutrient
  );
}

/**
 * Calculates the starting energy for a Life cell spreading into a target cell.
 *
 * The target cell type modifies the initial energy:
 *   - Empty    → base `initialEnergy` (no modification)
 *   - Toxin    → `initialEnergy` minus toxin entry damage
 *   - Nutrient → `initialEnergy` plus nutrient entry boost
 *
 * Result is clamped to [0.01, 1.0] so a cell born into harsh conditions
 * gets at least one tick before it may die.
 *
 * @param targetCellType - CellType of the cell being entered.
 * @param initialEnergy - Base energy for newly born Life cells.
 * @param toxinStrength - Energy damage when entering a Toxin cell.
 * @param toxinResistance - Resistance multiplier reducing Toxin entry damage.
 * @param nutrientBoost - Energy gain when entering a Nutrient cell.
 * @param nutrientAbsorption - Absorption multiplier scaling Nutrient gain.
 * @returns Starting energy for the new Life cell, clamped to [0.01, 1.0].
 */
export function calcSpreadEnergy(
  targetCellType: number,
  initialEnergy: number,
  toxinStrength: number,
  toxinResistance: number,
  nutrientBoost: number,
  nutrientAbsorption: number,
): number {
  let energy = initialEnergy;

  if (targetCellType === CellType.Toxin) {
    // Entry damage: same formula as per-tick adjacency damage.
    energy -= toxinStrength * (1 - toxinResistance);
  } else if (targetCellType === CellType.Nutrient) {
    // Entry boost: same formula as per-tick adjacency boost.
    energy += nutrientBoost * nutrientAbsorption;
  }

  // Clamp: never spawn below 0.01 (survival grace tick) or above 1.0.
  return Math.max(0.01, Math.min(1.0, energy));
}
