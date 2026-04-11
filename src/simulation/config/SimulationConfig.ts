/**
 * @fileoverview Simulation configuration — the single source of truth for all
 * tuneable parameters.
 *
 * The `SimulationConfig` object is intentionally a plain record (no class, no
 * getters) so it can be serialised to JSON, sent across a Worker boundary via
 * `postMessage`, and mutated in-place when sliders change.
 *
 * All parameters have sensible defaults that produce an interesting visible
 * spread from a 30%-density random seed at 256×256.
 */

// ---------------------------------------------------------------------------
// Neighbourhood mode
// ---------------------------------------------------------------------------

/**
 * Which cells are considered "neighbours" when a Life cell tries to spread.
 *
 *  - `moore`      — 8 neighbours (N, NE, E, SE, S, SW, W, NW).  Produces
 *                   faster diagonal spread and more circular blobs.
 *  - `vonNeumann` — 4 neighbours (N, E, S, W).  Produces cross-shaped spread
 *                   and rectilinear boundaries.
 */
export type NeighbourhoodMode = 'moore' | 'vonNeumann';

// ---------------------------------------------------------------------------
// SimulationConfig
// ---------------------------------------------------------------------------

/**
 * All tuneable parameters for one simulation run.
 * Every field is mutable; changes take effect on the next tick.
 */
export interface SimulationConfig {
  // --- Core life parameters -----------------------------------------------

  /**
   * Probability [0, 1] that a Life cell attempts to spread into each empty
   * eligible neighbour per tick.  Higher → faster expansion.
   */
  spreadRate: number;

  /**
   * Energy lost per tick per Life cell (metabolic cost).
   * If a cell's energy drops to 0 it dies.
   * Range: [0, 1].
   */
  energyDecayRate: number;

  /**
   * Minimum energy a cell must have before it is allowed to spread.
   * Prevents dying cells from reproducing.
   * Range: [0, 1].
   */
  reproductionThreshold: number;

  /**
   * Starting energy assigned to every newly born Life cell.
   * Range: [0, 1].
   */
  initialEnergy: number;

  /**
   * Probability [0, 0.1] that a Life cell mutates into a LifeVariant per tick.
   * 0 disables mutation entirely.
   */
  mutationRate: number;

  /**
   * Which neighbour topology to use for spread.
   * Changing this at runtime takes effect immediately.
   */
  neighbourhoodMode: NeighbourhoodMode;

  /**
   * Maximum number of living neighbours before a cell dies from
   * overpopulation (Conway-style pressure).  8 = disabled.
   */
  overpopulationLimit: number;

  /**
   * Minimum number of living neighbours required for a cell to survive.
   * 0 = disabled.
   */
  underpopulationLimit: number;

  // --- Environmental sensitivity ------------------------------------------

  /**
   * Multiplier [0, 1] reducing damage from Toxin cells.
   * 0 = full damage; 1 = immune.
   */
  toxinResistance: number;

  /**
   * Multiplier [0, 1] scaling energy gained on Nutrient cells.
   * 0 = no benefit; 1 = full benefit.
   */
  nutrientAbsorption: number;

  /**
   * Sensitivity [0, 1] to GravityWell directional bias.
   * 0 = life ignores wells; 1 = maximum pull.
   */
  gravityResponse: number;

  // --- Obstacle parameters (Phase 2+, present here for completeness) -------

  /** Energy damage per tick dealt by Toxin cells. */
  toxinStrength: number;

  /** Number of Life kills before a Toxin cell is consumed. */
  toxinDurability: number;

  /** Energy gain per tick on Nutrient cells. */
  nutrientBoost: number;

  /** Rate at which Nutrient cells deplete. */
  nutrientDecayRate: number;

  /** Ticks before a Barrier cell crumbles to Empty. */
  barrierLifetime: number;

  /** Pull force magnitude of GravityWell cells. */
  gravityStrength: number;

  /** Energy loss per tick for Life cells adjacent to Drain cells. */
  drainRate: number;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/**
 * Returns a fresh `SimulationConfig` with sensible defaults.
 *
 * A new object is returned each call so callers can safely mutate it without
 * polluting a shared constant.
 *
 * @returns Default simulation configuration.
 */
export function defaultConfig(): SimulationConfig {
  return {
    // Core life
    spreadRate:           0.45,
    energyDecayRate:      0.005,
    reproductionThreshold: 0.1,
    initialEnergy:        0.9,
    mutationRate:         0.0,   // mutation off in Phase 1
    neighbourhoodMode:    'moore',
    overpopulationLimit:  8,     // disabled (value > possible neighbours)
    underpopulationLimit: 0,     // disabled

    // Environmental sensitivity
    toxinResistance:    0.0,
    nutrientAbsorption: 1.0,
    gravityResponse:    1.0,

    // Obstacle params (Phase 2+ but wired in from the start)
    toxinStrength:     0.05,
    toxinDurability:   10,
    nutrientBoost:     0.02,
    nutrientDecayRate: 0.001,
    barrierLifetime:   200,
    gravityStrength:   0.5,
    drainRate:         0.01,
  };
}

// ---------------------------------------------------------------------------
// Preset configs
// ---------------------------------------------------------------------------

/**
 * Named preset configurations.  Each preset returns a full `SimulationConfig`
 * so it can be applied by replacing the current config wholesale.
 */
export const Presets = {
  /**
   * Slow, careful spread — life clings on but barely expands.
   * Good for watching sparse clusters stabilise.
   */
  slowBurn(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:      0.15,
      energyDecayRate: 0.02,
      initialEnergy:   0.6,
    };
  },

  /**
   * Aggressive spread — life floods the board in seconds.
   */
  plague(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:           0.9,
      energyDecayRate:      0.001,
      reproductionThreshold: 0.05,
      initialEnergy:        1.0,
    };
  },

  /**
   * Mimics classic Conway's Game of Life rules as closely as possible using
   * the energy model (energy decay is set to near-zero so cells survive
   * indefinitely; over/under-population thresholds do the culling).
   */
  classicGameOfLife(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:           1.0,
      energyDecayRate:      0.0001,
      reproductionThreshold: 0.01,
      initialEnergy:        1.0,
      overpopulationLimit:  3,  // dies with > 3 neighbours
      underpopulationLimit: 2,  // dies with < 2 neighbours
      neighbourhoodMode:    'moore',
    };
  },
} as const;
