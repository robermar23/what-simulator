/**
 * @fileoverview Typed publish-subscribe event bus for the What Simulator.
 *
 * A deliberately minimal implementation — no external dependencies, no
 * framework.  Components subscribe to named events; the bus dispatches to all
 * subscribers of a given event type.
 *
 * Type safety is achieved via a single `EventMap` interface that maps event
 * names to their payload types.  Adding a new event requires only adding one
 * entry to that interface.
 *
 * Example:
 * ```ts
 * bus.on('tick', ({ tick, stats }) => statusBar.update(tick, stats));
 * bus.emit('tick', { tick: 42, stats });
 * ```
 */

import { type TickStats } from '../simulation/SimulationEngine.js';
import { type SimulationConfig } from '../simulation/config/SimulationConfig.js';
import { type RenderMode, type VariantCensus } from '../workers/workerBridge.js';
import type { BackgroundType } from '../rendering/BackgroundRenderer.js';

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

/**
 * Maps every event name to its payload type.
 * Extend this interface to add new events — no other changes required.
 */
export interface EventMap {
  /** Fired after each simulation tick. */
  tick: {
    /** Current tick number. */
    tick: number;
    /** Aggregate statistics from this tick. */
    stats: TickStats;
  };

  /** Fired when the simulation config changes (slider moved, preset loaded). */
  configChange: {
    /** The new config (or a partial update applied to the current one). */
    config: SimulationConfig;
  };

  /** Fired when the simulation is paused or resumed. */
  playStateChange: {
    /** True if the simulation is now running. */
    running: boolean;
  };

  /** Fired when the grid is reset (clear + re-seed). */
  reset: Record<string, never>;

  /** Fired when the simulation speed changes. */
  speedChange: {
    /** New tick rate in Hz. */
    hz: number;
  };

  /** Fired when the cell size / zoom level changes. */
  cellSizeChange: {
    /** New cell size in pixels per cell. */
    cellSize: number;
  };

  /** Fired when the rendered FPS counter updates. */
  fpsUpdate: {
    /** Current FPS (or sim ticks/sec in Phase 4). */
    fps: number;
    /** Monotonic simulation tick number at time of emission. */
    tickNum: number;
    /** Total live cells (Life + LifeVariant combined). */
    liveCells: number;
    /** Number of LifeVariant (Variant B) cells currently alive. */
    variantCells: number;
  };

  /** Fired when the user requests a PNG snapshot of the canvas. */
  snapshotRequested: Record<string, never>;

  /** Fired when the render worker has produced a snapshot blob URL. */
  snapshotReady: {
    /** Object URL pointing to the PNG blob — revoke after use. */
    url: string;
  };

  /**
   * Fired when the grid-line overlay is toggled on or off.
   * Phase 6: thin cell-boundary lines drawn over the simulation canvas.
   */
  gridLinesChange: {
    /** True when grid lines should be rendered. */
    show: boolean;
  };

  /**
   * Fired when the cursor hovers over a cell on the simulation canvas.
   * Phase 6: used to populate the hover tooltip.
   * Not fired while a paint gesture is in progress.
   */
  cellHover: {
    /** Grid column index (0-based), or -1 when leaving the canvas. */
    cellX: number;
    /** Grid row index (0-based), or -1 when leaving the canvas. */
    cellY: number;
  };

  /**
   * Fired when the active render mode changes (Phase 10).
   * Consumed by the App layer, which forwards it to the RenderWorker.
   */
  renderModeChange: {
    /** The newly selected render mode. */
    mode: RenderMode;
  };

  /**
   * Phase 18: fired when the morphology detail slider changes.
   * Consumed by App, which forwards it to the RenderWorker.
   */
  aliveDetailChange: {
    /** New detail level in [0, 1]. */
    value: number;
  };

  /**
   * Fired every `censusInterval` ticks when the SimulationWorker broadcasts
   * a population snapshot (Phase 11).
   * Consumed by the ControlPanel Evolution section to update variant counts.
   */
  variantCensus: {
    /** The full population census snapshot. */
    census: VariantCensus;
    /** Number of currently distinct living variant lineages. */
    livingVariants: number;
  };

  /**
   * Fired when the user selects a new background environment (Phase 14).
   * Consumed by BackgroundManager to switch the procedural background and
   * by Renderer to enable/disable transparent empty cells.
   */
  backgroundChange: {
    /** The newly selected background type. */
    type: BackgroundType;
  };

  /**
   * Round 5: fired when the user clicks "Apply Environment" on a preset card.
   * Consumed by App, which forwards the obstacle spec to the SimulationWorker
   * and the background type to the RenderWorker.
   */
  applyEnvironment: {
    /** Key of the environment preset being applied. */
    key: string;
    /** Background type to activate on the renderer. */
    backgroundType: BackgroundType;
    /** Declarative obstacle layout to generate. */
    spec: import('../simulation/generators/types.js').ObstacleSpec;
    /** Life seed density override (or the current UI density if null). */
    seedDensityOverride: number | null;
  };

  /**
   * Round 5: fired when the SimulationWorker has finished applying an
   * environment preset (obstacles placed, life re-seeded).
   * Consumed by the UI to re-enable controls.
   */
  environmentApplied: Record<string, never>;

}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

/** A callback for event `K`. */
type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

// ---------------------------------------------------------------------------
// EventBus class
// ---------------------------------------------------------------------------

/**
 * Typed publish-subscribe event bus.
 *
 * All cross-module communication goes through here so modules never hold
 * direct references to each other.
 */
export class EventBus {
  /**
   * Internal map from event name to a Set of handlers.
   * Using a Set prevents duplicate registrations for the same handler
   * reference.
   */
  private readonly _handlers = new Map<
    keyof EventMap,
    Set<Handler<keyof EventMap>>
  >();

  /**
   * Subscribes `handler` to event `event`.
   *
   * @param event - Event name.
   * @param handler - Callback to invoke when the event fires.
   * @returns An unsubscribe function — call it to remove the handler.
   */
  on<K extends keyof EventMap>(event: K, handler: Handler<K>): () => void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    // Safe cast: the Map value type is widened for storage but narrowed on
    // retrieval via the same generic key.
    (this._handlers.get(event) as Set<Handler<K>>).add(handler);

    return () => this.off(event, handler);
  }

  /**
   * Removes a previously registered handler.
   *
   * @param event - Event name.
   * @param handler - The exact handler reference passed to {@link on}.
   */
  off<K extends keyof EventMap>(event: K, handler: Handler<K>): void {
    (this._handlers.get(event) as Set<Handler<K>> | undefined)?.delete(handler);
  }

  /**
   * Dispatches an event to all registered handlers synchronously.
   *
   * @param event - Event name.
   * @param payload - Event payload matching the type in {@link EventMap}.
   */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const handlers = this._handlers.get(event) as
      | Set<Handler<K>>
      | undefined;
    if (!handlers) return;
    for (const h of handlers) h(payload);
  }

  /**
   * Removes all handlers for all events.  Useful when tearing down the app.
   */
  clear(): void {
    this._handlers.clear();
  }
}

/** Singleton event bus — the whole app shares one instance. */
export const bus = new EventBus();
