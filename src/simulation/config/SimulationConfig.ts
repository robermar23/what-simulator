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

  // --- Phase 19: Motility & Chemotaxis -------------------------------------

  /**
   * Probability [0, 1] per tick that a motile Life cell (spreadBonus above
   * `motilityThreshold`) attempts to migrate one cell in its velocity direction.
   *
   * 0.0 disables motility entirely (default — preserves pre-Phase 19 behaviour).
   * Higher values allow more frequent movement; set to 1.0 for near-constant
   * migration of all motile cells.
   *
   * Range: [0, 1].  Default: 0.0 (disabled).
   */
  motilityRate: number;

  /**
   * Minimum `spreadBonus` phenotype value required for a Life cell to be
   * considered motile (eligible for migration).
   *
   * Cells whose `spreadBonus` is at or below this threshold are sessile
   * (stationary) regardless of `motilityRate`.  Raise this value to make
   * motility an evolutionarily rare trait; lower it to allow all cells to move.
   *
   * Range: [0, 1].  Default: 0.3.
   */
  motilityThreshold: number;

  /**
   * Fraction of velocity removed per tick via fluid drag / cytoskeletal reset.
   *
   * Applied before chemotaxis so cells naturally decelerate if they stop
   * receiving a chemical signal or bounce off walls.
   *
   * 0.0 = no damping (velocity persists forever — ballistic motion).
   * 1.0 = full damping (velocity zeroed each tick — no persistence).
   *
   * Range: [0, 1].  Default: 0.2.
   */
  motilityDamping: number;

  /**
   * Fraction of the updated velocity derived from the chemical (signal)
   * gradient versus the persisted momentum vector.
   *
   * At 0.0 the cell is purely inertial — chemical bias has no effect.
   * At 1.0 the cell ignores prior momentum and points entirely toward the
   * gradient peak each tick.
   *
   * Range: [0, 1].  Default: 0.5.
   */
  chemotaxisMotilityFraction: number;
}

// ---------------------------------------------------------------------------
// Preset metadata & LifePreset bundle type
// ---------------------------------------------------------------------------

/**
 * Display metadata attached to every named life preset.
 * Drives the UI card (name, description, difficulty badge, archetype tag).
 */
export interface PresetMeta {
  /** Short display name shown in the UI card — max 28 characters. */
  readonly name: string;

  /**
   * One or two sentence description of the life strategy and what to observe.
   * Shown as a tooltip / expanded description in the preset panel.
   */
  readonly description: string;

  /**
   * Survival difficulty: 1 = very forgiving, 5 = frequently goes extinct.
   * Guides users toward appropriate challenge levels.
   */
  readonly difficulty: 1 | 2 | 3 | 4 | 5;

  /**
   * Biology-inspired archetype used to group presets in the UI.
   *  - `primitive`    — simple, slow, ancient life strategies
   *  - `aggressive`   — fast-spreading, burn-and-conquer strategies
   *  - `cooperative`  — quorum-driven, signal-coordinated colonies
   *  - `resilient`    — stress-tolerant, adaptive, survives hostile environments
   *  - `chaotic`      — high mutation, unpredictable, evolving rapidly
   */
  readonly archetype: 'primitive' | 'aggressive' | 'cooperative' | 'resilient' | 'chaotic';

  /**
   * Key of the recommended environment preset for this organism.
   * Used by the UI "Apply Recommended Environment" shortcut.
   * Must match a key in `ENVIRONMENT_PRESETS`.
   */
  readonly recommendedEnvironment: string;
}

/**
 * A fully-described named life preset: UI metadata + complete SimulationConfig.
 * Every field of SimulationConfig is explicitly set — no hidden defaults.
 */
export interface LifePreset {
  /** Stable camelCase key used for serialisation and EventBus references. */
  readonly key: string;
  /** UI metadata (name, description, difficulty, archetype). */
  readonly meta: PresetMeta;
  /** Complete simulation configuration for this organism. */
  readonly config: SimulationConfig;
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

    // Phase 19: motility disabled by default — preserves pre-Phase 19 behaviour
    motilityRate:               0.0,
    motilityThreshold:          0.3,
    motilityDamping:            0.2,
    chemotaxisMotilityFraction: 0.5,
  };
}

// ---------------------------------------------------------------------------
// Preset configs (legacy functional API — retained for backwards compat)
// ---------------------------------------------------------------------------

/**
 * Named preset factory functions.
 * Each returns a complete `SimulationConfig` that can be applied wholesale.
 * All fields are set explicitly so no parameter silently inherits the default.
 *
 * For UI use, prefer the {@link LIFE_PRESETS} array which bundles each preset
 * with display metadata.  These functions are kept so existing call sites
 * (`Presets.plague()`) continue to work without changes.
 */
export const Presets = {

  // -------------------------------------------------------------------------
  // Classic presets (fully-specified for Round 5)
  // -------------------------------------------------------------------------

  /**
   * Slow, careful spread — life clings on but barely expands.
   * Good for watching sparse clusters stabilise.
   */
  slowBurn(): SimulationConfig {
    return {
      spreadRate:                  0.15, // crawling expansion
      energyDecayRate:             0.02, // high metabolic cost — barely survives
      reproductionThreshold:       0.30, // needs substantial energy to reproduce
      initialEnergy:               0.60, // starts with limited reserves
      mutationRate:                0.0,  // legacy variant mutation off
      pointMutationRate:           0.002, // very rare genome change
      juvenileThreshold:           50,   // long juvenile phase
      senescentThreshold:          800,  // long-lived cells
      apoptosisBoost:              0.01, // minimal recycling signal
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,    // crowding death disabled
      underpopulationLimit:        0,    // isolation death disabled
      variantSpreadRate:           0.20, // variant equally slow
      variantEnergyDecayRate:      0.025,
      variantReproductionThreshold: 0.30,
      variantInitialEnergy:        0.55,
      competitionStrength:         0.1,  // minimal competition
      toxinResistance:             0.1,
      nutrientAbsorption:          0.8,
      gravityResponse:             0.5,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              15,
      mutagenBoost:                2.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.2,
      signalDiffusion:             0.75,
      quorumThreshold:             5,
      adaptiveInheritanceRate:     0.15,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /** Aggressive spread — life floods the board in seconds. */
  plague(): SimulationConfig {
    return {
      spreadRate:                  0.90, // near-maximum replication
      energyDecayRate:             0.001, // barely any decay — immortal-feeling
      reproductionThreshold:       0.05, // reproduces at near-death energy
      initialEnergy:               1.00,
      mutationRate:                0.0,
      pointMutationRate:           0.003,
      juvenileThreshold:           5,    // matures instantly
      senescentThreshold:          2000, // never senesces
      apoptosisBoost:              0.005,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.95,
      variantEnergyDecayRate:      0.001,
      variantReproductionThreshold: 0.05,
      variantInitialEnergy:        1.00,
      competitionStrength:         0.5,
      toxinResistance:             0.0,
      nutrientAbsorption:          1.0,
      gravityResponse:             1.0,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              5,
      mutagenBoost:                3.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.1,  // blind flood — no gradient following
      signalDiffusion:             0.80,
      quorumThreshold:             8,    // never enters colony mode
      adaptiveInheritanceRate:     0.1,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Mimics classic Conway's Game of Life rules using the energy model.
   * Energy decay is near-zero; over/under-population thresholds do the culling.
   */
  classicGameOfLife(): SimulationConfig {
    return {
      spreadRate:                  1.00,
      energyDecayRate:             0.0001, // near-zero — cells survive indefinitely
      reproductionThreshold:       0.01,
      initialEnergy:               1.00,
      mutationRate:                0.0,
      pointMutationRate:           0.0,   // no genome mutation — pure GoL rules
      juvenileThreshold:           0,     // no juvenile phase
      senescentThreshold:          9999,  // no senescence
      apoptosisBoost:              0.0,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         3,    // dies with > 3 neighbours
      underpopulationLimit:        2,    // dies with < 2 neighbours
      variantSpreadRate:           1.00,
      variantEnergyDecayRate:      0.0001,
      variantReproductionThreshold: 0.01,
      variantInitialEnergy:        1.00,
      competitionStrength:         0.0,
      toxinResistance:             0.0,
      nutrientAbsorption:          1.0,
      gravityResponse:             0.0,  // gravity irrelevant for pure GoL
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              10,
      mutagenBoost:                1.0,  // no boost — genome is static
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.0,
      signalDiffusion:             0.50,
      quorumThreshold:             8,
      adaptiveInheritanceRate:     0.0,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Balanced ecosystem — moderate growth, mutation produces Variant B,
   * obstacles all play a meaningful role.  Good all-round starting point.
   */
  ecosystemBalance(): SimulationConfig {
    return {
      spreadRate:                  0.35,
      energyDecayRate:             0.004,
      reproductionThreshold:       0.15,
      initialEnergy:               0.85,
      mutationRate:                0.002, // legacy: Variant B appears after ~500 ticks
      pointMutationRate:           0.004,
      juvenileThreshold:           30,
      senescentThreshold:          500,
      apoptosisBoost:              0.020,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.40,
      variantEnergyDecayRate:      0.006,
      variantReproductionThreshold: 0.15,
      variantInitialEnergy:        0.80,
      competitionStrength:         0.20,
      toxinResistance:             0.30, // partial resistance — hotspots matter
      nutrientAbsorption:          1.00,
      gravityResponse:             0.80,
      toxinStrength:               0.04,
      toxinDurability:             15,
      nutrientBoost:               0.015,
      nutrientDecayRate:           0.0005,
      barrierLifetime:             300,
      gravityStrength:             0.60,
      drainRate:                   0.008,
      fireBurnRate:                0.004,
      censusInterval:              10,
      mutagenBoost:                3.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.10,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.04,
      colonyBoost:                 0.015,
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.30,
      signalDiffusion:             0.85,
      quorumThreshold:             4,
      adaptiveInheritanceRate:     0.30,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Natural Selection — antibiotic-resistant strains emerge under pressure.
   * Paint an Antibiotic band across the midline, then watch resistance evolve.
   */
  naturalSelection(): SimulationConfig {
    return {
      spreadRate:                  0.40,
      energyDecayRate:             0.003,
      reproductionThreshold:       0.12,
      initialEnergy:               0.90,
      mutationRate:                0.0,
      pointMutationRate:           0.008, // elevated for visible evolution
      juvenileThreshold:           25,
      senescentThreshold:          350,
      apoptosisBoost:              0.025,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.45,
      variantEnergyDecayRate:      0.004,
      variantReproductionThreshold: 0.12,
      variantInitialEnergy:        0.85,
      competitionStrength:         0.30,
      toxinResistance:             0.10,
      nutrientAbsorption:          1.00,
      gravityResponse:             0.80,
      toxinStrength:               0.05,
      toxinDurability:             12,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              8,
      mutagenBoost:                3.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.18, // strong antibiotic pressure
      antibioticDecayRate:         0.0005, // slow depletion — pressure lasts longer
      rewinderStrength:            0.05,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        true,  // fitness-improving flips 3× more likely
      chemotaxisWeight:            0.50,
      signalDiffusion:             0.90,
      quorumThreshold:             3,
      adaptiveInheritanceRate:     0.40,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Coevolution — two competing variants in an evolutionary arms race.
   * Distinct lineages form territorial boundaries within ~500 ticks.
   */
  coevolution(): SimulationConfig {
    return {
      spreadRate:                  0.50,
      energyDecayRate:             0.004,
      reproductionThreshold:       0.10,
      initialEnergy:               0.90,
      mutationRate:                0.0,
      pointMutationRate:           0.006,
      juvenileThreshold:           20,
      senescentThreshold:          300,
      apoptosisBoost:              0.030,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.55,
      variantEnergyDecayRate:      0.005,
      variantReproductionThreshold: 0.10,
      variantInitialEnergy:        0.85,
      competitionStrength:         0.50, // strong inter-variant competition
      toxinResistance:             0.15,
      nutrientAbsorption:          1.00,
      gravityResponse:             0.75,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              5,    // finer-grained chart updates
      mutagenBoost:                3.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.35,
      signalDiffusion:             0.88,
      quorumThreshold:             2,   // colony mode kicks in early — kin clusters form
      adaptiveInheritanceRate:     0.25,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Mutagenic Chaos — maximum genome diversity, minimal selective pressure.
   * Genome entropy stays near maximum; no single lineage consolidates.
   */
  mutagenicChaos(): SimulationConfig {
    return {
      spreadRate:                  0.45,
      energyDecayRate:             0.003,
      reproductionThreshold:       0.10,
      initialEnergy:               0.90,
      mutationRate:                0.0,
      pointMutationRate:           0.035, // very high: ~3.5% per reproduction
      juvenileThreshold:           10,    // fast cycles — short generations
      senescentThreshold:          200,
      apoptosisBoost:              0.020,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.50,
      variantEnergyDecayRate:      0.004,
      variantReproductionThreshold: 0.10,
      variantInitialEnergy:        0.85,
      competitionStrength:         0.30,
      toxinResistance:             0.20,
      nutrientAbsorption:          1.00,
      gravityResponse:             0.70,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              5,
      mutagenBoost:                8.0,   // very high mutagen sensitivity
      mutagenDecayRate:            0.0005, // mutagen lasts longer
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        false, // pure random drift
      chemotaxisWeight:            0.20,
      signalDiffusion:             0.80,
      quorumThreshold:             5,
      adaptiveInheritanceRate:     0.15,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Stable Colony — quorum dominates; dense cooperative clusters form.
   * Nearly homogenous — one or two dominant variants hold territory indefinitely.
   */
  stableColony(): SimulationConfig {
    return {
      spreadRate:                  0.30,
      energyDecayRate:             0.002,
      reproductionThreshold:       0.15,
      initialEnergy:               0.90,
      mutationRate:                0.0,
      pointMutationRate:           0.001, // very low — minimal divergence
      juvenileThreshold:           40,
      senescentThreshold:          600,  // long lifespan — stable, slow-cycling
      apoptosisBoost:              0.040, // recycled nutrients sustain interior
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.35,
      variantEnergyDecayRate:      0.003,
      variantReproductionThreshold: 0.15,
      variantInitialEnergy:        0.85,
      competitionStrength:         0.15,
      toxinResistance:             0.20,
      nutrientAbsorption:          1.00,
      gravityResponse:             0.80,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              10,
      mutagenBoost:                2.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.10,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.06,  // moderate rewinding keeps genome stable
      colonyBoost:                 0.025, // strong cooperative energy bonus
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.40,
      signalDiffusion:             0.92, // wide-ranging signal field
      quorumThreshold:             3,    // colony mode at just 3 neighbours
      adaptiveInheritanceRate:     0.25,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Radiation Wasteland — only highly resistant genomes survive long term.
   * Only strains that evolve high toxinResist phenotypes persist.
   */
  radiationWasteland(): SimulationConfig {
    return {
      spreadRate:                  0.55,
      energyDecayRate:             0.006,
      reproductionThreshold:       0.12,
      initialEnergy:               0.90,
      mutationRate:                0.0,
      pointMutationRate:           0.012, // elevated — resistance must evolve
      juvenileThreshold:           15,    // short generations — fast turnover
      senescentThreshold:          250,
      apoptosisBoost:              0.025,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.60,
      variantEnergyDecayRate:      0.007,
      variantReproductionThreshold: 0.12,
      variantInitialEnergy:        0.85,
      competitionStrength:         0.35,
      toxinResistance:             0.10, // starts low — must evolve resistance
      nutrientAbsorption:          0.80,
      gravityResponse:             0.60,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.02,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.01,
      fireBurnRate:                0.005,
      censusInterval:              8,
      mutagenBoost:                5.0,   // radiation also mutagenises survivors
      mutagenDecayRate:            0.001,
      radioWasteDamage:            0.025, // high radiation damage per tick
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        true,  // bias toward resistance mutations
      chemotaxisWeight:            0.30,
      signalDiffusion:             0.85,
      quorumThreshold:             4,
      adaptiveInheritanceRate:     0.50, // strong inheritance of resistance
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  // -------------------------------------------------------------------------
  // Round 5: New organism archetypes (fully-specified, all 41 fields)
  // -------------------------------------------------------------------------

  /**
   * Ancient Prokaryote — pre-Cambrian microbial mat.
   * Slow, Von Neumann diffusion, near-zero mutation, very long-lived.
   */
  ancientProkaryote(): SimulationConfig {
    return {
      spreadRate:                  0.20, // diffusion-limited, not aggressive
      energyDecayRate:             0.002, // very efficient — long-lived
      reproductionThreshold:       0.12, // low bar — minimal energy to divide
      initialEnergy:               0.75,
      mutationRate:                0.0,
      pointMutationRate:           0.001, // rare mutation — stable genome
      juvenileThreshold:           50,   // long juvenile phase
      senescentThreshold:          1200, // very long-lived cells
      apoptosisBoost:              0.010, // minimal recycling signal
      neighbourhoodMode:           'vonNeumann', // orthogonal diffusion only
      overpopulationLimit:         8,    // crowding death disabled
      underpopulationLimit:        0,    // isolation death disabled
      variantSpreadRate:           0.22,
      variantEnergyDecayRate:      0.003,
      variantReproductionThreshold: 0.12,
      variantInitialEnergy:        0.70,
      competitionStrength:         0.05, // minimal competition — peaceful coexistence
      toxinResistance:             0.15,
      nutrientAbsorption:          0.70, // primitive — can't fully exploit nutrients
      gravityResponse:             0.30, // largely ignores physical forces
      toxinStrength:               0.04,
      toxinDurability:             8,
      nutrientBoost:               0.015,
      nutrientDecayRate:           0.001,
      barrierLifetime:             300,
      gravityStrength:             0.3,
      drainRate:                   0.008,
      fireBurnRate:                0.005,
      censusInterval:              15,
      mutagenBoost:                1.5,  // low sensitivity to mutagenic pressure
      mutagenDecayRate:            0.003,
      radioWasteDamage:            0.010, // radiation is highly damaging
      antibioticStrength:          0.15,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.03,
      colonyBoost:                 0.008,
      adaptiveMutationBias:        false, // pure random drift
      chemotaxisWeight:            0.10, // minimal nutrient-seeking
      signalDiffusion:             0.60, // short-range signals only
      quorumThreshold:             8,    // never enters colony mode
      adaptiveInheritanceRate:     0.10,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Viral Storm — RNA virus outbreak dynamics.
   * Ultra-fast replication, high mutation, short lifecycle.
   * Saturates the grid then burns out. Pair with Antibiotic Gauntlet environment.
   */
  viralStorm(): SimulationConfig {
    return {
      spreadRate:                  0.95, // near-maximum replication rate
      energyDecayRate:             0.025, // rapid burnout — live fast, die young
      reproductionThreshold:       0.02, // reproduces even at near-death
      initialEnergy:               1.00,
      mutationRate:                0.0,
      pointMutationRate:           0.020, // high: antigen drift
      juvenileThreshold:           5,    // matures almost instantly
      senescentThreshold:          80,   // very short lifespan
      apoptosisBoost:              0.005,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         5,    // crowding death creates wave dynamics
      underpopulationLimit:        0,
      variantSpreadRate:           0.85, // resistant variant spreads fast
      variantEnergyDecayRate:      0.018,
      variantReproductionThreshold: 0.02,
      variantInitialEnergy:        1.00,
      competitionStrength:         0.70, // variant aggressively displaces base life
      toxinResistance:             0.10,
      nutrientAbsorption:          0.60, // blind spread — no exploitation
      gravityResponse:             0.20,
      toxinStrength:               0.05,
      toxinDurability:             5,    // toxins get consumed quickly
      nutrientBoost:               0.015,
      nutrientDecayRate:           0.002,
      barrierLifetime:             100,
      gravityStrength:             0.3,
      drainRate:                   0.015,
      fireBurnRate:                0.005,
      censusInterval:              3,    // fine-grained for outbreak curves
      mutagenBoost:                4.0,
      mutagenDecayRate:            0.001,
      radioWasteDamage:            0.010,
      antibioticStrength:          0.20, // antibiotics are the primary threat
      antibioticDecayRate:         0.0008,
      rewinderStrength:            0.04,
      colonyBoost:                 0.005,
      adaptiveMutationBias:        true,  // immune evasion bias
      chemotaxisWeight:            0.05, // blind spread — no targeting
      signalDiffusion:             0.70,
      quorumThreshold:             8,    // no cooperation — purely selfish
      adaptiveInheritanceRate:     0.60, // strong inheritance of acquired resistance
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Biofilm Architect — bacterial biofilm formation.
   * Strong quorum sensing, signal gradients drive territory, cooperative energy.
   * Watch for the transition from Pioneer to Colony mode across the grid.
   */
  biofilmArchitect(): SimulationConfig {
    return {
      spreadRate:                  0.28, // moderate — waits for quorum
      energyDecayRate:             0.003,
      reproductionThreshold:       0.18,
      initialEnergy:               0.85,
      mutationRate:                0.0,
      pointMutationRate:           0.002,
      juvenileThreshold:           40,   // long establishment phase
      senescentThreshold:          800,  // long-lived mature cells
      apoptosisBoost:              0.045, // dense recycling feeds frontier expansion
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.32,
      variantEnergyDecayRate:      0.004,
      variantReproductionThreshold: 0.18,
      variantInitialEnergy:        0.80,
      competitionStrength:         0.20,
      toxinResistance:             0.25,
      nutrientAbsorption:          1.00, // maximum nutrient uptake
      gravityResponse:             0.90, // follows gravity wells to resources
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.025,
      nutrientDecayRate:           0.0008,
      barrierLifetime:             300,
      gravityStrength:             0.6,
      drainRate:                   0.010,
      fireBurnRate:                0.004,
      censusInterval:              8,
      mutagenBoost:                2.5,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.04,
      colonyBoost:                 0.030, // colony cells generously feed neighbours
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.70, // strong nutrient gradient following
      signalDiffusion:             0.94, // wide signal field — whole colony communicates
      quorumThreshold:             3,    // colony mode activates at 3 same-variant neighbours
      adaptiveInheritanceRate:     0.50,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Evolutionary Sprinter — optimised for rapid evolution under selection pressure.
   * High mutation, strong adaptive bias, fast generation turnover.
   * Demonstrates Fisher's fundamental theorem in ~200 ticks.
   */
  evolutionarySprinter(): SimulationConfig {
    return {
      spreadRate:                  0.42,
      energyDecayRate:             0.006, // moderate pressure — survival not trivial
      reproductionThreshold:       0.12,
      initialEnergy:               0.88,
      mutationRate:                0.0,
      pointMutationRate:           0.018, // 1.8% per reproduction — diversity engine
      juvenileThreshold:           12,   // fast maturation — short generations
      senescentThreshold:          150,  // rapid generational turnover
      apoptosisBoost:              0.030, // recycling fuels next generation
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.50,
      variantEnergyDecayRate:      0.007,
      variantReproductionThreshold: 0.12,
      variantInitialEnergy:        0.85,
      competitionStrength:         0.40, // fitter variant displaces wild type
      toxinResistance:             0.10, // starts low — must evolve
      nutrientAbsorption:          0.90,
      gravityResponse:             0.70,
      toxinStrength:               0.05,
      toxinDurability:             8,
      nutrientBoost:               0.022,
      nutrientDecayRate:           0.001,
      barrierLifetime:             150,
      gravityStrength:             0.5,
      drainRate:                   0.010,
      fireBurnRate:                0.005,
      censusInterval:              4,    // fine-grained resistance curves
      mutagenBoost:                3.5,
      mutagenDecayRate:            0.0015,
      radioWasteDamage:            0.010,
      antibioticStrength:          0.15, // antibiotic drives resistance evolution
      antibioticDecayRate:         0.0005, // lasts long enough to create selection
      rewinderStrength:            0.04,
      colonyBoost:                 0.012,
      adaptiveMutationBias:        true,  // fitness-improving flips 3× more likely
      chemotaxisWeight:            0.60, // seeks nutrients to maximise fitness
      signalDiffusion:             0.82,
      quorumThreshold:             5,    // stays in pioneer mode longer
      adaptiveInheritanceRate:     0.55,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Extremophile — thrives in conditions that kill normal cells.
   * High toxin and radiation resistance, low nutrient requirement.
   * Models archaea in hydrothermal vents, acid baths, or high-radiation zones.
   */
  extremophile(): SimulationConfig {
    return {
      spreadRate:                  0.22, // slow — extremophiles are not fast colonisers
      energyDecayRate:             0.001, // ultra-efficient metabolism
      reproductionThreshold:       0.20, // needs to be well-fed before dividing
      initialEnergy:               0.80,
      mutationRate:                0.0,
      pointMutationRate:           0.003,
      juvenileThreshold:           60,   // very cautious growth phase
      senescentThreshold:          1500, // exceptionally long-lived
      apoptosisBoost:              0.015,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.25,
      variantEnergyDecayRate:      0.0015,
      variantReproductionThreshold: 0.20,
      variantInitialEnergy:        0.75,
      competitionStrength:         0.15,
      toxinResistance:             0.75, // high innate resistance
      nutrientAbsorption:          0.50, // adapted to low-nutrient conditions
      gravityResponse:             0.40, // less susceptible to physical forces
      toxinStrength:               0.03, // toxins are weaker against this organism
      toxinDurability:             20,
      nutrientBoost:               0.010, // extracts less from nutrients (adapted to scarcity)
      nutrientDecayRate:           0.0005,
      barrierLifetime:             400,
      gravityStrength:             0.4,
      drainRate:                   0.006,
      fireBurnRate:                0.005,
      censusInterval:              12,
      mutagenBoost:                1.20, // mostly immune to external mutagenic exposure
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.002, // radiation has reduced impact
      antibioticStrength:          0.08, // partially resistant to antibiotics
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.03,
      colonyBoost:                 0.010,
      adaptiveMutationBias:        true,  // bias toward stress-resistance mutations
      chemotaxisWeight:            0.30,
      signalDiffusion:             0.78,
      quorumThreshold:             6,
      adaptiveInheritanceRate:     0.70, // strong Lamarckian — children born resistant
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Territorial Conquistador — aggressive expansion through high spread,
   * strong competition, early colony consolidation, and chemotaxis to block
   * rival access to nutrients.
   */
  territorialConquistador(): SimulationConfig {
    return {
      spreadRate:                  0.65, // fast initial expansion
      energyDecayRate:             0.005,
      reproductionThreshold:       0.10,
      initialEnergy:               0.92,
      mutationRate:                0.0,
      pointMutationRate:           0.005,
      juvenileThreshold:           20,   // fast maturity — born fighters
      senescentThreshold:          300,
      apoptosisBoost:              0.040, // dying cells fuel the frontier
      neighbourhoodMode:           'moore',
      overpopulationLimit:         6,    // crowding death enforces territory boundaries
      underpopulationLimit:        1,    // can't survive alone — drives clustering
      variantSpreadRate:           0.72, // variant even more aggressive
      variantEnergyDecayRate:      0.007, // higher cost for higher aggression
      variantReproductionThreshold: 0.10,
      variantInitialEnergy:        0.90,
      competitionStrength:         0.70, // displaces rivals aggressively
      toxinResistance:             0.20,
      nutrientAbsorption:          1.00,
      gravityResponse:             0.85,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.022,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.7,
      drainRate:                   0.010,
      fireBurnRate:                0.004,
      censusInterval:              6,
      mutagenBoost:                3.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.018, // cooperative support for territorial consolidation
      adaptiveMutationBias:        true,  // evolves toward more competitive phenotypes
      chemotaxisWeight:            0.80, // races to nutrients before rivals
      signalDiffusion:             0.88, // wide territorial signals
      quorumThreshold:             2,    // enters colony mode early — locks down territory
      adaptiveInheritanceRate:     0.35,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Nomadic Scavenger — constantly moving toward nutrients, evading threats.
   * Never builds stable colonies — high chemotaxis, always in pioneer mode.
   * Thrives in complex environments with scattered resource patches.
   */
  nomadicScavenger(): SimulationConfig {
    return {
      spreadRate:                  0.50,
      energyDecayRate:             0.008, // nomadic lifestyle is expensive
      reproductionThreshold:       0.15,
      initialEnergy:               0.95,
      mutationRate:                0.0,
      pointMutationRate:           0.006,
      juvenileThreshold:           8,    // near-instant maturity — always on the move
      senescentThreshold:          120,  // short lifespan — constant turnover
      apoptosisBoost:              0.035, // recycled energy propels next generation
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.55,
      variantEnergyDecayRate:      0.009,
      variantReproductionThreshold: 0.15,
      variantInitialEnergy:        0.90,
      competitionStrength:         0.30,
      toxinResistance:             0.40, // moderate — survives brief toxin exposure
      nutrientAbsorption:          1.00, // maximum uptake when nutrients found
      gravityResponse:             0.85, // follows gravity wells strategically
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.025,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.6,
      drainRate:                   0.010,
      fireBurnRate:                0.005,
      censusInterval:              8,
      mutagenBoost:                3.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.010, // minimal — doesn't build infrastructure
      adaptiveMutationBias:        true,
      chemotaxisWeight:            0.90, // maximum nutrient gradient following
      signalDiffusion:             0.70, // short-range — localised decisions
      quorumThreshold:             8,    // never enters colony mode — always pioneer
      adaptiveInheritanceRate:     0.35,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Jurassic Megaflora — slow-growing large organisms with long lifecycles.
   * Overpopulation-limited like plant competition; Von Neumann spread.
   * Grove formation via quorum; apoptosis enriches the forest floor.
   */
  jurassicMegaflora(): SimulationConfig {
    return {
      spreadRate:                  0.12, // trees don't rush
      energyDecayRate:             0.001, // ultra-low — decades-long lifespan
      reproductionThreshold:       0.50, // only reproduces when fully established
      initialEnergy:               0.70, // seeds start with moderate energy
      mutationRate:                0.0,
      pointMutationRate:           0.001, // rare mutation — stable species
      juvenileThreshold:           150,  // long juvenile phase — saplings
      senescentThreshold:          3000, // ancient old-growth
      apoptosisBoost:              0.060, // fallen tree enriches forest floor
      neighbourhoodMode:           'vonNeumann', // orthogonal root/canopy spread
      overpopulationLimit:         4,    // dense canopy prevents new growth
      underpopulationLimit:        1,    // cannot survive alone — needs a grove
      variantSpreadRate:           0.14,
      variantEnergyDecayRate:      0.0012,
      variantReproductionThreshold: 0.50,
      variantInitialEnergy:        0.65,
      competitionStrength:         0.25,
      toxinResistance:             0.20,
      nutrientAbsorption:          1.00, // maximum nutrient use
      gravityResponse:             1.00, // maximum gravity-well seeking (sun/water)
      toxinStrength:               0.04,
      toxinDurability:             15,
      nutrientBoost:               0.020,
      nutrientDecayRate:           0.0005,
      barrierLifetime:             500,
      gravityStrength:             0.8,
      drainRate:                   0.005,
      fireBurnRate:                0.003, // fire burns slowly through tough wood
      censusInterval:              20,
      mutagenBoost:                2.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.010,
      antibioticStrength:          0.08,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.04,
      colonyBoost:                 0.015,
      adaptiveMutationBias:        false,
      chemotaxisWeight:            0.50, // moderate nutrient seeking
      signalDiffusion:             0.96, // wide canopy signalling — grove coordination
      quorumThreshold:             3,    // colony mode at 3 neighbours — grove formation
      adaptiveInheritanceRate:     0.20,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Parasitic Overload — Variant B is a parasite on Variant A (the host).
   * High competition, Variant B has extreme aggression, minimal cooperation.
   * Watch host and parasite populations cycle like Lotka-Volterra predator-prey.
   */
  parasiticOverload(): SimulationConfig {
    return {
      spreadRate:                  0.35, // host spreads cautiously
      energyDecayRate:             0.004,
      reproductionThreshold:       0.12,
      initialEnergy:               0.88,
      mutationRate:                0.0,
      pointMutationRate:           0.008, // both mutate to adapt to each other
      juvenileThreshold:           20,
      senescentThreshold:          300,
      apoptosisBoost:              0.020,
      neighbourhoodMode:           'moore',
      overpopulationLimit:         8,
      underpopulationLimit:        0,
      variantSpreadRate:           0.80, // parasite spreads aggressively
      variantEnergyDecayRate:      0.020, // parasite burns fast — needs constant host
      variantReproductionThreshold: 0.05, // parasite reproduces at near-zero energy
      variantInitialEnergy:        1.00,
      competitionStrength:         0.85, // near-overwhelming parasite pressure
      toxinResistance:             0.20, // host has partial toxin resistance
      nutrientAbsorption:          0.80,
      gravityResponse:             0.60,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.020,
      nutrientDecayRate:           0.001,
      barrierLifetime:             200,
      gravityStrength:             0.5,
      drainRate:                   0.010,
      fireBurnRate:                0.005,
      censusInterval:              5,    // fine-grained host/parasite chart
      mutagenBoost:                3.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.12,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.05,
      colonyBoost:                 0.010,
      adaptiveMutationBias:        true,  // arms-race dynamics
      chemotaxisWeight:            0.30, // parasite seeks host density, not nutrients
      signalDiffusion:             0.90, // wide host alarm signals
      quorumThreshold:             6,    // host needs large group for defence
      adaptiveInheritanceRate:     0.40,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

  /**
   * Neural Network Colony — cells cooperate via extremely wide signal fields
   * to form coordinated macro-structures.  Large clusters required for colony mode.
   * Exhibits coordinated border expansion waves once enough cells synchronise.
   */
  neuralNetworkColony(): SimulationConfig {
    return {
      spreadRate:                  0.40, // moderate — signal-coordinated expansion
      energyDecayRate:             0.004,
      reproductionThreshold:       0.15,
      initialEnergy:               0.90,
      mutationRate:                0.0,
      pointMutationRate:           0.004, // low — stable genome for coordination
      juvenileThreshold:           35,
      senescentThreshold:          600,  // stable long-lived interior cells
      apoptosisBoost:              0.050, // apoptosis triggers coordinated frontier wave
      neighbourhoodMode:           'moore',
      overpopulationLimit:         7,    // near-disabled — dense packing allowed
      underpopulationLimit:        2,    // needs peers to survive
      variantSpreadRate:           0.45,
      variantEnergyDecayRate:      0.005,
      variantReproductionThreshold: 0.15,
      variantInitialEnergy:        0.85,
      competitionStrength:         0.20,
      toxinResistance:             0.25,
      nutrientAbsorption:          1.00,
      gravityResponse:             0.80,
      toxinStrength:               0.05,
      toxinDurability:             10,
      nutrientBoost:               0.022,
      nutrientDecayRate:           0.001,
      barrierLifetime:             250,
      gravityStrength:             0.6,
      drainRate:                   0.010,
      fireBurnRate:                0.004,
      censusInterval:              5,    // watch coordination emerge in charts
      mutagenBoost:                2.0,
      mutagenDecayRate:            0.002,
      radioWasteDamage:            0.008,
      antibioticStrength:          0.10,
      antibioticDecayRate:         0.001,
      rewinderStrength:            0.08, // rewinders keep population homogenous
      colonyBoost:                 0.025, // colony cells are energy hubs
      adaptiveMutationBias:        false, // coordination, not adaptation
      chemotaxisWeight:            0.80, // strong gradient following
      signalDiffusion:             0.97, // near-maximum — global coordination
      quorumThreshold:             6,    // large clusters needed for colony mode
      adaptiveInheritanceRate:     0.30,
      motilityRate:                0.0,
      motilityThreshold:           0.3,
      motilityDamping:             0.2,
      chemotaxisMotilityFraction:  0.5,
    };
  },

} as const;

// ---------------------------------------------------------------------------
// LIFE_PRESETS — structured array with metadata for the UI preset panel
// ---------------------------------------------------------------------------

/**
 * All named life presets, each bundled with display metadata.
 *
 * The UI iterates this array to render preset cards, apply filtering by
 * archetype, and show difficulty badges.  Order determines display order:
 * classic presets first, then Round 5 organism archetypes.
 */
export const LIFE_PRESETS: readonly LifePreset[] = [
  {
    key: 'slowBurn',
    meta: {
      name:                   'Slow Burn',
      description:            'Life clings on but barely expands. Good for watching sparse clusters stabilise under high metabolic cost.',
      difficulty:             3,
      archetype:              'primitive',
      recommendedEnvironment: 'pristinePetri',
    },
    config: Presets.slowBurn(),
  },
  {
    key: 'plague',
    meta: {
      name:                   'Plague',
      description:            'Floods the board in seconds. Near-zero decay and maximum spread rate — the definitive stress test for obstacles.',
      difficulty:             1,
      archetype:              'aggressive',
      recommendedEnvironment: 'theVoid',
    },
    config: Presets.plague(),
  },
  {
    key: 'classicGameOfLife',
    meta: {
      name:                   'Classic Game of Life',
      description:            'Conway\'s Game of Life rules mapped to the energy model. Overpopulation and underpopulation do the culling.',
      difficulty:             2,
      archetype:              'primitive',
      recommendedEnvironment: 'pristinePetri',
    },
    config: Presets.classicGameOfLife(),
  },
  {
    key: 'ecosystemBalance',
    meta: {
      name:                   'Ecosystem Balance',
      description:            'Moderate growth with mutation producing a competing Variant B. Best starting point for exploring all obstacle types.',
      difficulty:             2,
      archetype:              'cooperative',
      recommendedEnvironment: 'coralReef',
    },
    config: Presets.ecosystemBalance(),
  },
  {
    key: 'naturalSelection',
    meta: {
      name:                   'Natural Selection',
      description:            'Antibiotic-resistant strains emerge under selection pressure. Paint an Antibiotic band and watch resistance evolve in ~300 ticks.',
      difficulty:             3,
      archetype:              'resilient',
      recommendedEnvironment: 'antibioticGauntlet',
    },
    config: Presets.naturalSelection(),
  },
  {
    key: 'coevolution',
    meta: {
      name:                   'Coevolution',
      description:            'Two variants locked in an evolutionary arms race. Distinct lineages form territorial boundaries within ~500 ticks.',
      difficulty:             3,
      archetype:              'chaotic',
      recommendedEnvironment: 'coralReef',
    },
    config: Presets.coevolution(),
  },
  {
    key: 'mutagenicChaos',
    meta: {
      name:                   'Mutagenic Chaos',
      description:            'Maximum genome diversity, minimal selective pressure. No lineage can consolidate — pure genetic drift at 3.5% mutation rate.',
      difficulty:             2,
      archetype:              'chaotic',
      recommendedEnvironment: 'radioactiveWastes',
    },
    config: Presets.mutagenicChaos(),
  },
  {
    key: 'stableColony',
    meta: {
      name:                   'Stable Colony',
      description:            'Quorum sensing dominates. Dense cooperative clusters form and hold territory indefinitely with minimal mutation.',
      difficulty:             2,
      archetype:              'cooperative',
      recommendedEnvironment: 'ancientForestFloor',
    },
    config: Presets.stableColony(),
  },
  {
    key: 'radiationWasteland',
    meta: {
      name:                   'Radiation Wasteland',
      description:            'Only highly resistant genomes survive. Watch toxin-resist tiers evolve in real time as weaker strains die out within 200 ticks.',
      difficulty:             4,
      archetype:              'resilient',
      recommendedEnvironment: 'radioactiveWastes',
    },
    config: Presets.radiationWasteland(),
  },
  // --- Round 5 organism archetypes -----------------------------------------
  {
    key: 'ancientProkaryote',
    meta: {
      name:                   'Ancient Prokaryote',
      description:            'Pre-Cambrian microbial mat — slow, diffusion-limited, nearly immortal cells with orthogonal (Von Neumann) spread.',
      difficulty:             3,
      archetype:              'primitive',
      recommendedEnvironment: 'pristinePetri',
    },
    config: Presets.ancientProkaryote(),
  },
  {
    key: 'viralStorm',
    meta: {
      name:                   'Viral Storm',
      description:            'RNA virus outbreak dynamics: ultra-fast replication, 2% mutation rate, short lifespan. Saturates the grid then burns out.',
      difficulty:             2,
      archetype:              'aggressive',
      recommendedEnvironment: 'antibioticGauntlet',
    },
    config: Presets.viralStorm(),
  },
  {
    key: 'biofilmArchitect',
    meta: {
      name:                   'Biofilm Architect',
      description:            'Strong quorum sensing and signal gradients drive territory demarcation. Watch Pioneer mode transition to Colony mode across the grid.',
      difficulty:             2,
      archetype:              'cooperative',
      recommendedEnvironment: 'coralReef',
    },
    config: Presets.biofilmArchitect(),
  },
  {
    key: 'evolutionarySprinter',
    meta: {
      name:                   'Evolutionary Sprinter',
      description:            'Maximum evolution speed under selection pressure. Demonstrates Fisher\'s fundamental theorem — resistance appears in ~200 ticks.',
      difficulty:             3,
      archetype:              'chaotic',
      recommendedEnvironment: 'antibioticGauntlet',
    },
    config: Presets.evolutionarySprinter(),
  },
  {
    key: 'extremophile',
    meta: {
      name:                   'Extremophile',
      description:            'Thrives where others die — 75% toxin resistance, ultra-efficient metabolism, exceptionally long-lived. Models archaea in hostile habitats.',
      difficulty:             3,
      archetype:              'resilient',
      recommendedEnvironment: 'volcanicBadlands',
    },
    config: Presets.extremophile(),
  },
  {
    key: 'territorialConquistador',
    meta: {
      name:                   'Territorial Conquistador',
      description:            'Races to nutrients, blocks rival access, consolidates territory early via quorum. Aggressive expansion through chemical intelligence.',
      difficulty:             2,
      archetype:              'aggressive',
      recommendedEnvironment: 'labyrinth',
    },
    config: Presets.territorialConquistador(),
  },
  {
    key: 'nomadicScavenger',
    meta: {
      name:                   'Nomadic Scavenger',
      description:            'Never settles — maximum chemotaxis, always in pioneer mode. Survives by constantly chasing nutrient gradients across complex terrain.',
      difficulty:             3,
      archetype:              'resilient',
      recommendedEnvironment: 'labyrinth',
    },
    config: Presets.nomadicScavenger(),
  },
  {
    key: 'jurassicMegaflora',
    meta: {
      name:                   'Jurassic Megaflora',
      description:            'Slow-growing organisms with 3000-tick lifespans. Grove formation via quorum; falling old-growth enriches the forest floor.',
      difficulty:             4,
      archetype:              'primitive',
      recommendedEnvironment: 'ancientForestFloor',
    },
    config: Presets.jurassicMegaflora(),
  },
  {
    key: 'parasiticOverload',
    meta: {
      name:                   'Parasitic Overload',
      description:            'Variant B is a parasite on Variant A. Watch population cycles like Lotka-Volterra predator-prey dynamics emerge over hundreds of ticks.',
      difficulty:             4,
      archetype:              'aggressive',
      recommendedEnvironment: 'immuneBattleground',
    },
    config: Presets.parasiticOverload(),
  },
  {
    key: 'neuralNetworkColony',
    meta: {
      name:                   'Neural Network Colony',
      description:            'Near-global signal diffusion (97%) drives coordinated macro-structures. Large clusters synchronise into a single coordinated expansion wave.',
      difficulty:             3,
      archetype:              'cooperative',
      recommendedEnvironment: 'deepSeaVents',
    },
    config: Presets.neuralNetworkColony(),
  },
];
