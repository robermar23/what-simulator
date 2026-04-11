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
 * Slider changes call `appState.updateConfig(key, value)` which fires the
 * `configChange` event consumed by the simulation engine on the next tick.
 */

import { appState, type DrawingTool } from '../state/AppState.js';
import { bus } from '../state/EventBus.js';
import { type SimulationConfig } from '../simulation/config/SimulationConfig.js';
import { Presets } from '../simulation/config/SimulationConfig.js';

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

/** Phase 2 brush tool definitions. */
const TOOL_DEFS: readonly ToolDef[] = [
  {
    tool: 'life',     label: 'Life',
    color: '#00ff88',
    title: 'Paint life cells that spread and expand.',
  },
  {
    tool: 'wall',     label: 'Wall',
    color: '#3a3a3a',
    title: 'Impassable barrier — life cannot spread through walls.',
  },
  {
    tool: 'toxin',    label: 'Toxin',
    color: '#cc00ff',
    title: 'Damages adjacent life cells each tick; life entering a toxin cell loses energy.',
  },
  {
    tool: 'nutrient', label: 'Nutrient',
    color: '#00cc44',
    title: 'Boosts adjacent life energy each tick; depletes over time.',
  },
  {
    tool: 'erase',    label: 'Erase',
    color: '#555577',
    title: 'Remove cells (right-click on canvas also erases).',
  },
];

// ---------------------------------------------------------------------------
// Slider spec definitions
// ---------------------------------------------------------------------------

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
    label: 'Mutation Rate',
    key:   'mutationRate',
    min: 0, max: 0.1, step: 0.001,
    title: 'Probability per tick that a Life cell mutates into Variant B (yellow).',
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
 * Phase 3 — Life Variant B slider specs.
 * These control the independent parameters for mutated (LifeVariant) cells.
 */
const VARIANT_SLIDERS: readonly SliderSpec[] = [
  {
    label: 'Spread Rate',
    key:   'variantSpreadRate',
    min: 0, max: 1, step: 0.01,
    title: 'Spread probability for Variant B cells — can differ from Life A.',
  },
  {
    label: 'Energy Decay',
    key:   'variantEnergyDecayRate',
    min: 0, max: 0.1, step: 0.001,
    title: 'Metabolic cost per tick for Variant B.',
  },
  {
    label: 'Repro. Threshold',
    key:   'variantReproductionThreshold',
    min: 0, max: 1, step: 0.01,
    title: 'Minimum energy for Variant B to reproduce.',
  },
  {
    label: 'Initial Energy',
    key:   'variantInitialEnergy',
    min: 0, max: 1, step: 0.01,
    title: 'Starting energy for newly born Variant B cells.',
  },
  {
    label: 'Competition',
    key:   'competitionStrength',
    min: 0, max: 1, step: 0.01,
    title: 'Probability per tick that Variant B spreads into (kills) an adjacent Life A cell.',
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
   * The Life Variant B collapsible section element.
   * Hidden until at least one variant cell exists.
   */
  private _variantSection: HTMLElement | null = null;

  /**
   * Badge element inside the variant section heading that shows variant count.
   */
  private _variantBadge: HTMLSpanElement | null = null;

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

    // --- Life Variant B section (Phase 3: collapsible, hidden initially) --
    const variantSection = this._buildVariantSection();
    this._variantSection = variantSection;
    panel.append(variantSection);

    // --- Neighbourhood toggle ----------------------------------------------
    panel.append(this._buildNeighbourhoodToggle());

    // --- Grid options (Phase 1: cell size only) ----------------------------
    panel.append(this._buildViewportSection());

    container.append(panel);

    // Subscribe to fpsUpdate so the variant section can be shown/hidden as
    // soon as variants appear.  Fires at ~4 Hz — cheap enough.
    bus.on('fpsUpdate', ({ variantCells }) => {
      this._updateVariantSectionVisibility(variantCells);
    });
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
   * Builds the Life Variant B collapsible section (Phase 3).
   *
   * Initially hidden (via the `hidden` attribute).  Shown when the
   * {@link fpsUpdate} event reports `variantCells > 0`.  Uses a
   * `<details>/<summary>` element so the user can collapse it even after
   * it appears.
   *
   * The heading badge shows the live Variant B cell count.
   *
   * @returns The built section element (initially hidden).
   */
  private _buildVariantSection(): HTMLElement {
    // Use a <details> element for native browser collapsing behaviour.
    const details = document.createElement('details');
    details.className = 'panel-section variant-section';
    // Open by default when first revealed so the user notices it.
    details.open = true;
    // Hidden until variants are detected.
    details.hidden = true;

    // Summary acts as the clickable heading / toggle.
    const summary = document.createElement('summary');
    summary.className = 'panel-heading variant-heading';

    const headingText = document.createElement('span');
    headingText.textContent = 'Life Variant B';

    // Badge showing the live variant count (e.g. "1 234").
    const badge = document.createElement('span');
    badge.className   = 'variant-badge';
    badge.textContent = '0';
    badge.setAttribute('aria-label', 'Variant B cell count');
    this._variantBadge = badge;

    summary.append(headingText, badge);
    details.append(summary);

    // Description blurb so first-time users understand what they are seeing.
    const blurb = document.createElement('p');
    blurb.className   = 'variant-blurb';
    blurb.textContent =
      'Mutated Life cells (yellow). Adjust their independent parameters ' +
      'or use Competition to control how aggressively they displace Life A.';
    details.append(blurb);

    // Sliders for all Variant B parameters.
    for (const spec of VARIANT_SLIDERS) {
      details.append(this._buildSlider(spec));
    }

    return details;
  }

  /**
   * Shows or hides the Life Variant B section and updates its badge count.
   *
   * Called each time an `fpsUpdate` event fires (~4 Hz).
   *
   * @param variantCells - Current number of LifeVariant cells.
   */
  private _updateVariantSectionVisibility(variantCells: number): void {
    if (!this._variantSection) return;

    if (variantCells > 0) {
      // Reveal the section the first time variants appear.
      this._variantSection.hidden = false;
    }

    // Always update the badge so the user can watch the colony grow / shrink.
    if (this._variantBadge) {
      this._variantBadge.textContent = variantCells.toLocaleString();
    }
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
   * Builds a collapsible section containing a set of sliders.
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
   * Builds the viewport / cell-size section.
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

    // Build a custom non-config slider for cellSize.
    const row  = document.createElement('div');
    row.className = 'slider-row';
    row.title     = 'Canvas pixels per cell (zoom level).';

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

    row.append(label, input, readout);
    section.append(row);
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
      { label: 'Default',             fn: () => ({ ...appState.config }) },
      { label: 'Slow Burn',           fn: Presets.slowBurn },
      { label: 'Plague',              fn: Presets.plague },
      { label: 'Classic Game of Life', fn: Presets.classicGameOfLife },
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
    // Sync Variant B sliders.
    for (const spec of VARIANT_SLIDERS) {
      const input   = this._inputs.get(spec.key);
      const readout = this._readouts.get(spec.key);
      if (input && readout) {
        const val = Number(appState.config[spec.key]);
        input.value          = String(val);
        readout.textContent  = this._format(val, spec.step);
      }
    }
  }
}
