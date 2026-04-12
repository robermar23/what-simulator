/**
 * @fileoverview Application state for the What Simulator.
 *
 * `AppState` is the single source of truth for all non-simulation state:
 * whether the sim is running, current tick rate, grid size, cell size, and
 * active drawing tool.  Simulation parameters live in `SimulationConfig`.
 *
 * State is mutated via typed setters that automatically fire events on the
 * shared {@link EventBus} so all subscribers stay in sync.
 */

import { bus } from './EventBus.js';
import {
  defaultConfig,
  type SimulationConfig,
} from '../simulation/config/SimulationConfig.js';
import { type RendererType } from '../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// Drawing tool enum
// ---------------------------------------------------------------------------

/**
 * The currently selected brush tool.
 * Phase 1 only uses Life and Erase; all other types reserved for Phase 2+.
 */
export type DrawingTool =
  | 'life'
  | 'wall'
  | 'toxin'
  | 'nutrient'
  | 'drain'
  | 'gravityWell'
  | 'barrier'
  | 'fire'
  | 'ice'
  | 'erase';

// ---------------------------------------------------------------------------
// AppState class
// ---------------------------------------------------------------------------

/**
 * Observable application state container.
 *
 * All mutations go through setters so the EventBus is always notified.
 * Components should read state on startup and subscribe to relevant events
 * rather than polling this object.
 */
export class AppState {
  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Reads a grid dimension from `sessionStorage`, validating it against
   * the allowed sizes from Phase 7's grid-size selector.
   *
   * The ControlPanel stores the user's chosen grid size in `sessionStorage`
   * before reloading the page.  On reload `AppState` reads this value to
   * bootstrap the workers at the correct dimensions.
   *
   * Falls back to `defaultValue` if the key is absent or the stored value is
   * not one of the allowed sizes.
   *
   * @param key          - `sessionStorage` key (`'gridWidth'` or `'gridHeight'`).
   * @param defaultValue - Fallback dimension in cells.
   * @returns Validated grid dimension in cells.
   */
  /**
   * Reads the desired rendering backend from `sessionStorage.rendererType`.
   * Written by the ControlPanel renderer toggle before a page reload.
   * Falls back to `'canvas2d'` if absent or invalid.
   *
   * @returns The stored `RendererType`, or `'canvas2d'` as the safe default.
   */
  private static _readRendererType(): RendererType {
    try {
      const raw = sessionStorage.getItem('rendererType');
      if (raw === 'webgl2' || raw === 'canvas2d') return raw;
    } catch {
      // sessionStorage may be unavailable in sandboxed contexts.
    }
    return 'canvas2d';
  }

  private static _readGridDim(key: string, defaultValue: number): number {
    const ALLOWED = new Set([64, 128, 256, 512, 1024, 2048]);
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) {
        const parsed = parseInt(raw, 10);
        if (ALLOWED.has(parsed)) return parsed;
      }
    } catch {
      // sessionStorage may throw in private-browsing modes or sandboxed iframes.
    }
    return defaultValue;
  }

  // --- Simulation control ---------------------------------------------------

  /** True while the simulation tick loop is active. */
  private _running = false;

  /** Simulation tick rate in Hz (ticks per second). */
  private _hz = 30;

  // --- Grid settings --------------------------------------------------------

  /**
   * Grid width in cells.
   * Default 256; overridden by `sessionStorage.gridWidth` when the user
   * selects a different grid size in the Viewport section (Phase 7).
   */
  private _gridWidth: number = AppState._readGridDim('gridWidth', 256);

  /**
   * Grid height in cells.
   * Default 256; overridden by `sessionStorage.gridHeight` when the user
   * selects a different grid size in the Viewport section (Phase 7).
   */
  private _gridHeight: number = AppState._readGridDim('gridHeight', 256);

  /** Canvas pixels per cell. */
  private _cellSize = 2;

  // --- Simulation parameters ------------------------------------------------

  /** Current simulation config.  Mutated when sliders change. */
  private _config: SimulationConfig = defaultConfig();

  // --- UI state -------------------------------------------------------------

  /** Currently selected drawing tool. */
  private _activeTool: DrawingTool = 'life';

  /** Brush size in cells (1–20). */
  private _brushSize = 1;

  /**
   * Fraction of cells seeded as Life on Reset.
   * Range: [0, 1].  Default: 0.3 (30%).
   * Changing this has no immediate effect — it is read the next time
   * {@link App.reset} is called.
   */
  private _initialDensity = 0.3;

  /**
   * Whether the grid-line overlay is currently visible.
   * Grid lines are thin cell-boundary lines drawn over the simulation canvas.
   * Only meaningful when `cellSize` >= 2 (at 1 px per cell the lines obscure cells).
   * Phase 6.
   */
  private _showGridLines = false;

  /**
   * Which rendering backend is active.
   * - `'canvas2d'` — CPU `ImageData` pixel write (default, always available).
   * - `'webgl2'`   — GPU WebGL 2 fragment shader (Phase 7, requires WebGL 2).
   *
   * Read from `sessionStorage.rendererType` on startup (written by the
   * ControlPanel renderer toggle before a page reload, the same pattern used
   * by the grid-size selector).
   *
   * Runtime switching is not possible because an `OffscreenCanvas` can hold
   * only one context type.  Changing the renderer type triggers a page reload
   * so the RenderWorker re-initialises with the new context from scratch.
   */
  private _rendererType: RendererType = AppState._readRendererType();

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  /** Whether the simulation is running. */
  get running(): boolean { return this._running; }

  /** Simulation tick rate in Hz. */
  get hz(): number { return this._hz; }

  /** Grid width in cells. */
  get gridWidth(): number { return this._gridWidth; }

  /** Grid height in cells. */
  get gridHeight(): number { return this._gridHeight; }

  /** Canvas pixels per cell. */
  get cellSize(): number { return this._cellSize; }

  /** Current simulation config (mutable reference — don't share externally). */
  get config(): SimulationConfig { return this._config; }

  /** Currently selected drawing tool. */
  get activeTool(): DrawingTool { return this._activeTool; }

  /** Brush radius in cells. */
  get brushSize(): number { return this._brushSize; }

  /**
   * Fraction of cells seeded as Life on Reset [0, 1].
   * Read by {@link App} each time the grid is re-seeded.
   */
  get initialDensity(): number { return this._initialDensity; }

  /**
   * Whether the grid-line overlay is currently visible.
   * Phase 6.
   */
  get showGridLines(): boolean { return this._showGridLines; }

  /**
   * Which rendering backend is currently active.
   * Phase 7.
   */
  get rendererType(): RendererType { return this._rendererType; }

  // -------------------------------------------------------------------------
  // Setters (fire events)
  // -------------------------------------------------------------------------

  /**
   * Starts or pauses the simulation.
   *
   * @param value - True to run; false to pause.
   */
  set running(value: boolean) {
    if (this._running === value) return;
    this._running = value;
    bus.emit('playStateChange', { running: value });
  }

  /**
   * Changes the tick rate.
   *
   * @param value - New tick rate in Hz (1–60).
   */
  set hz(value: number) {
    const clamped = Math.max(1, Math.min(60, value));
    if (this._hz === clamped) return;
    this._hz = clamped;
    bus.emit('speedChange', { hz: clamped });
  }

  /**
   * Changes the canvas cell size (pixels per cell).
   *
   * @param value - New cell size (1–8).
   */
  set cellSize(value: number) {
    const clamped = Math.max(1, Math.min(8, value));
    if (this._cellSize === clamped) return;
    this._cellSize = clamped;
    bus.emit('cellSizeChange', { cellSize: clamped });
  }

  /**
   * Replaces the entire simulation config and notifies subscribers.
   *
   * @param config - New config object.
   */
  set config(config: SimulationConfig) {
    this._config = config;
    bus.emit('configChange', { config });
  }

  /**
   * Updates a single field in the simulation config.
   * More efficient than replacing the whole object when a slider changes.
   *
   * @param key - Config key to update.
   * @param value - New value.
   */
  updateConfig<K extends keyof SimulationConfig>(
    key: K,
    value: SimulationConfig[K],
  ): void {
    this._config[key] = value;
    bus.emit('configChange', { config: this._config });
  }

  /**
   * Changes the active drawing tool.
   *
   * @param tool - Tool name.
   */
  set activeTool(tool: DrawingTool) {
    this._activeTool = tool;
  }

  /**
   * Changes the brush size.
   *
   * @param size - Brush radius in cells (1–20).
   */
  set brushSize(size: number) {
    this._brushSize = Math.max(1, Math.min(20, size));
  }

  /**
   * Sets the initial seed density for the next Reset.
   * Clamped to [0, 1].
   *
   * @param value - Density fraction (0 = empty board, 1 = fully seeded).
   */
  set initialDensity(value: number) {
    this._initialDensity = Math.max(0, Math.min(1, value));
  }

  /**
   * Toggles the grid-line overlay and notifies subscribers.
   * Grid lines are only visually meaningful when `cellSize` >= 2.
   *
   * @param value - True to show grid lines; false to hide.
   */
  set showGridLines(value: boolean) {
    if (this._showGridLines === value) return;
    this._showGridLines = value;
    bus.emit('gridLinesChange', { show: value });
  }

}

/** Singleton app state — the whole app shares one instance. */
export const appState = new AppState();
