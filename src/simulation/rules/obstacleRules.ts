/**
 * @fileoverview Obstacle interaction rules for the What Simulator.
 *
 * Pure, side-effect-free helper functions used by {@link SimulationEngine}
 * to compute the energy effects that environmental obstacle cells (Toxin,
 * Nutrient) have on adjacent or entering Life cells.
 *
 * Wall blocking is handled directly in SimulationEngine._trySpread by
 * checking the cell type before allowing spread — no separate function is
 * needed.
 *
 * Design contract: these functions must not allocate objects, mutate buffers,
 * or access the DOM.  The hot-path caller (SimulationEngine) combines these
 * checks into a single neighbour-scan loop for maximum cache efficiency —
 * these helpers exist primarily for unit-testing and documentation clarity.
 *
 * Phase 2 obstacle rules in play:
 *   - Wall:     Impassable — Life cannot spread into Wall cells.
 *   - Toxin:    Passable — damages adjacent Life each tick; Life spreading in
 *               starts with reduced energy.  Toxin is static (no depletion).
 *   - Nutrient: Passable — boosts adjacent Life energy each tick and depletes
 *               over time; Life spreading into Nutrient starts with a boost.
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

// ---------------------------------------------------------------------------
// Spread-target evaluation
// ---------------------------------------------------------------------------

/**
 * Returns `true` if a Life cell may spread into a cell of `targetCellType`.
 *
 * Enterable types: Empty, Toxin, Nutrient (all passable environmental cells).
 * Non-enterable: Wall (impassable), Life, LifeVariant (already occupied).
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
