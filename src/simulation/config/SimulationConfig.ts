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
   *
   * @deprecated Phase 9 onwards: Use `pointMutationRate` for per-bit genome
   *   mutation.  This field still controls the legacy Life→LifeVariant
   *   transformation (Round 1 behaviour, kept for backwards compat).
   */
  mutationRate: number;

  /**
   * Round 2: probability [0, 0.05] that a random bit in a child cell's
   * genome is flipped on each reproduction event (spread).
   *
   * Default 0.002 — approximately 0.2% of spreads produce a one-bit
   * genome change, giving visible evolution over ~500 ticks in a 512×512
   * grid.  Set to 0 to disable genome mutation entirely.
   */
  pointMutationRate: number;

  // --- Phase 10: Lifecycle stages -------------------------------------------

  /**
   * Age (in ticks) below which a Life cell is in the **juvenile** stage.
   *
   * Juvenile behaviour modifiers:
   *   - Effective spread rate × 0.4   (slow expansion — still establishing)
   *   - Effective energy decay  × 0.8 (reduced metabolic cost)
   *   - Point mutation rate     = 0   (juvenile cells cannot mutate)
   *
   * Range: [0, 200].  Default: 30 ticks.
   */
  juvenileThreshold: number;

  /**
   * Age (in ticks) above which a Life cell enters the **senescent** stage.
   *
   * Senescent behaviour modifiers:
   *   - Effective spread rate × 0.1   (minimal expansion — near end of life)
   *   - Effective energy decay  × 1.5 (elevated metabolic cost)
   *   - Point mutation rate     × 2   (last-ditch diversity burst: SOS response)
   *
   * A senescent cell whose energy drops below 0.05 undergoes **apoptosis**
   * (planned death): it emits a signal burst, feeds adjacent live cells, then
   * becomes Empty.
   *
   * Range: [100, 2000].  Default: 400 ticks.
   */
  senescentThreshold: number;

  /**
   * Energy bonus [0, 0.1] added to every live neighbour cell when a senescent
   * cell undergoes apoptosis.
   *
   * Simulates the biological recycling of cellular material — the death of an
   * old dense cell feeds surrounding younger cells, driving the colony's
   * expansion frontier outward after the interior collapses.
   *
   * Default: 0.02 (2% energy per neighbour).
   */
  apoptosisBoost: number;

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

  // --- Life Variant B parameters (Phase 3) --------------------------------

  /**
   * Spread probability [0, 1] used by LifeVariant cells instead of
   * `spreadRate`.  Allows Variant B to evolve a different expansion speed.
   */
  variantSpreadRate: number;

  /**
   * Energy lost per tick for LifeVariant cells.
   * Independent of `energyDecayRate` so variants can have a different
   * metabolic cost to regular Life.
   * Range: [0, 1].
   */
  variantEnergyDecayRate: number;

  /**
   * Minimum energy a LifeVariant cell must have before it can spread.
   * Range: [0, 1].
   */
  variantReproductionThreshold: number;

  /**
   * Starting energy assigned to newly born LifeVariant cells.
   * Range: [0, 1].
   */
  variantInitialEnergy: number;

  /**
   * Probability [0, 1] that a LifeVariant cell spreads into (and kills) an
   * adjacent regular Life cell in one tick.  0 = no competition;
   * 1 = guaranteed hostile takeover every tick.
   */
  competitionStrength: number;

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

  /**
   * Energy (fuel) consumed by a Fire cell per tick.
   * Fresh fire starts at energy = 1.0; it burns out when energy reaches 0.
   * Range: (0, 1].  Lower values = longer-burning fire.
   */
  fireBurnRate: number;

  // --- Phase 11: Population genetics census --------------------------------

  /**
   * Number of simulation ticks between each population census broadcast.
   *
   * Every `censusInterval` ticks, the SimulationWorker scans all live cells,
   * builds a {@link VariantCensus} snapshot (counts, mean genome, mean age,
   * mean generation per variant), and posts it to the main thread.
   *
   * Lower values give finer-grained charts but add a small scan overhead.
   * Range: [1, 50].  Default: 10.
   */
  censusInterval: number;

  // --- Phase 12: Genome-aware obstacle parameters --------------------------

  /**
   * Multiplier applied to `pointMutationRate` for Life cells adjacent to a
   * **Mutagen** cell.  A value of 3 means adjacent cells mutate 3× faster.
   *
   * Mutagen cells deplete over time (`mutagenDecayRate` per tick) and become
   * Empty when their energy reaches 0.  Life spreading into a Mutagen cell
   * consumes it and inherits the boosted mutation pressure.
   *
   * Range: [1, 10].  Default: 3.
   */
  mutagenBoost: number;

  /**
   * Energy lost per tick by a Mutagen cell (depletion rate).
   * Lower = longer-lasting mutagen; 0 = permanent (not recommended).
   *
   * Range: [0, 0.01].  Default: 0.002.
   */
  mutagenDecayRate: number;

  /**
   * Energy damage dealt per tick to Life cells adjacent to a **RadioWaste** cell.
   * RadioWaste is permanent and never depletes — it acts as a constant radiation
   * source that also applies random genome bit flips to adjacent Life cells.
   *
   * Cells with high `toxinResist` phenotype take proportionally less damage.
   * Range: [0, 0.05].  Default: 0.008.
   */
  radioWasteDamage: number;

  /**
   * Per-tick probability [0, 1] that an **Antibiotic** cell kills each adjacent
   * Life cell.  The kill chance is reduced by the cell's `toxinResist` phenotype:
   *   effective = antibioticStrength × (1 − toxinResist)
   *
   * Antibiotic cells deplete over time (`antibioticDecayRate` per tick) and
   * become Empty when their energy reaches 0.
   *
   * Range: [0, 1].  Default: 0.12.
   */
  antibioticStrength: number;

  /**
   * Energy lost per tick by an Antibiotic cell (depletion rate).
   * Each successful Life-kill also accelerates depletion by 0.05.
   *
   * Range: [0, 0.01].  Default: 0.001.
   */
  antibioticDecayRate: number;

  /**
   * Rate [0, 1] at which **Rewinder** cells nudge adjacent Life cell genomes
   * toward the neutral baseline (0x7777) per tick.
   *
   * Each genome nibble is shifted one step toward tier 7 (neutral) for each
   * tick the cell is adjacent to a Rewinder.  Higher = faster genome reset.
   * Rewinder cells are permanent and never deplete.
   *
   * Range: [0, 1].  Default: 0.05 (5% nudge-probability per nibble per tick).
   */
  rewinderStrength: number;

  /**
   * Energy provided per tick to each Life cell adjacent to a **Colony** cell.
   *
   * Colony cells act as cooperative infrastructure — they boost adjacent Life
   * energy and emit a chemical signal pulse that further aids nearby cells.
   * Colony cells have their own energy that drains slowly over time; they
   * survive indefinitely unless they run out of energy.
   *
   * Range: [0, 0.05].  Default: 0.012.
   */
  colonyBoost: number;

  // --- Phase 15: Evolution behaviour parameters ----------------------------

  /**
   * When `true`, applies Lamarckian-lite directed mutation bias: genome bit
   * flips that improve local fitness (e.g. higher toxinResist when adjacent to
   * Toxin) are 3× more likely than neutral flips.
   *
   * Off by default — turning it on makes evolution dramatically more visible
   * on short timescales by biasing random variation toward environmental fit.
   */
  adaptiveMutationBias: boolean;

  /**
   * Weight [0, 1] of the nutrient signal gradient on spread target selection.
   *
   * Life cells with high `nutrientAbs` phenotype bias their spread toward
   * higher-signal neighbours (nutrient-rich targets) when this is above 0.
   * 0 = uniform spread; 1 = maximum gradient-following (chemotaxis).
   *
   * Range: [0, 1].  Default: 0.3.
   */
  chemotaxisWeight: number;

  /**
   * Retention factor [0, 1] applied to the `signalStrength` buffer each tick.
   *
   * 0.85 means 85% of signal remains after one tick — signal propagates
   * roughly 1 / (1 - 0.85) = 6–7 cells from a colony or nutrient source.
   * Lower values (e.g. 0.5) give very short-range signals; higher values
   * allow gradients to span the whole canvas.
   *
   * Range: [0, 1].  Default: 0.85.
   */
  signalDiffusion: number;

  /**
   * Number of same-variant neighbours [1, 8] required for a Life cell to
   * enter **Colony mode** (conserved energy, reduced spread, defended territory).
   * Cells below this threshold are in **Pioneer mode** (aggressive expansion).
   *
   * Higher values require denser colonies before the mode switch; lower values
   * make almost every cell a colonist, reducing frontier expansion speed.
   *
   * Range: [1, 8].  Default: 4.
   */
  quorumThreshold: number;

  /**
   * Probability [0, 1] that a stress-adaptation (toxin survival → toxin tier
   * increment) is inherited by the child cell during reproduction.
   *
   * Implements simplified Lamarckian-lite inheritance: cells that survive
   * hostile environments pass their acquired resistance to offspring.
   * 0 = pure Darwinian selection; 1 = full Lamarckian inheritance.
   *
   * Range: [0, 1].  Default: 0.3.
   */
  adaptiveInheritanceRate: number;
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
    mutationRate:         0.0,   // legacy Life→LifeVariant mutation off by default
    pointMutationRate:    0.005, // Round 2: per-bit genome mutation (0.5% per spread)

    // Phase 10: lifecycle stage thresholds
    juvenileThreshold:    30,    // ticks before a cell reaches maturity
    senescentThreshold:   400,   // ticks before a cell enters senescence
    apoptosisBoost:       0.02,  // energy fed to neighbours on apoptosis death

    neighbourhoodMode:    'moore',
    overpopulationLimit:  8,     // disabled (value > possible neighbours)
    underpopulationLimit: 0,     // disabled

    // Life Variant B (Phase 3) — slightly more aggressive than base Life
    variantSpreadRate:             0.6,
    variantEnergyDecayRate:        0.008,
    variantReproductionThreshold:  0.1,
    variantInitialEnergy:          0.8,
    competitionStrength:           0.3,

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
    fireBurnRate:      0.005,

    // Phase 11: census broadcast interval
    censusInterval:    10,

    // Phase 12: genome-aware obstacle parameters
    mutagenBoost:        3.0,   // mutation rate multiplier near Mutagen
    mutagenDecayRate:    0.002, // energy lost per tick by Mutagen cells
    radioWasteDamage:    0.008, // energy damage/tick from adjacent RadioWaste
    antibioticStrength:  0.12,  // kill probability per tick for adjacent Life
    antibioticDecayRate: 0.001, // energy lost per tick by Antibiotic cells
    rewinderStrength:    0.05,  // genome-nibble nudge probability per tick
    colonyBoost:         0.012, // energy provided to adjacent Life per tick

    // Phase 15: evolution behaviour parameters
    adaptiveMutationBias:    false, // Lamarckian-lite directed mutation off by default
    chemotaxisWeight:        0.3,   // nutrient-gradient bias on spread target selection
    signalDiffusion:         0.85,  // signal retention factor per tick (85% remains)
    quorumThreshold:         4,     // same-variant neighbours needed for colony mode
    adaptiveInheritanceRate: 0.3,   // probability stress-adaptation is inherited
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

  /**
   * Balanced ecosystem — life grows at a moderate pace, mutations produce a
   * competing Variant B, and the obstacle parameters are tuned so nutrients,
   * toxins, and drains all play a meaningful role.  Good starting point for
   * exploring all obstacle types together.
   */
  ecosystemBalance(): SimulationConfig {
    return {
      ...defaultConfig(),
      // Moderate spread — neither floods nor dies out quickly.
      spreadRate:           0.35,
      energyDecayRate:      0.004,
      reproductionThreshold: 0.15,
      initialEnergy:        0.85,

      // Mutation enabled — Variant B appears after several hundred ticks.
      mutationRate:         0.002,
      variantSpreadRate:    0.4,
      variantEnergyDecayRate: 0.006,
      competitionStrength:  0.2,

      // Partial toxin resistance and strong nutrient absorption create
      // interesting hotspots on mixed terrain.
      toxinResistance:    0.3,
      nutrientAbsorption: 1.0,
      gravityResponse:    0.8,

      // Obstacle tuning — balanced intensity so each obstacle type is visible.
      toxinStrength:     0.04,
      toxinDurability:   15,
      nutrientBoost:     0.015,
      nutrientDecayRate: 0.0005,
      drainRate:         0.008,
      gravityStrength:   0.6,
      barrierLifetime:   300,
      fireBurnRate:      0.004,
    };
  },

  // --- Phase 15: Round 2 evolution presets ---------------------------------

  /**
   * Natural Selection — high mutation, antibiotic-resistant strains emerge.
   *
   * Paint an Antibiotic band across the grid midline after loading, then watch
   * the population on the far side evolve resistance over ~300 ticks.
   * Adaptive mutation bias is enabled so fitness-improving mutations are
   * preferentially retained.
   */
  naturalSelection(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:              0.40,
      energyDecayRate:         0.003,
      pointMutationRate:       0.008,
      adaptiveMutationBias:    true,
      juvenileThreshold:       25,
      senescentThreshold:      350,
      apoptosisBoost:          0.025,
      chemotaxisWeight:        0.5,
      signalDiffusion:         0.90,
      quorumThreshold:         3,
      adaptiveInheritanceRate: 0.4,
      antibioticStrength:      0.18,
      antibioticDecayRate:     0.0005, // slow depletion — pressure lasts longer
    };
  },

  /**
   * Coevolution — two competing variants locked in an evolutionary arms race.
   *
   * Starts with high competition and kin selection; distinct lineages form
   * territorial boundaries within ~500 ticks.  Variants with higher spread
   * tiers dominate open space; toxin-resistant strains win near toxin patches.
   */
  coevolution(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:              0.50,
      energyDecayRate:         0.004,
      pointMutationRate:       0.006,
      competitionStrength:     0.5,
      variantSpreadRate:       0.55,
      variantEnergyDecayRate:  0.005,
      senescentThreshold:      300,
      apoptosisBoost:          0.03,
      quorumThreshold:         2,   // colony mode kicks in early
      signalDiffusion:         0.88,
      censusInterval:          5,   // finer-grained chart updates
    };
  },

  /**
   * Mutagenic Chaos — maximum genome diversity, minimal selective pressure.
   *
   * The entire grid is bathed in Mutagen-equivalent mutation pressure.
   * Genome entropy stays near maximum — no single lineage can consolidate.
   * Useful for observing pure genetic drift without directional selection.
   */
  mutagenicChaos(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:              0.45,
      energyDecayRate:         0.003,
      pointMutationRate:       0.035, // very high: ~3.5% per reproduction
      adaptiveMutationBias:    false, // pure random drift — no directed bias
      mutagenBoost:            8.0,
      mutagenDecayRate:        0.0005, // mutagen lasts longer
      juvenileThreshold:       10,
      senescentThreshold:      200,
      censusInterval:          5,
    };
  },

  /**
   * Stable Colony — quorum dominates, low mutation, dense cooperative clusters.
   *
   * Life quickly saturates available space and locks into colony mode.
   * Minimal mutation means the population is nearly homogenous — one or two
   * dominant variants hold territory indefinitely.  Colony cells scattered on
   * the grid provide permanent energy hubs that anchor territorial boundaries.
   */
  stableColony(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:              0.30,
      energyDecayRate:         0.002,
      pointMutationRate:       0.001, // very low — minimal divergence
      quorumThreshold:         3,     // colony mode at just 3 neighbours
      colonyBoost:             0.025, // strong cooperative energy bonus
      signalDiffusion:         0.92,  // wide-ranging signal field
      apoptosisBoost:          0.04,  // recycled nutrients sustain interior colonies
      senescentThreshold:      600,   // long lifespan — stable, slow-cycling colonies
    };
  },

  /**
   * Radiation Wasteland — only highly resistant genomes survive long term.
   *
   * The entire grid is periodically blasted by RadioWaste-equivalent damage.
   * Populations with low toxin-resist tiers die out within 200 ticks; only
   * strains that evolve high toxinResist phenotypes persist.  Strong selection
   * pressure makes resistance evolution observable in real time.
   */
  radiationWasteland(): SimulationConfig {
    return {
      ...defaultConfig(),
      spreadRate:              0.55,
      energyDecayRate:         0.006,
      pointMutationRate:       0.012, // elevated to ensure resistance can evolve
      adaptiveMutationBias:    true,  // bias toward resistance mutations
      adaptiveInheritanceRate: 0.5,   // strong inheritance of resistance
      radioWasteDamage:        0.025, // high radiation damage per tick
      mutagenBoost:            5.0,   // radiation also mutagenises survivors
      senescentThreshold:      250,   // short lifespans — fast generational turnover
      juvenileThreshold:       15,
    };
  },
} as const;
