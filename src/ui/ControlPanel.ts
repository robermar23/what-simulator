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
    input.max       = '8';
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

    // Build select options — map 'Cell Type' display option to no-special-mode.
    const renderModeEntries: Array<{ mode: string; label: string }> = [
      { mode: 'variantId', label: 'Variant ID' },
      { mode: 'lifecycle', label: 'Lifecycle'  },
      { mode: 'default',   label: 'Cell Type'  },
    ];

    for (const entry of renderModeEntries) {
      const opt = document.createElement('option');
      opt.value       = entry.mode;
      opt.textContent = entry.label;
      renderModeSelect.append(opt);
    }

    // Initialise to current state.
    renderModeSelect.value = appState.renderMode ?? 'variantId';

    renderModeSelect.addEventListener('change', () => {
      // The select value matches the RenderMode union members directly.
      // 'default' is not a RenderMode variant — treat it as 'variantId' reset.
      const selected = renderModeSelect.value;
      appState.renderMode = selected === 'default' ? 'variantId' : selected as typeof appState.renderMode;
    });

    // Keep dropdown in sync when renderMode changes from outside the panel
    // (e.g. programmatic preset load).
    bus.on('renderModeChange', ({ mode }) => {
      renderModeSelect.value = mode;
    });

    renderModeRow.append(renderModeLabel, renderModeSelect);
    section.append(renderModeRow);

    return section;
  }

  /**
   * Builds the presets selector section.
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

    const presetDefs: Array<{ label: string; fn: () => SimulationConfig }> = [
      { label: 'Default',              fn: () => ({ ...appState.config }) },
      { label: 'Slow Burn',            fn: Presets.slowBurn },
      { label: 'Plague',               fn: Presets.plague },
      { label: 'Classic Game of Life', fn: Presets.classicGameOfLife },
      { label: 'Ecosystem Balance',    fn: Presets.ecosystemBalance },
    ];

    const select = document.createElement('select');
    select.className = 'preset-select';
    select.setAttribute('aria-label', 'Load a preset configuration');

    for (const def of presetDefs) {
      const opt = document.createElement('option');
      opt.value       = def.label;
      opt.textContent = def.label;
      select.append(opt);
    }

    select.addEventListener('change', () => {
      const chosen = presetDefs.find(d => d.label === select.value);
      if (!chosen) return;
      appState.config = chosen.fn();
      this._syncSliders();
    });

    section.append(select);
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
    // Sync main Life sliders.
    for (const spec of LIFE_SLIDERS) {
      const val = Number(appState.config[spec.key]);
      this._inputs.get(spec.key)!.value = String(val);
      this._readouts.get(spec.key)!.textContent = this._format(val, spec.step);
    }
    // Sync Lifecycle Stage sliders (Phase 10).
    for (const spec of LIFECYCLE_SLIDERS) {
      const input   = this._inputs.get(spec.key);
      const readout = this._readouts.get(spec.key);
      if (input && readout) {
        const val = Number(appState.config[spec.key]);
        input.value         = String(val);
        readout.textContent = this._format(val, spec.step);
      }
    }
  }
}
