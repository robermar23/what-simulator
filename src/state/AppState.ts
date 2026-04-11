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
  // --- Simulation control ---------------------------------------------------

  /** True while the simulation tick loop is active. */
  private _running = false;

  /** Simulation tick rate in Hz (ticks per second). */
  private _hz = 30;

  // --- Grid settings --------------------------------------------------------

  /** Grid width in cells. */
  private _gridWidth  = 256;

  /** Grid height in cells. */
  private _gridHeight = 256;

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
}

/** Singleton app state — the whole app shares one instance. */
export const appState = new AppState();
