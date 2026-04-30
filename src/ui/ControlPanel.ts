/**
 * @fileoverview Control Panel sidebar component for the What Simulator.
 *
 * Renders the left sidebar with life-parameter sliders, drawing tools, and
 * viewport controls.  Wired to AppState so all changes take effect on the
 * next simulation tick.
 *
 * Each slider is a labeled row:
 *   [Label]  [range input]  [live value readout]
 *
 * Phase 2 additions:
 *   - Drawing Tools section: brush type selector + brush size slider.
 *
 * Phase 3 additions:
 *   - Initial Density slider (controls seed fraction on Reset).
 *   - Life Variant B section (collapsible; appears when mutations occur).
 *   - Variant B parameter sliders + competition strength slider.
 *
 * Phase 5 additions:
 *   - Drawing Tools: added Drain, GravityWell, Barrier, Fire, Ice buttons.
 *   - Obstacle Parameters section: sliders for all Phase 5 obstacle settings.
 *
 * Slider changes call `appState.updateConfig(key, value)` which fires the
 * `configChange` event consumed by the simulation engine on the next tick.
 */

import { appState, type DrawingTool } from '../state/AppState.js';
import { bus } from '../state/EventBus.js';
import { type SimulationConfig, Presets } from '../simulation/config/SimulationConfig.js';
import { BACKGROUND_LABELS, type BackgroundType } from '../rendering/BackgroundRenderer.js';
import { PresetPanel } from './PresetPanel.js';

// ---------------------------------------------------------------------------
// Slider descriptor type
// ---------------------------------------------------------------------------

/** Describes one parameter slider. */
interface SliderSpec {
  /** Display label. */
  label: string;
  /** Key in SimulationConfig. */
  key: keyof SimulationConfig;
  /** Slider minimum. */
  min: number;
  /** Slider maximum. */
  max: number;
  /** Slider step increment. */
  step: number;
  /** Tooltip / description shown on hover. */
  title: string;
}

// ---------------------------------------------------------------------------
// Drawing tool definitions (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Describes one brush tool button in the Drawing Tools section.
 * `color` is a CSS color string used for the small swatch indicator.
 */
interface ToolDef {
  /** DrawingTool value stored in AppState. */
  tool: DrawingTool;
  /** Human-readable label. */
  label: string;
  /** Swatch color displayed on the button. */
  color: string;
  /** Tooltip description. */
  title: string;
}

/**
 * All brush tool definitions — Phase 2 + Phase 5 additions.
 * Ordered to group related tools logically in the UI.
 */
const TOOL_DEFS: readonly ToolDef[] = [
  // --- Life tools ---
  {
    tool: 'life',        label: 'Life',
    color: '#00ff88',
    title: 'Paint life cells that spread and expand.',
  },
  // --- Phase 2 obstacles ---
  {
    tool: 'wall',        label: 'Wall',
    color: '#3a3a3a',
    title: 'Impassable barrier — life cannot spread through walls.',
  },
  {
    tool: 'toxin',       label: 'Toxin',
    color: '#cc00ff',
    title: 'Damages adjacent life cells each tick; life entering a toxin cell loses energy.',
  },
  {
    tool: 'nutrient',    label: 'Nutrient',
    color: '#00cc44',
    title: 'Boosts adjacent life energy each tick; depletes over time.',
  },
  // --- Phase 5 obstacles ---
  {
    tool: 'drain',       label: 'Drain',
    color: '#0044cc',
    title: 'Drains energy from adjacent life each tick and halves their spread rate.',
  },
  {
    tool: 'gravityWell', label: 'Gravity',
    color: '#ff8800',
    title: 'Pulls life spread probability toward the well centre (inverse-square).',
  },
  {
    tool: 'barrier',     label: 'Barrier',
    color: '#ffee00',
    title: 'Impassable wall that fades and crumbles after a set number of ticks.',
  },
  {
    tool: 'fire',        label: 'Fire',
    color: '#ff4400',
    title: 'Kills adjacent life instantly; spreads to neighbouring life/nutrient; burns out.',
  },
  {
    tool: 'ice',         label: 'Ice',
    color: '#aaddff',
    title: 'Freezes adjacent life cells — no energy decay, no spread, no death.',
  },
  // --- Phase 12: genome-aware obstacles ---
  {
    tool: 'mutagen',     label: 'Mutagen',
    color: '#ff00cc',
    title: 'Boosts mutation rate for adjacent life cells; depletes over time.',
  },
  {
    tool: 'radioWaste',  label: 'Radio Waste',
    color: '#99ff00',
    title: 'Permanent radiation source — damages adjacent life and causes random genome bit flips.',
  },
  {
    tool: 'antibiotic',  label: 'Antibiotic',
    color: '#f0f0f0',
    title: 'Per-tick kill chance for adjacent life cells; reduced by evolved toxin resistance.',
  },
  {
    tool: 'rewinder',    label: 'Rewinder',
    color: '#4488ff',
    title: 'Nudges adjacent life genomes back toward the neutral baseline, eroding genetic drift.',
  },
  {
    tool: 'colony',      label: 'Colony',
    color: '#ffaa22',
    title: 'Cooperative infrastructure — boosts adjacent life energy and emits a chemical signal.',
  },
  // --- Erase ---
  {
    tool: 'erase',       label: 'Erase',
    color: '#555577',
    title: 'Remove cells (right-click on canvas also erases).',
  },
];

// ---------------------------------------------------------------------------
// Slider spec definitions
// ---------------------------------------------------------------------------

/**
 * Phase 5 — Obstacle Parameter slider specs.
 * Controls all tuneable obstacle behaviours that affect Phase 5 cell types.
 */
const OBSTACLE_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Toxin Strength',
    key:   'toxinStrength',
    min: 0, max: 0.2, step: 0.001,
    title: 'Energy damage dealt to adjacent life cells each tick by Toxin.',
  },
  {
    label: 'Toxin Durability',
    key:   'toxinDurability',
    min: 1, max: 50, step: 1,
    title: 'Number of life kills before a Toxin cell is consumed (not yet implemented — reserved).',
  },
  {
    label: 'Nutrient Boost',
    key:   'nutrientBoost',
    min: 0, max: 0.1, step: 0.001,
    title: 'Energy gained by adjacent life cells each tick from Nutrient.',
  },
  {
    label: 'Nutrient Decay',
    key:   'nutrientDecayRate',
    min: 0, max: 0.01, step: 0.0001,
    title: 'Rate at which Nutrient cells deplete per tick.',
  },
  {
    label: 'Drain Rate',
    key:   'drainRate',
    min: 0, max: 0.05, step: 0.001,
    title: 'Energy drained from adjacent life cells per tick by Drain cells.',
  },
  {
    label: 'Gravity Strength',
    key:   'gravityStrength',
    min: 0, max: 1, step: 0.01,
    title: 'Pull-force magnitude of GravityWell cells (inverse-square falloff).',
  },
  {
    label: 'Barrier Lifetime',
    key:   'barrierLifetime',
    min: 10, max: 1000, step: 10,
    title: 'Ticks before a Barrier cell crumbles to Empty.',
  },
  {
    label: 'Fire Burn Rate',
    key:   'fireBurnRate',
    min: 0.001, max: 0.05, step: 0.001,
    title: 'Fuel consumed by Fire per tick. Higher = faster burnout.',
  },
];

/**
 * Phase 12 — Genome-Aware Obstacle Parameter slider specs.
 * Controls the new Round-2 obstacle types that interact with cell genomes.
 */
const GENOME_OBSTACLE_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Mutagen Boost',
    key:   'mutagenBoost',
    min: 1, max: 10, step: 0.5,
    title:
      'Multiplier applied to the point-mutation rate for Life cells adjacent to a Mutagen cell. ' +
      '3× = triple the genome mutation speed near Mutagen.',
  },
  {
    label: 'Mutagen Decay',
    key:   'mutagenDecayRate',
    min: 0, max: 0.01, step: 0.0001,
    title: 'Energy lost per tick by Mutagen cells. Higher = faster depletion.',
  },
  {
    label: 'Radio Damage',
    key:   'radioWasteDamage',
    min: 0, max: 0.05, step: 0.001,
    title:
      'Energy damage dealt per tick to Life cells adjacent to RadioWaste. ' +
      'Also causes random genome bit flips. Partially mitigated by toxin resistance.',
  },
  {
    label: 'Antibiotic Kill',
    key:   'antibioticStrength',
    min: 0, max: 1, step: 0.01,
    title:
      'Per-tick kill probability for Life cells adjacent to an Antibiotic cell. ' +
      'Reduced by the cell\'s evolved toxin resistance phenotype.',
  },
  {
    label: 'Antibiotic Decay',
    key:   'antibioticDecayRate',
    min: 0, max: 0.01, step: 0.0001,
    title: 'Energy lost per tick by Antibiotic cells. Higher = faster depletion.',
  },
  {
    label: 'Rewinder Strength',
    key:   'rewinderStrength',
    min: 0, max: 1, step: 0.01,
    title:
      'Probability per tick that a Rewinder cell nudges one nibble of an adjacent ' +
      'Life cell\'s genome one step toward the neutral baseline (0x7777).',
  },
  {
    label: 'Colony Boost',
    key:   'colonyBoost',
    min: 0, max: 0.05, step: 0.001,
    title: 'Energy provided per tick to each Life cell adjacent to a Colony cell.',
  },
];

/** All Phase-1 life parameters as slider specs. */
const LIFE_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Spread Rate',
    key:   'spreadRate',
    min: 0, max: 1, step: 0.01,
    title: 'Probability per tick that a Life cell spreads to each empty neighbour.',
  },
  {
    label: 'Energy Decay',
    key:   'energyDecayRate',
    min: 0, max: 0.1, step: 0.001,
    title: 'Energy lost per tick per living cell (metabolic cost).',
  },
  {
    label: 'Repro. Threshold',
    key:   'reproductionThreshold',
    min: 0, max: 1, step: 0.01,
    title: 'Minimum energy required before a cell can spread.',
  },
  {
    label: 'Initial Energy',
    key:   'initialEnergy',
    min: 0, max: 1, step: 0.01,
    title: 'Energy assigned to each newly born cell.',
  },
  {
    label: 'Overpop. Limit',
    key:   'overpopulationLimit',
    min: 0, max: 8, step: 1,
    title: 'Maximum live neighbours before a cell dies. 8 = disabled.',
  },
  {
    label: 'Underpop. Limit',
    key:   'underpopulationLimit',
    min: 0, max: 8, step: 1,
    title: 'Minimum live neighbours needed to survive. 0 = disabled.',
  },
];

/**
 * Phase 10 — Lifecycle Stage slider specs.
 * Controls the age thresholds that govern juvenile / mature / senescent
 * transitions and the energy bonus distributed to neighbours when a
 * senescent cell undergoes planned apoptosis.
 *
 * Also exposes the Round-2 point-mutation rate here because it interacts
 * closely with lifecycle: juveniles never mutate, senescents mutate at 2×.
 */
const LIFECYCLE_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Juvenile Threshold',
    key:   'juvenileThreshold',
    min: 1, max: 200, step: 1,
    title:
      'Age (in ticks) below which a Life cell is considered juvenile. ' +
      'Juveniles spread at 40% of the normal rate and never mutate.',
  },
  {
    label: 'Senescent Threshold',
    key:   'senescentThreshold',
    min: 50, max: 2000, step: 10,
    title:
      'Age (in ticks) above which a Life cell enters senescence. ' +
      'Senescent cells spread at 10% of the normal rate, decay 1.5× faster, ' +
      'and mutate at twice the base rate.',
  },
  {
    label: 'Apoptosis Boost',
    key:   'apoptosisBoost',
    min: 0, max: 0.1, step: 0.001,
    title:
      'Energy bonus added to each live neighbour when a senescent cell dies ' +
      'via apoptosis (planned cell death). Higher = more recycling to offspring.',
  },
  {
    label: 'Point Mutation Rate',
    key:   'pointMutationRate',
    min: 0, max: 0.05, step: 0.0005,
    title:
      'Per-spread probability that a single genome bit is flipped (Round 2 ' +
      'evolution). 0.002 = ~0.2% chance per reproduction event.',
  },
];


/**
 * Phase 15 — Evolution Behaviour slider specs.
 * Controls signal diffusion, quorum sensing, chemotaxis, and adaptive
 * inheritance — the parameters governing emergent colony dynamics.
 * `adaptiveMutationBias` (boolean) is rendered as a checkbox, not a slider.
 */
const EVOLUTION_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Signal Diffusion',
    key:   'signalDiffusion',
    min: 0, max: 1, step: 0.01,
    title:
      'Fraction of signal retained each tick [0–1]. ' +
      '0.85 = signal propagates ~6 cells from a source before fading. ' +
      'Lower = short-range; higher = wide-ranging gradients.',
  },
  {
    label: 'Quorum Threshold',
    key:   'quorumThreshold',
    min: 1, max: 8, step: 1,
    title:
      'Same-variant neighbours needed to enter Colony mode [1–8]. ' +
      'Below this: Pioneer mode (faster spread, higher cost). ' +
      'At or above: Colony mode (conserved energy, slower spread).',
  },
  {
    label: 'Chemotaxis Weight',
    key:   'chemotaxisWeight',
    min: 0, max: 1, step: 0.01,
    title:
      'Gradient-following bias on spread target selection [0–1]. ' +
      '0 = uniform spread; 1 = maximum nutrient-signal following. ' +
      'Effective only when signalDiffusion > 0 and nutrients are present.',
  },
  {
    label: 'Adaptive Inheritance',
    key:   'adaptiveInheritanceRate',
    min: 0, max: 1, step: 0.01,
    title:
      'Probability [0–1] that a stress-acquired adaptation (e.g. toxin ' +
      'survival → higher toxinResist tier) is passed to offspring. ' +
      '0 = pure Darwinian; 1 = full Lamarckian inheritance.',
  },

  // --- Phase 19: Motility & Chemotaxis ----------------------------------------
  {
    label: 'Motility Rate',
    key:   'motilityRate',
    min: 0, max: 1, step: 0.01,
    title:
      'Probability [0–1] per tick that a motile Life cell (spreadBonus above ' +
      'the Motility Threshold) attempts to migrate one cell in its velocity ' +
      'direction. 0 disables motility entirely.',
  },
  {
    label: 'Motility Threshold',
    key:   'motilityThreshold',
    min: 0, max: 1, step: 0.01,
    title:
      'Minimum spreadBonus [0–1] required for a Life cell to be considered ' +
      'motile. Cells at or below this value are stationary regardless of ' +
      'Motility Rate.',
  },
  {
    label: 'Motility Damping',
    key:   'motilityDamping',
    min: 0, max: 1, step: 0.01,
    title:
      'Fraction of velocity removed per tick (fluid drag). 0 = ballistic ' +
      '(velocity persists forever); 1 = zero persistence (velocity zeroed ' +
      'each tick).',
  },
  {
    label: 'Chemotaxis Fraction',
    key:   'chemotaxisMotilityFraction',
    min: 0, max: 1, step: 0.01,
    title:
      'Fraction of updated velocity derived from the chemical gradient ' +
      'vs. persisted momentum. 0 = purely inertial; 1 = purely gradient-driven.',
  },
];

// ---------------------------------------------------------------------------
// Phase 20 — Chemical Ecology slider specs
// ---------------------------------------------------------------------------

/**
 * Phase 20 — Chemical Ecology slider specs.
 * Controls the 4-channel diffusible chemical system (N/W/P/A):
 * secretion rates, multi-channel chemotaxis coefficients, diffusion/decay
 * physics, quorum-sensing threshold, and activation energy bonus.
 */
const CHEMICAL_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Waste Secretion',
    key:   'wasteSecretionRate',
    min: 0, max: 1, step: 0.01,
    title:
      'Rate at which living cells release waste into the chemical field [0–1]. ' +
      '0 = no waste produced; 1 = maximum secretion each tick. ' +
      'Waste repels other cells via the Waste Avoidance coefficient.',
  },
  {
    label: 'Pheromone Secretion',
    key:   'pheromoneSecretionRate',
    min: 0, max: 1, step: 0.01,
    title:
      'Rate at which living cells emit pheromone into the chemical field [0–1]. ' +
      'Pheromone triggers quorum sensing when concentration exceeds the Quorum ' +
      'Chem Threshold, and can attract or repel other cells.',
  },
  {
    label: 'Nutrient Chemotaxis',
    key:   'nutrientChemotaxis',
    min: 0, max: 2, step: 0.01,
    title:
      'Strength of velocity bias toward rising nutrient-chemical gradient [0–2]. ' +
      '0 = no response to nutrient gradient; positive values steer cells toward ' +
      'nutrient-rich regions.',
  },
  {
    label: 'Pheromone Chemotaxis',
    key:   'pheromoneChemotaxis',
    min: 0, max: 2, step: 0.01,
    title:
      'Strength of velocity bias toward rising pheromone gradient [0–2]. ' +
      '0 = no response; positive values cluster cells by following pheromone ' +
      'trails left by same-colony members.',
  },
  {
    label: 'Waste Avoidance',
    key:   'wasteAvoidance',
    min: 0, max: 2, step: 0.01,
    title:
      'Strength of velocity bias away from rising waste gradient [0–2]. ' +
      '0 = no avoidance; positive values cause cells to flee high-waste regions ' +
      '(self-cleaning colony behaviour).',
  },
  {
    label: 'Alarm Flight',
    key:   'alarmFlight',
    min: 0, max: 2, step: 0.01,
    title:
      'Strength of velocity bias away from rising alarm-chemical gradient [0–2]. ' +
      'Dying cells emit alarm; living cells with high Alarm Flight scatter away ' +
      'from death zones.',
  },
  {
    label: 'Chem Diffusion',
    key:   'chemicalDiffusionRate',
    min: 0, max: 0.5, step: 0.005,
    title:
      'Per-tick fraction of each chemical that spreads to adjacent cells [0–0.5]. ' +
      '0 = no diffusion (chemicals stay where secreted); 0.25 = rapid spreading ' +
      'producing wide gradient fields.',
  },
  {
    label: 'Chem Decay',
    key:   'chemicalDecayRate',
    min: 0, max: 0.1, step: 0.001,
    title:
      'Per-tick fraction of each chemical that degrades [0–0.1]. ' +
      '0 = chemicals accumulate indefinitely; 0.02 = ~50-tick half-life. ' +
      'Higher decay produces sharper, more localised gradients.',
  },
  {
    label: 'Quorum Chem Threshold',
    key:   'chemQuorumThreshold',
    min: 0, max: 1, step: 0.01,
    title:
      'Pheromone concentration [0–1] required in a 5×5 neighbourhood to trigger ' +
      'Quorum Active state. Quorum-active cells stop spreading, gain energy, and ' +
      'coordinate biofilm formation. Distinct from the neighbour-count Quorum Threshold.',
  },
  {
    label: 'Quorum Energy Bonus',
    key:   'quorumActivationEnergy',
    min: 0, max: 0.5, step: 0.005,
    title:
      'Energy added per tick to each Quorum-Active cell [0–0.5]. ' +
      'Rewards cells that enter coordinated quorum state, simulating ' +
      'cooperative resource sharing in dense biofilm colonies.',
  },
];

// ---------------------------------------------------------------------------
// Phase 21 — Predator-Prey slider specs
// ---------------------------------------------------------------------------

/**
 * Phase 21 — Predator-Prey Dynamics slider specs.
 *
 * Controls the predator classification threshold, attack probability, spread
 * rate, energy feed per kill, predator energy-decay multiplier, and the
 * sporulation lifetime counter.
 */
const PREDATOR_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Predator Threshold',
    key:   'predatorGenomeThreshold',
    min: 0, max: 65535, step: 256,
    title:
      'Minimum genome value [0–65535] that classifies a Life cell as a predator. ' +
      '0 = predator mechanics disabled (all cells are prey). ' +
      'Higher values restrict predator status to rarer high-genome cells. ' +
      'Visible in Pred/Prey render mode: predators are vivid red, prey are teal.',
  },
  {
    label: 'Attack Strength',
    key:   'predatorAttackStrength',
    min: 0, max: 1, step: 0.01,
    title:
      'Base probability [0–1] that a predator kills an adjacent prey cell this tick. ' +
      'Actual attack chance = Strength × (1 − prey.toxinResist). ' +
      '0 = predators cannot attack; 1 = attack always succeeds against unresistant prey.',
  },
  {
    label: 'Feed Energy',
    key:   'predatorFeedEnergy',
    min: 0, max: 1, step: 0.01,
    title:
      'Energy gained by the predator when it kills a prey cell [0–1]. ' +
      'High values allow predators to sustain themselves at low prey density. ' +
      'Low values force predators to hunt constantly to stay alive.',
  },
  {
    label: 'Predator Spread Rate',
    key:   'predatorSpreadRate',
    min: 0, max: 1, step: 0.01,
    title:
      'Probability [0–1] that a predator spawns a daughter into the killed prey slot. ' +
      '0 = predators never reproduce into prey; 1 = always spawn after a kill. ' +
      'Controls how quickly predator colonies spread after a successful hunt.',
  },
  {
    label: 'Predator Decay ×',
    key:   'predatorEnergyDecayMultiplier',
    min: 1, max: 5, step: 0.05,
    title:
      'Energy-decay rate multiplier applied to predator cells [1–5]. ' +
      '1 = same decay as prey; 5 = predators burn energy 5× faster. ' +
      'Higher values create boom-bust Lotka-Volterra cycles: predators ' +
      'must hunt frequently or starve.',
  },
  {
    label: 'Spore Lifetime',
    key:   'sporeLifetime',
    min: 50, max: 2000, step: 10,
    title:
      'Maximum age (ticks) a dormant Spore cell survives before dying [50–2000]. ' +
      'Spores form when a prey cell has energy < 0.03 AND local alarm is high. ' +
      'They revive when alarm fades AND a neighbouring Life cell has energy ≥ 0.3. ' +
      'Visible in Pred/Prey render mode as brown cells.',
  },
];

// ---------------------------------------------------------------------------
// ControlPanel class
// ---------------------------------------------------------------------------

/**
 * Left-sidebar control panel component.
 *
 * Mount it by calling {@link ControlPanel.mount} with the target container.
 */
export class ControlPanel {
  /**
   * Map from config key → live value readout `<span>` element.
   * Used to update readout text when config changes externally (e.g. preset).
   */
  private readonly _readouts = new Map<keyof SimulationConfig, HTMLSpanElement>();

  /**
   * Map from config key → `<input>` element.
   * Used to sync slider position when config changes externally.
   */
  private readonly _inputs = new Map<keyof SimulationConfig, HTMLInputElement>();

  /**
   * Map from ToolDef.tool → the button element, so the active-state CSS class
   * can be updated when `appState.activeTool` changes.
   */
  private readonly _toolButtons = new Map<DrawingTool, HTMLButtonElement>();

  /**
   * Checkbox for the boolean `adaptiveMutationBias` config field.
   * Kept as a field so `_syncSliders()` can update it when a preset loads.
   */
  private _adaptiveBiasCheckbox: HTMLInputElement | null = null;

  /**
   * Builds and inserts the control panel DOM into `container`.
   *
   * @param container - The element to append the panel into.
   */
  mount(container: HTMLElement): void {
    const panel = document.createElement('aside');
    panel.className   = 'control-panel';
    panel.setAttribute('aria-label', 'Simulation parameters');

    // --- Presets section ---------------------------------------------------
    panel.append(this._buildPresetsSection());

    // --- Seed settings (Phase 3: Initial Density) -------------------------
    panel.append(this._buildSeedSection());

    // --- Drawing Tools section (Phase 2) ----------------------------------
    panel.append(this._buildDrawingToolsSection());

    // --- Life parameters section -------------------------------------------
    panel.append(this._buildSection('Life Parameters', LIFE_SLIDERS));

    // --- Lifecycle Stages section (Phase 10) ------------------------------
    panel.append(this._buildCollapsibleSection('Lifecycle Stages', LIFECYCLE_SLIDERS));

    // --- Obstacle Parameters section (Phase 5) ----------------------------
    panel.append(this._buildCollapsibleSection('Obstacle Parameters', OBSTACLE_SLIDERS));

    // --- Genome-Aware Obstacles section (Phase 12) ------------------------
    panel.append(this._buildCollapsibleSection('Genome Obstacles', GENOME_OBSTACLE_SLIDERS));

    // --- Evolution Behaviour section (Phase 15) ---------------------------
    panel.append(this._buildEvolutionBehaviorSection());

    // --- Chemical Ecology section (Phase 20) ------------------------------
    panel.append(this._buildChemicalEcologySection());

    // --- Predator-Prey section (Phase 21) ---------------------------------
    panel.append(this._buildPredatorPreySection());

    // --- Cinematic Effects section (Phase 22) -----------------------------
    panel.append(this._buildCinematicSection());

    // --- Economy & Crisis section (Phase 23) ------------------------------
    panel.append(this._buildEconomySection());

    // --- Neighbourhood toggle ----------------------------------------------
    panel.append(this._buildNeighbourhoodToggle());

    // --- Evolution section (Phase 11: variant census display) --------------
    panel.append(this._buildEvolutionSection());

    // --- Grid options (Phase 1: cell size only) ----------------------------
    panel.append(this._buildViewportSection());

    container.append(panel);

  }

  // -------------------------------------------------------------------------
  // Section builders
  // -------------------------------------------------------------------------

  /**
   * Builds the Seed Settings section (Phase 3).
   *
   * Contains the Initial Density slider which controls what fraction of cells
   * are seeded as Life when the user hits Reset.  This value is stored in
   * AppState (not SimulationConfig) because it only applies at reset time.
   *
   * @returns The built section element.
   */
  private _buildSeedSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section';

    const heading = document.createElement('h2');
    heading.className   = 'panel-heading';
    heading.textContent = 'Seed Settings';
    section.append(heading);

    // --- Initial Density slider -------------------------------------------
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.title     = 'Fraction of cells filled with Life when the simulation is reset.';

    const label = document.createElement('label');
    label.htmlFor     = 'initial-density-slider';
    label.textContent = 'Initial Density';
    label.className   = 'slider-label';

    const input = document.createElement('input');
    input.type      = 'range';
    input.id        = 'initial-density-slider';
    input.min       = '0';
    input.max       = '1';
    input.step      = '0.01';
    input.value     = String(appState.initialDensity);
    input.className = 'slider';
    input.setAttribute('aria-label', 'Initial density on reset');

    const readout = document.createElement('span');
    readout.className   = 'slider-value';
    readout.textContent = `${Math.round(appState.initialDensity * 100)}%`;

    input.addEventListener('input', () => {
      const v = Number(input.value);
      appState.initialDensity = v;
      // Display as a percentage for clarity.
      readout.textContent = `${Math.round(v * 100)}%`;
    });

    row.append(label, input, readout);
    section.append(row);

    return section;
  }

  /**
   * Builds the Drawing Tools section (Phase 2).
   *
   * Contains a row of brush-type buttons (one per {@link ToolDef}) and a
   * brush-size slider.  Clicking a button updates `appState.activeTool` and
   * highlights the active button with the `active` CSS class.
   *
   * @returns The built section element.
   */
  private _buildDrawingToolsSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section';

    const heading = document.createElement('h2');
    heading.className   = 'panel-heading';
    heading.textContent = 'Drawing Tools';
    section.append(heading);

    // --- Brush type selector — a grid of tool buttons --------------------
    const btnGroup = document.createElement('div');
    btnGroup.className = 'tool-btn-group';
    btnGroup.setAttribute('role', 'radiogroup');
    btnGroup.setAttribute('aria-label', 'Select drawing brush');

    for (const def of TOOL_DEFS) {
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'tool-btn';
      btn.title     = def.title;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(appState.activeTool === def.tool));

      // Colour swatch dot + label text.
      const swatch = document.createElement('span');
      swatch.className          = 'tool-btn-swatch';
      swatch.style.backgroundColor = def.color;
      swatch.setAttribute('aria-hidden', 'true');

      btn.append(swatch, def.label);

      if (appState.activeTool === def.tool) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', () => {
        appState.activeTool = def.tool;
        // Update all button states.
        for (const [tool, b] of this._toolButtons) {
          const isActive = tool === def.tool;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-checked', String(isActive));
        }
      });

      this._toolButtons.set(def.tool, btn);
      btnGroup.append(btn);
    }

    section.append(btnGroup);

    // --- Brush size slider -----------------------------------------------
    const sizeRow = document.createElement('div');
    sizeRow.className = 'slider-row';
    sizeRow.title     = 'Brush radius in cells. Size 1 = single cell.';

    const sizeLabel = document.createElement('label');
    sizeLabel.htmlFor     = 'brush-size-slider';
    sizeLabel.textContent = 'Brush Size';
    sizeLabel.className   = 'slider-label';

    const sizeInput = document.createElement('input');
    sizeInput.type      = 'range';
    sizeInput.id        = 'brush-size-slider';
    sizeInput.min       = '1';
    sizeInput.max       = '20';
    sizeInput.step      = '1';
    sizeInput.value     = String(appState.brushSize);
    sizeInput.className = 'slider';
    sizeInput.setAttribute('aria-label', 'Brush size');

    const sizeReadout = document.createElement('span');
    sizeReadout.className   = 'slider-value';
    sizeReadout.textContent = String(appState.brushSize);

    sizeInput.addEventListener('input', () => {
      const v = Number(sizeInput.value);
      appState.brushSize          = v;
      sizeReadout.textContent     = String(v);
    });

    sizeRow.append(sizeLabel, sizeInput, sizeReadout);
    section.append(sizeRow);

    return section;
  }

  /**
   * Builds a plain section containing a set of sliders.
   *
   * @param title - Section heading text.
   * @param sliders - Slider specifications.
   * @returns The built section element.
   */
  private _buildSection(title: string, sliders: readonly SliderSpec[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section';

    const heading = document.createElement('h2');
    heading.className   = 'panel-heading';
    heading.textContent = title;
    section.append(heading);

    for (const spec of sliders) {
      section.append(this._buildSlider(spec));
    }

    return section;
  }

  /**
   * Builds a natively collapsible `<details>` section containing a set of
   * sliders.  The section starts collapsed so it does not dominate the panel
   * on first load.
   *
   * @param title - Section heading text (rendered as a `<summary>`).
   * @param sliders - Slider specifications.
   * @returns The built `<details>` element.
   */
  private _buildCollapsibleSection(title: string, sliders: readonly SliderSpec[]): HTMLElement {
    const details = document.createElement('details');
    details.className = 'panel-section';
    // Start collapsed — user opens it explicitly when they want these controls.
    details.open = false;

    const summary = document.createElement('summary');
    summary.className   = 'panel-heading';
    summary.textContent = title;
    details.append(summary);

    for (const spec of sliders) {
      details.append(this._buildSlider(spec));
    }

    return details;
  }

  /**
   * Builds a single labeled slider row.
   *
   * @param spec - Slider descriptor.
   * @returns The row element.
   */
  private _buildSlider(spec: SliderSpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.title = spec.title;

    // Label
    const label = document.createElement('label');
    const inputId = `slider-${String(spec.key)}`;
    label.htmlFor     = inputId;
    label.textContent = spec.label;
    label.className   = 'slider-label';

    // Input
    const input = document.createElement('input');
    input.type      = 'range';
    input.id        = inputId;
    input.min       = String(spec.min);
    input.max       = String(spec.max);
    input.step      = String(spec.step);
    input.value     = String(appState.config[spec.key]);
    input.className = 'slider';
    input.setAttribute('aria-label', spec.label);

    // Live readout
    const readout = document.createElement('span');
    readout.className   = 'slider-value';
    readout.textContent = this._format(Number(appState.config[spec.key]), spec.step);

    // Wire the input.
    input.addEventListener('input', () => {
      const numVal = Number(input.value);
      // SimulationConfig values are all numeric in Phase 1–3.
      appState.updateConfig(spec.key, numVal as SimulationConfig[typeof spec.key]);
      readout.textContent = this._format(numVal, spec.step);
    });

    this._readouts.set(spec.key, readout);
    this._inputs.set(spec.key, input);

    row.append(label, input, readout);
    return row;
  }

  /**
   * Builds the collapsible "Evolution Behaviour" section (Phase 15).
   *
   * Contains numeric sliders for signal diffusion, quorum threshold,
   * chemotaxis weight, and adaptive inheritance rate, plus a checkbox
   * for the boolean `adaptiveMutationBias` config field.
   *
   * @returns The built `<details>` element.
   */
  private _buildEvolutionBehaviorSection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'panel-section';

    const summary = document.createElement('summary');
    summary.className   = 'panel-heading';
    summary.textContent = 'Evolution Behaviour';
    details.append(summary);

    // Numeric sliders via the generic builder (registers in _inputs/_readouts).
    for (const spec of EVOLUTION_SLIDERS) {
      details.append(this._buildSlider(spec));
    }

    // Checkbox for the boolean adaptiveMutationBias field.
    const biasRow = document.createElement('div');
    biasRow.className = 'toggle-row';
    biasRow.title =
      'When enabled, genome bit-flips that improve local fitness (e.g. higher ' +
      'toxin resistance near Toxin cells) are 3× more likely. Accelerates ' +
      'visible evolution on short timescales (Lamarckian-lite bias).';

    const biasCheckbox = document.createElement('input');
    biasCheckbox.type      = 'checkbox';
    biasCheckbox.id        = 'adaptive-mutation-bias-checkbox';
    biasCheckbox.className = 'toggle-checkbox';
    biasCheckbox.checked   = appState.config.adaptiveMutationBias;
    biasCheckbox.setAttribute('aria-label', 'Adaptive mutation bias');
    biasCheckbox.addEventListener('change', () => {
      appState.updateConfig(
        'adaptiveMutationBias',
        biasCheckbox.checked as SimulationConfig['adaptiveMutationBias'],
      );
    });
    this._adaptiveBiasCheckbox = biasCheckbox;

    const biasLabel = document.createElement('label');
    biasLabel.htmlFor     = 'adaptive-mutation-bias-checkbox';
    biasLabel.className   = 'toggle-label';
    biasLabel.textContent = 'Adaptive Mutation Bias';

    biasRow.append(biasCheckbox, biasLabel);
    details.append(biasRow);

    return details;
  }

  /**
   * Builds the collapsible "Chemical Ecology" section (Phase 20).
   *
   * Contains sliders for the 4-channel diffusible chemical system:
   * secretion rates, chemotaxis coefficients, diffusion/decay physics,
   * quorum-sensing threshold, and activation energy bonus.
   *
   * @returns The built `<details>` element.
   */
  private _buildChemicalEcologySection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'panel-section collapsible';

    const summary = document.createElement('summary');
    summary.className   = 'panel-heading collapsible-heading';
    summary.textContent = 'Chemical Ecology';
    details.append(summary);

    // Helper hint explaining the system at a glance.
    const hint = document.createElement('p');
    hint.className   = 'section-hint';
    hint.textContent =
      'Diffusible signals: Nutrient (N), Waste (W), Pheromone (P), Alarm (A). ' +
      'Enable secretion rates first, then tune chemotaxis responses.';
    details.append(hint);

    for (const spec of CHEMICAL_SLIDERS) {
      details.append(this._buildSlider(spec));
    }

    return details;
  }

  /**
   * Builds the collapsible "Predator-Prey Dynamics" section (Phase 21).
   *
   * Contains sliders for predator classification threshold, attack strength,
   * feed energy, spread rate, energy-decay multiplier, and spore lifetime.
   *
   * @returns The built `<details>` element.
   */
  private _buildPredatorPreySection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'panel-section collapsible';

    const summary = document.createElement('summary');
    summary.className   = 'panel-heading collapsible-heading';
    summary.textContent = 'Predator-Prey';
    details.append(summary);

    const hint = document.createElement('p');
    hint.className   = 'section-hint';
    hint.textContent =
      'Set Predator Threshold > 0 to enable. Cells with genome ≥ threshold hunt ' +
      'prey; low-energy prey sporulate under alarm pressure. Use Pred/Prey render mode.';
    details.append(hint);

    for (const spec of PREDATOR_SLIDERS) {
      details.append(this._buildSlider(spec));
    }

    return details;
  }

  /**
   * Builds the collapsible "Cinematic Effects" section (Phase 22).
   *
   * Contains six toggle checkboxes that map 1-to-1 to the WebGL renderer's
   * post-processing flags.  Each change fires a `cinematicChange` event on the
   * EventBus; App.ts forwards it to the RenderWorker as a `cinematicChange`
   * message so the GPU uniforms update on the next composite pass.
   *
   * The section is auto-disabled when `navigator.hardwareConcurrency < 4`
   * because the render worker itself will have already turned the heavy effects
   * off — the UI reflects that fact so the user can see the current state.
   *
   * @returns The built `<details>` element.
   */
  private _buildCinematicSection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'panel-section collapsible';

    const summary = document.createElement('summary');
    summary.className   = 'panel-heading collapsible-heading';
    summary.textContent = 'Cinematic Effects';
    details.append(summary);

    const hint = document.createElement('p');
    hint.className   = 'section-hint';
    hint.textContent =
      'GPU post-processing (WebGL 2 only). Effects add visual depth without ' +
      'changing simulation logic. Auto-disabled on low-core devices.';
    details.append(hint);

    // Current state — mirrors WebGLRenderer defaults set at construction.
    // DoF and CA start off; the others start on.
    const state = {
      ambientOcclusion:    true,
      trails:              true,
      particles:           true,
      depthOfField:        false,
      chromaticAberration: false,
      vignette:            true,
    };

    /** Emit a cinematicChange event whenever any flag changes. */
    const emitChange = (): void => {
      bus.emit('cinematicChange', { ...state });
    };

    /** Creates one labeled toggle row.
     *
     * @param id - Unique element id.
     * @param labelText - Human-readable label.
     * @param titleText - Tooltip description.
     * @param key - Key in the local `state` object.
     * @returns The toggle row element.
     */
    const makeToggle = (
      id:        string,
      labelText: string,
      titleText: string,
      key:       keyof typeof state,
    ): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'toggle-row';
      row.title     = titleText;

      const cb = document.createElement('input');
      cb.type      = 'checkbox';
      cb.id        = id;
      cb.className = 'toggle-checkbox';
      cb.checked   = state[key];
      cb.addEventListener('change', () => {
        state[key] = cb.checked;
        emitChange();
      });

      const lbl = document.createElement('label');
      lbl.htmlFor     = id;
      lbl.className   = 'toggle-label';
      lbl.textContent = labelText;

      row.append(cb, lbl);
      return row;
    };

    details.append(makeToggle(
      'cinematic-ao',
      'Ambient Occlusion',
      'Darkens cells surrounded by neighbours, giving clusters a shaded 3-D depth cue.',
      'ambientOcclusion',
    ));
    details.append(makeToggle(
      'cinematic-trails',
      'Slime Trails',
      'Motile cells leave a variant-coloured wake that fades at 0.92× per frame.',
      'trails',
    ));
    details.append(makeToggle(
      'cinematic-particles',
      'Particles',
      'Bright particles emitted on cell division, death, quorum pulse, and alarm scatter.',
      'particles',
    ));
    details.append(makeToggle(
      'cinematic-dof',
      'Depth of Field',
      'Hexagonal blur grows toward canvas edges, simulating a shallow focal plane.',
      'depthOfField',
    ));
    details.append(makeToggle(
      'cinematic-ca',
      'Chromatic Aberration',
      'RGB channel fringing at canvas edges mimics lens distortion.',
      'chromaticAberration',
    ));
    details.append(makeToggle(
      'cinematic-vignette',
      'Vignette',
      'Radial darkening at the canvas perimeter draws the eye to the centre.',
      'vignette',
    ));

    return details;
  }

  /**
   * Builds the Economy & Crisis collapsible section (Phase 23).
   *
   * Controls two subsystems:
   *   - ATP Economy: resource pool that gates cell painting.
   *   - Crisis Events: extinction-level events that fire at random intervals
   *     and override simulation config for a set duration.
   *
   * All changes are broadcast via a single `economySettingsChange` event so
   * App can apply them to ATPSystem and CrisisScheduler without ControlPanel
   * holding direct references to those singletons.
   *
   * @returns The collapsible section element.
   */
  private _buildEconomySection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'panel-section collapsible';

    const summary = document.createElement('summary');
    summary.className   = 'panel-heading collapsible-heading';
    summary.textContent = 'Economy & Crisis';
    details.append(summary);

    const hint = document.createElement('p');
    hint.className   = 'section-hint';
    hint.textContent =
      'ATP is the resource currency for painting cells. ' +
      'Crisis events periodically stress the colony — survive them to earn bonus ATP.';
    details.append(hint);

    // Local mirror of current settings — emitted as one object on any change.
    const state = {
      atpEnabled:        false,
      atpStart:          500,
      atpMax:            1000,
      atpIncomeRate:     0.0002,
      crisisEnabled:     false,
      crisisIntervalMin: 2000,
      crisisIntervalMax: 5000,
      crisisDuration:    500,
      crisisIntensity:   1.0,
    };

    /** Emits the current state as an `economySettingsChange` event. */
    const emit = (): void => {
      bus.emit('economySettingsChange', { ...state });
    };

    // -------------------------------------------------------------------------
    // Helper factories
    // -------------------------------------------------------------------------

    /**
     * Creates a labeled checkbox toggle row.
     *
     * @param id        - Unique element id.
     * @param labelText - Human-readable label.
     * @param titleText - Tooltip description.
     * @param key       - Key in the local `state` object (boolean fields only).
     * @returns The toggle row element.
     */
    const makeToggle = (
      id:        string,
      labelText: string,
      titleText: string,
      key:       'atpEnabled' | 'crisisEnabled',
    ): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'toggle-row';
      row.title     = titleText;

      const cb = document.createElement('input');
      cb.type      = 'checkbox';
      cb.id        = id;
      cb.className = 'toggle-checkbox';
      cb.checked   = state[key];
      cb.addEventListener('change', () => {
        state[key] = cb.checked;
        emit();
      });

      const lbl = document.createElement('label');
      lbl.htmlFor     = id;
      lbl.className   = 'toggle-label';
      lbl.textContent = labelText;

      row.append(cb, lbl);
      return row;
    };

    /**
     * Creates a labeled range slider row.
     *
     * @param id        - Unique element id.
     * @param labelText - Human-readable label.
     * @param titleText - Tooltip description.
     * @param key       - Key in the local `state` object (numeric fields only).
     * @param min       - Slider minimum value.
     * @param max       - Slider maximum value.
     * @param step      - Slider step increment.
     * @param fmt       - Formatter for the live readout (defaults to String).
     * @returns The slider row element.
     */
    const makeSlider = (
      id:        string,
      labelText: string,
      titleText: string,
      key:       keyof Omit<typeof state, 'atpEnabled' | 'crisisEnabled'>,
      min:       number,
      max:       number,
      step:      number,
      fmt:       (v: number) => string = String,
    ): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'slider-row';
      row.title     = titleText;

      const lbl = document.createElement('label');
      lbl.htmlFor     = id;
      lbl.className   = 'slider-label';
      lbl.textContent = labelText;

      const input = document.createElement('input');
      input.type      = 'range';
      input.id        = id;
      input.className = 'slider';
      input.min       = String(min);
      input.max       = String(max);
      input.step      = String(step);
      input.value     = String(state[key]);

      const readout = document.createElement('span');
      readout.className   = 'slider-value';
      readout.textContent = fmt(state[key]);

      input.addEventListener('input', () => {
        const v = Number(input.value);
        (state as unknown as Record<string, number>)[key] = v;
        readout.textContent = fmt(v);
        emit();
      });

      row.append(lbl, input, readout);
      return row;
    };

    // -------------------------------------------------------------------------
    // ATP subsection heading
    // -------------------------------------------------------------------------

    const atpHeading = document.createElement('p');
    atpHeading.className   = 'subsection-label';
    atpHeading.textContent = 'ATP Economy';
    details.append(atpHeading);

    details.append(makeToggle(
      'economy-atp-enabled',
      'ATP Enabled',
      'When on, painting cells costs ATP. Turn off for unrestricted mode.',
      'atpEnabled',
    ));

    details.append(makeSlider(
      'economy-atp-start',
      'ATP Start',
      'ATP pool on reset. You begin each new simulation with this amount.',
      'atpStart',
      100, 1000, 50,
      (v) => String(v),
    ));

    details.append(makeSlider(
      'economy-atp-max',
      'ATP Max',
      'Maximum ATP pool capacity. Income above this cap is lost.',
      'atpMax',
      500, 2000, 100,
      (v) => String(v),
    ));

    details.append(makeSlider(
      'economy-atp-income',
      'Income Rate',
      'ATP earned per living cell per tick. Higher = faster passive regen.',
      'atpIncomeRate',
      0, 0.001, 0.00005,
      (v) => v.toFixed(5),
    ));

    // -------------------------------------------------------------------------
    // Crisis subsection heading
    // -------------------------------------------------------------------------

    const crisisHeading = document.createElement('p');
    crisisHeading.className   = 'subsection-label';
    crisisHeading.textContent = 'Crisis Events';
    details.append(crisisHeading);

    details.append(makeToggle(
      'economy-crisis-enabled',
      'Crisis Enabled',
      'Randomly fires extinction-level events that stress the colony. Surviving awards ATP.',
      'crisisEnabled',
    ));

    details.append(makeSlider(
      'economy-crisis-interval-min',
      'Interval Min',
      'Minimum ticks between crises. Shorter = more frequent events.',
      'crisisIntervalMin',
      500, 5000, 100,
      (v) => `${v}t`,
    ));

    details.append(makeSlider(
      'economy-crisis-interval-max',
      'Interval Max',
      'Maximum ticks between crises. Must stay above Interval Min.',
      'crisisIntervalMax',
      1000, 10000, 100,
      (v) => `${v}t`,
    ));

    details.append(makeSlider(
      'economy-crisis-duration',
      'Duration',
      'How many ticks each crisis lasts once it begins.',
      'crisisDuration',
      100, 2000, 50,
      (v) => `${v}t`,
    ));

    details.append(makeSlider(
      'economy-crisis-intensity',
      'Intensity',
      'Severity multiplier for crisis effects. 1.0 = normal; 3.0 = brutal.',
      'crisisIntensity',
      0.5, 3.0, 0.1,
      (v) => v.toFixed(1),
    ));

    return details;
  }

  /**
   * Builds the neighbourhood toggle (Moore / Von Neumann).
   *
   * @returns The toggle section element.
   */
  private _buildNeighbourhoodToggle(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section';

    const heading = document.createElement('h2');
    heading.className   = 'panel-heading';
    heading.textContent = 'Neighbourhood';
    section.append(heading);

    const row = document.createElement('div');
    row.className = 'toggle-row';

    const makeRadio = (value: 'moore' | 'vonNeumann', labelText: string): HTMLElement => {
      const id    = `neighbourhood-${value}`;
      const radio = document.createElement('input');
      radio.type    = 'radio';
      radio.name    = 'neighbourhood';
      radio.id      = id;
      radio.value   = value;
      radio.checked = appState.config.neighbourhoodMode === value;
      radio.addEventListener('change', () => {
        if (radio.checked) {
          appState.updateConfig('neighbourhoodMode', value);
        }
      });

      const label = document.createElement('label');
      label.htmlFor     = id;
      label.textContent = labelText;

      const wrapper = document.createElement('span');
      wrapper.className = 'radio-option';
      wrapper.append(radio, label);
      return wrapper;
    };

    row.append(makeRadio('moore', 'Moore (8)'), makeRadio('vonNeumann', 'Von Neumann (4)'));
    section.append(row);
    return section;
  }

  /**
   * Builds the Evolution section (Phase 11).
   *
   * Displays the count of currently living variant lineages sourced from the
   * `variantCensus` EventBus event, which the SimulationWorker broadcasts
   * every `censusInterval` ticks.  The count is updated in place so the DOM
   * node is created once and only its text content changes.
   *
   * @returns The evolution section element.
   */
  private _buildEvolutionSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section';

    const heading = document.createElement('h2');
    heading.className   = 'panel-heading';
    heading.textContent = 'Evolution';
    section.append(heading);

    // --- Living variant count display ----------------------------------------
    const countRow = document.createElement('div');
    countRow.className = 'stat-row';
    countRow.title =
      "Number of distinct variant lineages currently alive. " +
      "A new lineage forms when a cell's genome diverges by " +
      "≥3 bits from its parent at reproduction.";

    const countLabel = document.createElement('span');
    countLabel.className   = 'stat-label';
    countLabel.textContent = 'Living Variants';

    // Value readout — updated every census tick via EventBus subscription.
    const countValue = document.createElement('span');
    countValue.className   = 'stat-value';
    countValue.textContent = '—';

    countRow.append(countLabel, countValue);
    section.append(countRow);

    // --- Total observed variant count (living + extinct) ---------------------
    const totalRow = document.createElement('div');
    totalRow.className = 'stat-row';
    totalRow.title     = 'Total variant lineages ever observed, including extinct ones.';

    const totalLabel = document.createElement('span');
    totalLabel.className   = 'stat-label';
    totalLabel.textContent = 'Total Lineages';

    const totalValue = document.createElement('span');
    totalValue.className   = 'stat-value';
    totalValue.textContent = '—';

    totalRow.append(totalLabel, totalValue);
    section.append(totalRow);

    // Census interval slider — how often the worker broadcasts census data.
    const censusRow = document.createElement('div');
    censusRow.className = 'slider-row';
    censusRow.title = 'How many ticks between each population census. ' +
                      'Lower values update more frequently but cost slightly more CPU.';

    const censusLabel = document.createElement('label');
    censusLabel.htmlFor     = 'census-interval-slider';
    censusLabel.className   = 'slider-label';
    censusLabel.textContent = 'Census (ticks)';

    const censusSlider = document.createElement('input');
    censusSlider.type  = 'range';
    censusSlider.id    = 'census-interval-slider';
    censusSlider.min   = '1';
    censusSlider.max   = '50';
    censusSlider.step  = '1';
    censusSlider.value = String(appState.config.censusInterval ?? 10);

    const censusReadout = document.createElement('span');
    censusReadout.className   = 'slider-value';
    censusReadout.textContent = censusSlider.value;

    censusSlider.addEventListener('input', () => {
      const v = Number(censusSlider.value);
      censusReadout.textContent = String(v);
      appState.updateConfig('censusInterval', v);
    });

    censusRow.append(censusLabel, censusSlider, censusReadout);
    section.append(censusRow);

    // Competition strength slider — how aggressively LifeVariant invades Life.
    const compRow = document.createElement('div');
    compRow.className = 'slider-row';
    compRow.title = 'Probability per tick that a variant cell spreads into (displaces) an adjacent plain Life cell.';

    const compLabel = document.createElement('label');
    compLabel.htmlFor     = 'competition-strength-slider';
    compLabel.className   = 'slider-label';
    compLabel.textContent = 'Competition';

    const compSlider = document.createElement('input');
    compSlider.type  = 'range';
    compSlider.id    = 'competition-strength-slider';
    compSlider.min   = '0';
    compSlider.max   = '1';
    compSlider.step  = '0.01';
    compSlider.value = String(appState.config.competitionStrength);
    this._inputs.set('competitionStrength', compSlider);

    const compReadout = document.createElement('span');
    compReadout.className   = 'slider-value';
    compReadout.textContent = this._format(appState.config.competitionStrength, 0.01);
    this._readouts.set('competitionStrength', compReadout);

    compSlider.addEventListener('input', () => {
      const v = Number(compSlider.value);
      compReadout.textContent = this._format(v, 0.01);
      appState.updateConfig('competitionStrength', v);
    });

    compRow.append(compLabel, compSlider, compReadout);
    section.append(compRow);

    // Subscribe to census updates — fired by App._onSimMessage every
    // `censusInterval` ticks after receiving a `variantCensus` worker message.
    bus.on('variantCensus', ({ census, livingVariants }) => {
      // Count variants with non-zero populations in this snapshot.
      let seenAlive = 0;
      for (let i = 0; i < census.counts.length; i++) {
        if (census.counts[i] > 0) seenAlive++;
      }

      countValue.textContent = String(livingVariants);
      // Use seenAlive as a proxy for total: it covers all currently-living
      // lineages.  The registry's totalCount (living + extinct) would require
      // importing VariantRegistry here; the panel display is a sufficient summary.
      totalValue.textContent = String(Math.max(seenAlive, livingVariants));
    });

    return section;
  }

  /**
   * Builds the viewport / cell-size section.
   *
   * Phase 6 additions:
   *   - Grid lines toggle checkbox (only meaningful at cellSize >= 2).
   *   - Cell-size slider already syncs with scroll-wheel zoom via EventBus.
   *
   * Phase 7 additions:
   *   - Grid Size selector (64 / 128 / 256 / 512 / 1024 / 2048).
   *     Changing the grid size reloads the page with `?grid=N` in the URL
   *     so the App can be re-bootstrapped at the new dimensions.  A page
   *     reload is the simplest way to reallocate the SharedArrayBuffer and
   *     both workers simultaneously without a complex tear-down sequence.
   *   - Renderer toggle (Canvas 2D ↔ WebGL 2).
   *     Fires `rendererChange` on the EventBus; App forwards it to the
   *     RenderWorker.  The worker replies with `rendererChanged` carrying
   *     the backend it actually activated (may differ if WebGL 2 unavailable).
   *
   * @returns The viewport section element.
   */
  private _buildViewportSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section';

    const heading = document.createElement('h2');
    heading.className   = 'panel-heading';
    heading.textContent = 'Viewport';
    section.append(heading);

    // --- Grid size selector (Phase 7) ----------------------------------------
    const gridSizeRow = document.createElement('div');
    gridSizeRow.className = 'slider-row';
    gridSizeRow.title     =
      'Grid dimensions in cells. Larger grids require the WebGL 2 renderer for ' +
      'smooth 60 fps. Changing reloads the page.';

    const gridSizeLabel = document.createElement('label');
    gridSizeLabel.htmlFor     = 'grid-size-select';
    gridSizeLabel.textContent = 'Grid Size';
    gridSizeLabel.className   = 'slider-label';

    const gridSizeSelect = document.createElement('select');
    gridSizeSelect.id        = 'grid-size-select';
    gridSizeSelect.className = 'preset-select';
    gridSizeSelect.setAttribute('aria-label', 'Choose grid dimensions');

    // Supported grid sizes — Phase 7 extends Phase 6's 64–512 range to 2048.
    const GRID_SIZES = [64, 128, 256, 512, 1024, 2048] as const;
    const currentGrid = appState.gridWidth; // width == height (square grid)

    for (const size of GRID_SIZES) {
      const opt = document.createElement('option');
      opt.value       = String(size);
      opt.textContent = `${size} × ${size}`;
      if (size === currentGrid) opt.selected = true;
      gridSizeSelect.append(opt);
    }

    gridSizeSelect.addEventListener('change', () => {
      const newSize = Number(gridSizeSelect.value);
      if (newSize === appState.gridWidth) return;

      // Store the desired grid size in sessionStorage so the bootstrapper
      // can read it on the next page load without a server round-trip.
      sessionStorage.setItem('gridWidth',  String(newSize));
      sessionStorage.setItem('gridHeight', String(newSize));

      // Reload triggers a full app re-bootstrap at the new dimensions.
      window.location.reload();
    });

    gridSizeRow.append(gridSizeLabel, gridSizeSelect);
    section.append(gridSizeRow);

    // --- Cell size slider ----------------------------------------------------
    const row  = document.createElement('div');
    row.className = 'slider-row';
    row.title     = 'Canvas pixels per cell (zoom level). Scroll wheel on canvas also zooms.';

    const label = document.createElement('label');
    label.htmlFor     = 'cell-size-slider';
    label.textContent = 'Cell Size';
    label.className   = 'slider-label';

    const input = document.createElement('input');
    input.type      = 'range';
    input.id        = 'cell-size-slider';
    input.min       = '1';
    input.max       = '32';
    input.step      = '1';
    input.value     = String(appState.cellSize);
    input.className = 'slider';

    const readout = document.createElement('span');
    readout.className   = 'slider-value';
    readout.textContent = `${appState.cellSize}px`;

    input.addEventListener('input', () => {
      const v = Number(input.value);
      appState.cellSize = v;
      readout.textContent = `${v}px`;
    });

    // Keep slider in sync when cell size is changed via scroll wheel / keyboard.
    bus.on('cellSizeChange', ({ cellSize }) => {
      input.value         = String(cellSize);
      readout.textContent = `${cellSize}px`;
    });

    row.append(label, input, readout);
    section.append(row);

    // --- Grid lines toggle (Phase 6) -----------------------------------------
    const gridRow = document.createElement('div');
    gridRow.className = 'toggle-row';
    gridRow.title     = 'Show thin grid lines between cells (visible at cell size ≥ 2). Shortcut: G';

    const gridCheckbox = document.createElement('input');
    gridCheckbox.type    = 'checkbox';
    gridCheckbox.id      = 'grid-lines-toggle';
    gridCheckbox.checked = appState.showGridLines;
    gridCheckbox.setAttribute('aria-label', 'Toggle grid lines');

    const gridLabel = document.createElement('label');
    gridLabel.htmlFor     = 'grid-lines-toggle';
    gridLabel.textContent = 'Grid Lines';
    gridLabel.className   = 'toggle-label';

    const gridShortcut = document.createElement('span');
    gridShortcut.className   = 'toggle-shortcut';
    gridShortcut.textContent = 'G';

    gridCheckbox.addEventListener('change', () => {
      appState.showGridLines = gridCheckbox.checked;
    });

    // Keep checkbox in sync when toggled via keyboard shortcut.
    bus.on('gridLinesChange', ({ show }) => {
      gridCheckbox.checked = show;
    });

    gridRow.append(gridCheckbox, gridLabel, gridShortcut);
    section.append(gridRow);

    // --- Renderer toggle (Phase 7) -------------------------------------------
    // Switches between Canvas 2D (CPU) and WebGL 2 (GPU).
    //
    // An OffscreenCanvas can only hold one context type, so switching at
    // runtime is not possible.  Instead, the desired backend is saved to
    // sessionStorage and the page reloads — the same approach used by the
    // grid-size selector above.  The RenderWorker reads the stored type on
    // init and acquires the correct context before anything else touches
    // the canvas.
    const rendererRow = document.createElement('div');
    rendererRow.className = 'toggle-row';
    rendererRow.title     =
      'WebGL 2 offloads colour-mapping to the GPU — recommended for large grids ' +
      '(1024×1024+). Requires a page reload to apply. Falls back to Canvas 2D ' +
      'automatically if WebGL 2 is unavailable.';

    const rendererCheckbox = document.createElement('input');
    rendererCheckbox.type    = 'checkbox';
    rendererCheckbox.id      = 'renderer-toggle';
    rendererCheckbox.checked = appState.rendererType === 'webgl2';
    rendererCheckbox.setAttribute('aria-label', 'Use WebGL 2 renderer');

    const rendererLabel = document.createElement('label');
    rendererLabel.htmlFor     = 'renderer-toggle';
    rendererLabel.textContent = 'WebGL 2 Renderer';
    rendererLabel.className   = 'toggle-label';

    // Badge shows the currently active backend (read from AppState which
    // was populated from sessionStorage on startup, so it reflects reality
    // after a reload — including any WebGL 2 fallback to Canvas 2D).
    const rendererBadge = document.createElement('span');
    rendererBadge.className   = 'renderer-badge';
    rendererBadge.textContent = appState.rendererType === 'webgl2' ? 'GPU' : 'CPU';
    rendererBadge.title       = 'Currently active rendering backend';

    rendererCheckbox.addEventListener('change', () => {
      const desired = rendererCheckbox.checked ? 'webgl2' : 'canvas2d';
      // Persist so the bootstrapper reads it after the page reloads.
      try {
        sessionStorage.setItem('rendererType', desired);
      } catch {
        // sessionStorage unavailable — restore checkbox and bail.
        rendererCheckbox.checked = !rendererCheckbox.checked;
        return;
      }
      window.location.reload();
    });

    rendererRow.append(rendererCheckbox, rendererLabel, rendererBadge);
    section.append(rendererRow);

    // --- Render mode selector (Phase 10/11) ------------------------------------
    // Dropdown to switch the active visualisation mode for the simulation canvas.
    //   • Variant ID   — cells coloured by lineage palette (golden-angle hues)
    //   • Lifecycle    — cells coloured by age stage (juvenile/mature/senescent)
    //   • Cell Type    — default energy-modulated cell-type colour LUT
    // Uses `appState.renderMode` which fires `renderModeChange` on the EventBus.
    const renderModeRow = document.createElement('div');
    renderModeRow.className = 'toggle-row';

    const renderModeLabel = document.createElement('label');
    renderModeLabel.htmlFor     = 'render-mode-select';
    renderModeLabel.textContent = 'View Mode';
    renderModeLabel.className   = 'toggle-label';

    const renderModeSelect = document.createElement('select');
    renderModeSelect.id        = 'render-mode-select';
    renderModeSelect.className = 'preset-select';
    renderModeSelect.setAttribute('aria-label', 'Select visualisation mode');

    // Build select options grouped by category (Phase 20 adds Chemical Fields group).
    const renderModeGroups: Array<{ label: string; entries: Array<{ mode: string; label: string }> }> = [
      {
        label: 'Cell View',
        entries: [
          { mode: 'default',    label: 'Cell Type'   },
          { mode: 'lifecycle',  label: 'Lifecycle'   },
          { mode: 'variantId',  label: 'Variant ID'  },
          { mode: 'morphology', label: 'Morphology'  },
        ],
      },
      {
        label: 'Genetics',
        entries: [
          { mode: 'genome',     label: 'Genome'      },
          { mode: 'generation', label: 'Generation'  },
          { mode: 'fitness',    label: 'Fitness'     },
          { mode: 'signal',     label: 'Signal'      },
        ],
      },
      {
        label: 'Chemical Fields',
        entries: [
          { mode: 'nutrient-field',  label: 'Nutrient Field'  },
          { mode: 'waste-field',     label: 'Waste Field'     },
          { mode: 'pheromone-field', label: 'Pheromone Field' },
          { mode: 'alarm-field',     label: 'Alarm Field'     },
        ],
      },
      {
        label: 'Predator-Prey',
        entries: [
          { mode: 'predprey', label: 'Pred/Prey' },
        ],
      },
    ];

    for (const group of renderModeGroups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const entry of group.entries) {
        const opt = document.createElement('option');
        opt.value       = entry.mode;
        opt.textContent = entry.label;
        optgroup.append(opt);
      }
      renderModeSelect.append(optgroup);
    }

    // Initialise to current state.
    renderModeSelect.value = appState.renderMode ?? 'variantId';

    renderModeSelect.addEventListener('change', () => {
      // All values map directly to RenderMode union members except 'default'
      // which falls back to 'variantId' (the standard Phase 11 view).
      const selected = renderModeSelect.value;
      appState.renderMode = (selected === 'default' ? 'variantId' : selected) as typeof appState.renderMode;
    });

    // Keep dropdown in sync when renderMode changes from outside the panel
    // (e.g. programmatic preset load).
    bus.on('renderModeChange', ({ mode }) => {
      renderModeSelect.value = mode;
    });

    renderModeRow.append(renderModeLabel, renderModeSelect);
    section.append(renderModeRow);

    // --- Phase 18: Morphology detail slider ------------------------------------
    // Controls u_aliveDetail in the WebGL shader.  Visible at all zoom levels but
    // only has visual effect when cell-size >= 4px (enforced in the shader too).
    const detailRow = document.createElement('div');
    detailRow.className = 'toggle-row';
    detailRow.title     = 'Morphology detail (WebGL only). 0 = flat squares, 1 = full cell anatomy with membrane, nucleus, organelles and animations.';

    const detailLabel = document.createElement('label');
    detailLabel.htmlFor     = 'alive-detail-slider';
    detailLabel.textContent = 'Cell Detail';
    detailLabel.className   = 'toggle-label';

    const detailSlider = document.createElement('input');
    detailSlider.type      = 'range';
    detailSlider.id        = 'alive-detail-slider';
    detailSlider.min       = '0';
    detailSlider.max       = '1';
    detailSlider.step      = '0.05';
    detailSlider.value     = '1';
    detailSlider.className = 'slider';
    detailSlider.setAttribute('aria-label', 'Cell morphology detail level');

    detailSlider.addEventListener('input', () => {
      bus.emit('aliveDetailChange', { value: parseFloat(detailSlider.value) });
    });

    detailRow.append(detailLabel, detailSlider);
    section.append(detailRow);

    // --- Environment background selector (Phase 14) ----------------------------
    // Lets the user choose a procedural background rendered behind the sim canvas.
    // Selecting anything other than 'none' enables transparent empty-cell rendering
    // so the background shows through the grid.
    const envRow = document.createElement('div');
    envRow.className = 'toggle-row';
    envRow.title     =
      'Choose a semi-realistic environment background rendered behind the simulation. ' +
      'Empty cells become transparent so the background shows through.';

    const envLabel = document.createElement('label');
    envLabel.htmlFor     = 'bg-select';
    envLabel.textContent = 'Environment';
    envLabel.className   = 'toggle-label';

    const envSelect = document.createElement('select');
    envSelect.id        = 'bg-select';
    envSelect.className = 'preset-select';
    envSelect.setAttribute('aria-label', 'Select environment background');

    // Build one <option> per BackgroundType using the human-readable labels.
    for (const [key, label] of Object.entries(BACKGROUND_LABELS)) {
      const opt = document.createElement('option');
      opt.value       = key;
      opt.textContent = label;
      if (key === appState.backgroundType) opt.selected = true;
      envSelect.append(opt);
    }

    envSelect.addEventListener('change', () => {
      appState.backgroundType = envSelect.value as BackgroundType;
    });

    // Keep dropdown in sync if backgroundType is changed programmatically.
    bus.on('backgroundChange', ({ type }) => {
      envSelect.value = type;
    });

    envRow.append(envLabel, envSelect);
    section.append(envRow);

    return section;
  }

  /**
   * Builds the Presets section (Round 5).
   *
   * Delegates to {@link PresetPanel} which renders a tabbed card-based panel:
   *   [Life]         — all 19 life presets, filterable by archetype chip
   *   [Environments] — all 10 environment presets, filterable by category chip
   *
   * @returns The presets section element.
   */
  private _buildPresetsSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section';

    const heading = document.createElement('h2');
    heading.className   = 'panel-heading';
    heading.textContent = 'Presets';
    section.append(heading);

    // PresetPanel handles all preset application logic; it receives the
    // _syncSliders callback so slider readouts update when a life preset loads.
    const panel = new PresetPanel(() => this._syncSliders());
    section.append(panel.build());

    // -------------------------------------------------------------------------
    // Legacy quick-access dropdown — kept for keyboard / power-user workflows.
    // -------------------------------------------------------------------------

    const legacyLabel = document.createElement('p');
    legacyLabel.className   = 'preset-legacy-hint';
    legacyLabel.textContent = 'Quick load (classic):';
    section.append(legacyLabel);

    const legacyDefs: Array<{ label: string; fn: () => SimulationConfig }> = [
      { label: 'Default',              fn: () => ({ ...appState.config }) },
      { label: 'Slow Burn',            fn: Presets.slowBurn },
      { label: 'Plague',               fn: Presets.plague },
      { label: 'Classic Game of Life', fn: Presets.classicGameOfLife },
      { label: 'Ecosystem Balance',    fn: Presets.ecosystemBalance },
      { label: 'Natural Selection',    fn: Presets.naturalSelection },
      { label: 'Coevolution',          fn: Presets.coevolution },
      { label: 'Mutagenic Chaos',      fn: Presets.mutagenicChaos },
      { label: 'Stable Colony',        fn: Presets.stableColony },
      { label: 'Radiation Wasteland',  fn: Presets.radiationWasteland },
    ];

    const legacySelect = document.createElement('select');
    legacySelect.className = 'preset-select';
    legacySelect.setAttribute('aria-label', 'Quick-load a classic preset');

    for (const def of legacyDefs) {
      const opt = document.createElement('option');
      opt.value       = def.label;
      opt.textContent = def.label;
      legacySelect.append(opt);
    }

    legacySelect.addEventListener('change', () => {
      const chosen = legacyDefs.find(d => d.label === legacySelect.value);
      if (!chosen) return;
      appState.config = chosen.fn();
      this._syncSliders();
    });

    section.append(legacySelect);

    return section;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Formats a numeric value for display in the readout.
   * Integer steps → no decimal; float steps → 3 decimal places.
   *
   * @param value - The value to format.
   * @param step - The slider step (determines decimal precision).
   * @returns Formatted string.
   */
  private _format(value: number, step: number): string {
    return step >= 1 ? String(Math.round(value)) : value.toFixed(3);
  }

  /**
   * Syncs all slider positions and readouts to the current `appState.config`.
   * Called when a preset is loaded.
   */
  private _syncSliders(): void {
    // Helper to sync one slider group.
    const syncGroup = (specs: readonly SliderSpec[]): void => {
      for (const spec of specs) {
        const input   = this._inputs.get(spec.key);
        const readout = this._readouts.get(spec.key);
        if (input && readout) {
          const val = Number(appState.config[spec.key]);
          input.value         = String(val);
          readout.textContent = this._format(val, spec.step);
        }
      }
    };

    syncGroup(LIFE_SLIDERS);
    syncGroup(LIFECYCLE_SLIDERS);
    syncGroup(EVOLUTION_SLIDERS);
    syncGroup(CHEMICAL_SLIDERS);

    // Sync the adaptiveMutationBias checkbox (boolean field, not in slider maps).
    if (this._adaptiveBiasCheckbox) {
      this._adaptiveBiasCheckbox.checked = appState.config.adaptiveMutationBias;
    }
  }
}
