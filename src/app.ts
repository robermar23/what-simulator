/**
 * @fileoverview Top-level application orchestrator for the What Simulator.
 *
 * `App` owns:
 *   - The `GridState` (double-buffered cell arrays).
 *   - The `SimulationEngine` (pure tick logic).
 *   - The `Renderer` (ImageData pixel pipeline).
 *   - The simulation interval and the render `requestAnimationFrame` loop.
 *
 * It wires the EventBus to respond to Play/Pause, Reset, Speed, and CellSize
 * events fired by the UI components.
 *
 * Phase 1 runs everything on the main thread.  Phase 4 will move the
 * simulation into a Web Worker; only this file and `workerBridge.ts` will
 * need significant changes.
 */

import { GridState } from './simulation/GridState.js';
import { SimulationEngine, type TickStats } from './simulation/SimulationEngine.js';
import { Renderer } from './rendering/Renderer.js';
import { appState } from './state/AppState.js';
import { bus } from './state/EventBus.js';
import { FpsCounter, TickCounter } from './utils/performance.js';

// ---------------------------------------------------------------------------
// App class
// ---------------------------------------------------------------------------

/**
 * Main application controller.  Instantiate once and call {@link App.start}.
 */
export class App {
  // --- Simulation core -------------------------------------------------------

  /** Current grid state (double-buffered). */
  private _grid: GridState;

  /** Tick logic engine (pure functions over TypedArrays). */
  private _engine: SimulationEngine;

  // --- Rendering -------------------------------------------------------------

  /** ImageData pixel renderer. */
  private _renderer: Renderer;

  // The canvas element is kept so Phase 6 pan/zoom can attach pointer events.
  readonly canvas: HTMLCanvasElement;

  // --- Loop handles ----------------------------------------------------------

  /**
   * ID returned by `setInterval` for the simulation tick loop.
   * Stored so we can cancel it on pause or speed change.
   */
  private _tickIntervalId: ReturnType<typeof setInterval> | null = null;

  /** RAF handle for the render loop. */
  private _rafId: number | null = null;

  // --- Counters --------------------------------------------------------------

  /** FPS smoothing counter (render loop). */
  private readonly _fpsCounter = new FpsCounter(60);

  /** Monotonic tick counter. */
  private readonly _tickCounter = new TickCounter();

  /**
   * @param canvas - The `<canvas>` element to render into.
   */
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // Allocate grid at the dimensions stored in AppState.
    this._grid = new GridState(appState.gridWidth, appState.gridHeight);

    // Allocate engine with the same dimensions.
    this._engine = new SimulationEngine(appState.gridWidth, appState.gridHeight);

    // Create renderer pointed at the canvas.
    this._renderer = new Renderer(canvas, { cellSize: appState.cellSize });

    // Seed the initial grid.
    this._grid.seed(0.3, appState.config.initialEnergy);

    // Wire up EventBus → local handlers.
    this._subscribeToEvents();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Starts the render loop (always running) and optionally the tick loop.
   * The simulation starts paused; the user clicks Play to begin.
   */
  start(): void {
    this._startRenderLoop();
    // Do NOT auto-start the tick loop — let the user hit Play.
  }

  /**
   * Advances the simulation by exactly one tick.
   * Used by the Step button when the simulation is paused.
   */
  stepOnce(): void {
    this._tick();
  }

  // -------------------------------------------------------------------------
  // Simulation loop
  // -------------------------------------------------------------------------

  /**
   * Starts (or restarts) the `setInterval`-driven simulation tick loop at the
   * current `appState.hz`.
   */
  private _startTickLoop(): void {
    this._stopTickLoop();
    const intervalMs = 1000 / appState.hz;
    this._tickIntervalId = setInterval(() => this._tick(), intervalMs);
  }

  /**
   * Stops the tick loop if it is running.
   */
  private _stopTickLoop(): void {
    if (this._tickIntervalId !== null) {
      clearInterval(this._tickIntervalId);
      this._tickIntervalId = null;
    }
  }

  /**
   * Executes one simulation tick:
   * 1. Copies front → back (so back starts as a faithful copy).
   * 2. Runs the engine (reads front, writes back).
   * 3. Swaps front ↔ back.
   * 4. Emits tick event.
   */
  private _tick(): void {
    this._grid.copyFrontToBack();

    const stats: TickStats = this._engine.tick(
      this._grid.front,
      this._grid.back,
      appState.config,
    );

    this._grid.swap();

    const tick = this._tickCounter.advance();
    bus.emit('tick', { tick, stats });
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  /**
   * Starts the `requestAnimationFrame` render loop.
   * This loop runs regardless of whether the simulation is ticking, so the
   * canvas always shows the latest committed state.
   */
  private _startRenderLoop(): void {
    // Cancel any existing loop before starting a new one.
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    const loop = (now: number): void => {
      this._fpsCounter.frame(now);
      this._renderer.render(this._grid.front, appState.gridWidth, appState.gridHeight);

      // Emit FPS update at ~4 Hz to avoid flooding the status bar.
      if (this._tickCounter.current % 15 === 0 || this._tickCounter.current < 2) {
        bus.emit('fpsUpdate', {
          fps:       this._fpsCounter.fps,
          liveCells: this._grid.countCells(1), // CellType.Life = 1
        });
      }

      this._rafId = requestAnimationFrame(loop);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // EventBus subscriptions
  // -------------------------------------------------------------------------

  /**
   * Wires all EventBus events to local handlers.
   * Called once during construction.
   */
  private _subscribeToEvents(): void {
    // Play / Pause
    bus.on('playStateChange', ({ running }) => {
      if (running) {
        this._startTickLoop();
      } else {
        this._stopTickLoop();
      }
    });

    // Speed change — restart tick loop at new interval.
    bus.on('speedChange', () => {
      if (appState.running) {
        this._startTickLoop();
      }
    });

    // Reset — clear grid, re-seed, restart counters.
    bus.on('reset', () => {
      this._stopTickLoop();
      appState.running = false;
      this._grid.clear();
      this._grid.seed(0.3, appState.config.initialEnergy);
      this._renderer.invalidate();
      this._tickCounter.reset();
    });

    // Cell size change — tell renderer and invalidate.
    bus.on('cellSizeChange', ({ cellSize }) => {
      this._renderer.cellSize = cellSize;
      this._renderer.invalidate();
    });

    // Step (paused mode): handled via custom DOM event in Toolbar.
    // We listen at the window level since the event bubbles up.
    window.addEventListener('step-requested', () => {
      if (!appState.running) this.stepOnce();
    });
  }
}
