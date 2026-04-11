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
 * Slider changes call `appState.updateConfig(key, value)` which fires the
 * `configChange` event consumed by the simulation engine on the next tick.
 */

import { appState, type DrawingTool } from '../state/AppState.js';
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
    title: 'Probability per tick that a cell mutates into Life Variant B.',
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

    // --- Drawing Tools section (Phase 2) ----------------------------------
    panel.append(this._buildDrawingToolsSection());

    // --- Life parameters section -------------------------------------------
    panel.append(this._buildSection('Life Parameters', LIFE_SLIDERS));

    // --- Neighbourhood toggle ----------------------------------------------
    panel.append(this._buildNeighbourhoodToggle());

    // --- Grid options (Phase 1: cell size only) ----------------------------
    panel.append(this._buildViewportSection());

    container.append(panel);
  }

  // -------------------------------------------------------------------------
  // Section builders
  // -------------------------------------------------------------------------

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
      // SimulationConfig values are all numeric in Phase 1.
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

    const spec: SliderSpec = {
      label: 'Cell Size',
      key:   'initialEnergy', // placeholder — handled separately below
      min: 1, max: 8, step: 1,
      title: 'Canvas pixels per cell (zoom level).',
    };

    // Build a custom non-config slider for cellSize.
    const row  = document.createElement('div');
    row.className = 'slider-row';
    row.title     = spec.title;

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
    for (const spec of LIFE_SLIDERS) {
      const val = Number(appState.config[spec.key]);
      this._inputs.get(spec.key)!.value = String(val);
      this._readouts.get(spec.key)!.textContent = this._format(val, spec.step);
    }
  }
}
