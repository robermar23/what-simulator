/**
 * @fileoverview Crisis event scheduler for the What Simulator (Phase 23).
 *
 * The CrisisScheduler runs entirely on the main thread.  It watches incoming
 * simulation tick messages and fires extinction-level events at randomised
 * intervals.  Each crisis:
 *
 *   1. Issues a pre-crisis *warning* (200 ticks before onset) so the player
 *      can spend ATP to prepare.
 *   2. Sends a `configUpdate` to the SimulationWorker that applies the crisis
 *      overrides (e.g. tripled energy decay for desiccation).
 *   3. After `crisisDuration` ticks, restores the original config overrides
 *      and awards the player ATP via the ATPSystem.
 *
 * Crisis types that need cells placed on the grid (iceAge, fireStorm) issue
 * `editCmd` messages via the provided cell-painter callback.
 *
 * ## Engagement psychology (scarcity + urgency)
 *   - The warning countdown creates *urgency* — players scramble to spend ATP.
 *   - Random intervals prevent prediction — players stay vigilant.
 *   - Post-crisis ATP reward creates a *loss-then-reward* loop that feels
 *     satisfying and encourages watching the colony recover.
 */

import { bus } from '../../state/EventBus.js';
import { type SimulationConfig } from '../config/SimulationConfig.js';
import { type CrisisType } from '../../workers/workerBridge.js';
import { atpSystem } from '../economy/ATPSystem.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes which fields a crisis overrides and their original values so
 * CrisisScheduler can restore the config when the crisis ends.
 */
interface CrisisConfigPatch {
  /** Fields to temporarily override in SimulationConfig during the crisis. */
  readonly overrides: Partial<SimulationConfig>;
}

/** Internal phase of the crisis state machine. */
type CrisisPhase =
  | 'idle'      // No crisis — counting down to next scheduled one.
  | 'warning'   // Pre-crisis warning window (200 ticks before onset).
  | 'active';   // Crisis is live, applying damage each tick.

/** Callback signature for painting a cell (bridges to App.paintCell). */
type PainterFn = (cellX: number, cellY: number, cellType: number) => void;

/** Callback signature for sending a config update to the sim worker. */
type ConfigUpdateFn = (config: SimulationConfig) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ticks before crisis onset during which the warning banner is shown. */
const WARNING_TICKS = 200;

/** Cell type values needed for fireStorm / iceAge cell placement. */
const CELL_TYPE_FIRE = 8;
const CELL_TYPE_ICE  = 9;

// ---------------------------------------------------------------------------
// Crisis definitions
// ---------------------------------------------------------------------------

/**
 * All 8 crisis types with their config overrides.
 * The `overrides` object lists only the fields that change — the scheduler
 * merges these onto the live config and restores the originals on end.
 *
 * Note: solarFlare and antibioticFlood overrides are minimal because their
 * primary effects are handled inside SimulationEngine._applyCrisisTick().
 */
const CRISIS_CONFIGS: Readonly<Record<CrisisType, CrisisConfigPatch>> = {
  solarFlare: {
    overrides: {
      activeCrisis:   'solarFlare',
      crisisIntensity: 1.0,
    },
  },
  desiccation: {
    overrides: {
      activeCrisis:   'desiccation',
      crisisIntensity: 1.0,
      // Tripled energy decay — cells burn through reserves rapidly.
      // Actual multiplier applied in CrisisScheduler using the saved original value.
    },
  },
  antibioticFlood: {
    overrides: {
      activeCrisis:    'antibioticFlood',
      crisisIntensity:  1.5, // harder than solarFlare
    },
  },
  nutrientDrought: {
    overrides: {
      activeCrisis:   'nutrientDrought',
      crisisIntensity: 1.0,
      nutrientBoost:   0, // nutrients produce zero energy
    },
  },
  predatorSurge: {
    overrides: {
      activeCrisis:   'predatorSurge',
      crisisIntensity: 1.0,
      // predatorGenomeThreshold halved — computed dynamically from live config.
    },
  },
  iceAge: {
    overrides: {
      activeCrisis:   'iceAge',
      crisisIntensity: 1.0,
      motilityRate:    0, // cells freeze in place
      // spreadRate reduced 70% — computed dynamically.
    },
  },
  fireStorm: {
    overrides: {
      activeCrisis:   'fireStorm',
      crisisIntensity: 1.0,
      // No config changes — fires are painted directly onto the grid.
    },
  },
  plagueSweep: {
    overrides: {
      activeCrisis:   'plagueSweep',
      crisisIntensity: 1.0,
      // pointMutationRate multiplied 10× — computed dynamically.
    },
  },
};

/** Human-readable names for crisis types shown in the warning banner. */
export const CRISIS_NAMES: Readonly<Record<CrisisType, string>> = {
  solarFlare:      'Solar Flare',
  desiccation:     'Desiccation',
  antibioticFlood: 'Antibiotic Flood',
  nutrientDrought: 'Nutrient Drought',
  predatorSurge:   'Predator Surge',
  iceAge:          'Ice Age',
  fireStorm:       'Firestorm',
  plagueSweep:     'Plague Sweep',
};

/** Descriptions for each crisis, shown in the warning banner. */
export const CRISIS_DESCRIPTIONS: Readonly<Record<CrisisType, string>> = {
  solarFlare:      'Radiation storm incoming. Genome integrity at risk — rapid mutations ahead.',
  desiccation:     'Water evaporating. Energy decay tripling — only the efficient will survive.',
  antibioticFlood: 'Antibiotic wave sweeping the grid. Toxin-resistant strains will prevail.',
  nutrientDrought: 'Nutrient sources depleted. All food signals suppressed — prepare reserves.',
  predatorSurge:   'Predator genomes activating. Half the threshold breached — more hunters emerge.',
  iceAge:          'Temperature plummeting. Cell motility frozen, spread rate collapsing.',
  fireStorm:       'Thermal event detected. Ignition fronts will appear across the grid.',
  plagueSweep:     'Hypermutation epoch. Point mutation rate × 10 — diversity explosion imminent.',
};

// ---------------------------------------------------------------------------
// CrisisScheduler class
// ---------------------------------------------------------------------------

/**
 * Manages the crisis event lifecycle: scheduling, warnings, onset, and recovery.
 *
 * Requires external callers to pass tick updates via {@link onTick}.
 * The scheduler is intentionally stateless between constructor calls — reset
 * it by calling {@link reset} after a grid reset.
 */
export class CrisisScheduler {
  /** Whether crisis mode is enabled. */
  private _enabled = false;

  /** Current phase of the crisis state machine. */
  private _phase: CrisisPhase = 'idle';

  /** Ticks until the next crisis warning phase begins. */
  private _ticksUntilWarning = 0;

  /** Ticks remaining in the current warning window. */
  private _warningTicksLeft = 0;

  /** Ticks remaining in the active crisis. */
  private _activeTicksLeft = 0;

  /** Which crisis is currently active or approaching. */
  private _currentCrisis: CrisisType | 'none' = 'none';

  /** Minimum ticks between crises. */
  private _intervalMin: number;

  /** Maximum ticks between crises. */
  private _intervalMax: number;

  /** How many ticks a crisis lasts. */
  private _duration: number;

  /** Severity multiplier [0.5, 3.0]. */
  private _intensity: number;

  /** Original config field values saved before overrides are applied. */
  private _savedValues: Partial<SimulationConfig> = {};

  /** Callback to push config updates to the sim worker. */
  private readonly _updateConfig: ConfigUpdateFn;

  /** Callback to paint crisis cells (fireStorm / iceAge). */
  private readonly _paintCell: PainterFn;

  /** Grid dimensions needed for random cell placement. */
  private _gridWidth = 256;
  private _gridHeight = 256;

  /**
   * @param updateConfig - Callback that sends a configUpdate to the sim worker.
   * @param paintCell    - Callback that paints a single cell on the grid.
   * @param intervalMin  - Minimum ticks between crises (default 2000).
   * @param intervalMax  - Maximum ticks between crises (default 5000).
   * @param duration     - Ticks a crisis lasts (default 500).
   * @param intensity    - Severity multiplier (default 1.0).
   */
  constructor(
    updateConfig: ConfigUpdateFn,
    paintCell:    PainterFn,
    intervalMin = 2000,
    intervalMax = 5000,
    duration    = 500,
    intensity   = 1.0,
  ) {
    this._updateConfig = updateConfig;
    this._paintCell    = paintCell;
    this._intervalMin  = intervalMin;
    this._intervalMax  = intervalMax;
    this._duration     = duration;
    this._intensity    = intensity;
    this._scheduleNext();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Enables or disables the crisis event system.
   * When disabled, all scheduled crises are cancelled and a running crisis
   * is immediately ended.
   *
   * @param enabled    - True to activate crisis mode.
   * @param config     - Live SimulationConfig (needed to apply/restore patches).
   */
  setEnabled(enabled: boolean, config: SimulationConfig): void {
    this._enabled = enabled;

    if (!enabled && this._phase !== 'idle') {
      this._endCrisis(config);
    }

    if (enabled) {
      this._scheduleNext();
    }
  }

  /**
   * Updates crisis interval/duration/intensity from UI sliders.
   *
   * @param intervalMin - Minimum ticks between crises.
   * @param intervalMax - Maximum ticks between crises.
   * @param duration    - Ticks a crisis lasts.
   * @param intensity   - Severity multiplier.
   */
  setParams(
    intervalMin: number,
    intervalMax: number,
    duration:    number,
    intensity:   number,
  ): void {
    this._intervalMin = intervalMin;
    this._intervalMax = intervalMax;
    this._duration    = duration;
    this._intensity   = intensity;
  }

  /**
   * Sets the grid dimensions used for random cell placement during crises.
   *
   * @param width  - Grid width in cells.
   * @param height - Grid height in cells.
   */
  setGridSize(width: number, height: number): void {
    this._gridWidth  = width;
    this._gridHeight = height;
  }

  /**
   * Advances the crisis scheduler by one tick.
   * Must be called once per simulation tick from the main thread's fpsUpdate
   * handler (or equivalent tick-counting mechanism).
   *
   * @param config    - Current SimulationConfig (mutated when crisis starts/ends).
   * @param tickNum   - Current monotonic tick number.
   */
  onTick(config: SimulationConfig, tickNum: number): void {
    if (!this._enabled) return;

    switch (this._phase) {
      case 'idle':
        this._ticksUntilWarning--;
        if (this._ticksUntilWarning <= 0) {
          this._beginWarning(tickNum);
        }
        break;

      case 'warning':
        this._warningTicksLeft--;
        bus.emit('crisisChange', {
          crisis:         this._currentCrisis as CrisisType,
          ticksRemaining: -this._warningTicksLeft, // negative = warning countdown
          active:         false,
        });
        if (this._warningTicksLeft <= 0) {
          this._beginCrisis(config, tickNum);
        }
        break;

      case 'active':
        this._activeTicksLeft--;
        bus.emit('crisisChange', {
          crisis:         this._currentCrisis as CrisisType,
          ticksRemaining: this._activeTicksLeft,
          active:         true,
        });
        if (this._activeTicksLeft <= 0) {
          this._endCrisis(config);
          atpSystem.onMilestone('survivedCrisis', tickNum);
        }
        break;
    }
  }

  /**
   * Resets the scheduler to idle.  Call this after a grid reset so old crisis
   * state does not bleed into the new simulation.
   *
   * @param config - The reset SimulationConfig (used to clear any overrides).
   */
  reset(config: SimulationConfig): void {
    if (this._phase !== 'idle') {
      this._forceRestoreConfig(config);
    }
    this._phase          = 'idle';
    this._currentCrisis  = 'none';
    this._savedValues    = {};
    this._scheduleNext();
    bus.emit('crisisChange', {
      crisis:         'none',
      ticksRemaining: 0,
      active:         false,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Schedules the next crisis at a random interval in [intervalMin, intervalMax].
   */
  private _scheduleNext(): void {
    this._ticksUntilWarning =
      this._intervalMin +
      Math.floor(Math.random() * (this._intervalMax - this._intervalMin));
  }

  /**
   * Selects a random crisis type and enters the warning phase.
   *
   * @param tickNum - Current tick (for logging).
   */
  private _beginWarning(tickNum: number): void {
    const types: CrisisType[] = [
      'solarFlare', 'desiccation', 'antibioticFlood', 'nutrientDrought',
      'predatorSurge', 'iceAge', 'fireStorm', 'plagueSweep',
    ];
    this._currentCrisis  = types[Math.floor(Math.random() * types.length)];
    this._phase          = 'warning';
    this._warningTicksLeft = WARNING_TICKS;

    bus.emit('crisisChange', {
      crisis:         this._currentCrisis,
      ticksRemaining: -WARNING_TICKS,
      active:         false,
    });

    // Suppress unused tickNum — kept for potential future event logging.
    void tickNum;
  }

  /**
   * Applies crisis config overrides and activates the crisis phase.
   *
   * @param config  - Live SimulationConfig to mutate.
   * @param tickNum - Current tick.
   */
  private _beginCrisis(config: SimulationConfig, tickNum: number): void {
    this._phase           = 'active';
    this._activeTicksLeft = this._duration;

    const crisis  = this._currentCrisis as CrisisType;
    const patch   = CRISIS_CONFIGS[crisis];

    // Save original values before applying overrides.
    this._savedValues = {};
    for (const key of Object.keys(patch.overrides) as (keyof SimulationConfig)[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._savedValues as any)[key] = (config as any)[key];
    }

    // Apply static overrides from the crisis definition.
    Object.assign(config, patch.overrides);

    // Apply dynamic overrides that depend on the current config values.
    this._applyDynamicOverrides(config, crisis);

    // Override intensity from our slider setting.
    config.crisisIntensity = this._intensity;

    this._updateConfig(config);

    // For crises that place cells on the grid, do it now.
    this._placeCrisisCells(crisis);

    bus.emit('crisisChange', {
      crisis,
      ticksRemaining: this._duration,
      active:         true,
    });

    void tickNum;
  }

  /**
   * Applies config overrides that scale off the current config values
   * (e.g. tripling the existing energyDecayRate rather than setting a fixed value).
   *
   * @param config - Config being modified.
   * @param crisis - Active crisis type.
   */
  private _applyDynamicOverrides(config: SimulationConfig, crisis: CrisisType): void {
    const i = this._intensity;

    switch (crisis) {
      case 'desiccation':
        // Triple energy decay to create a survivability crisis.
        config.energyDecayRate = Math.min(config.energyDecayRate * 3 * i, 0.5);
        break;

      case 'predatorSurge':
        // Halve the predator genome threshold so more cells classify as predators.
        if (config.predatorGenomeThreshold > 0) {
          config.predatorGenomeThreshold = Math.max(
            Math.floor(config.predatorGenomeThreshold / 2),
            1000, // never set so low that every cell becomes a predator
          );
        }
        break;

      case 'iceAge':
        // Collapse spread rate 70%.
        config.spreadRate = config.spreadRate * 0.3 * (1 / i);
        break;

      case 'plagueSweep':
        // Spike point mutation rate 10×.
        config.pointMutationRate = Math.min(config.pointMutationRate * 10 * i, 0.5);
        break;

      default:
        break;
    }
  }

  /**
   * Paints cells on the grid for crises that require physical obstacles.
   *
   * @param crisis - Active crisis type.
   */
  private _placeCrisisCells(crisis: CrisisType): void {
    const w = this._gridWidth;
    const h = this._gridHeight;

    if (crisis === 'fireStorm') {
      // Paint 30 fire cells at random positions.
      for (let n = 0; n < 30; n++) {
        const x = Math.floor(Math.random() * w);
        const y = Math.floor(Math.random() * h);
        this._paintCell(x, y, CELL_TYPE_FIRE);
      }
    } else if (crisis === 'iceAge') {
      // Paint 50 ice cells to freeze regions of the colony.
      for (let n = 0; n < 50; n++) {
        const x = Math.floor(Math.random() * w);
        const y = Math.floor(Math.random() * h);
        this._paintCell(x, y, CELL_TYPE_ICE);
      }
    }
  }

  /**
   * Restores all config overrides and returns to idle.
   *
   * @param config - Live SimulationConfig to restore.
   */
  private _endCrisis(config: SimulationConfig): void {
    this._forceRestoreConfig(config);
    this._phase         = 'idle';
    this._currentCrisis = 'none';
    this._savedValues   = {};
    this._scheduleNext();

    bus.emit('crisisChange', {
      crisis:         'none',
      ticksRemaining: 0,
      active:         false,
    });
  }

  /**
   * Unconditionally restores saved config values.
   * Used both by _endCrisis and by reset() when called mid-crisis.
   *
   * @param config - Config to restore into.
   */
  private _forceRestoreConfig(config: SimulationConfig): void {
    // Restore saved original values.
    Object.assign(config, this._savedValues);
    // Clear the crisis marker.
    config.activeCrisis   = 'none';
    config.crisisIntensity = 1.0;
    this._updateConfig(config);
  }
}
