/**
 * @fileoverview ATP (Adenosine Triphosphate) economy system for the What Simulator.
 *
 * Phase 23 — "The Economy":
 *
 * ATP is the player's resource currency.  When economy mode is enabled, all
 * cell-painting actions have an ATP cost.  The player earns ATP passively from
 * living cells metabolising nutrients, and in larger bursts when evolutionary
 * milestones are reached or crises are survived.
 *
 * ## Design goals
 *   - Creates *scarcity*: the player cannot paint unlimited cells.
 *   - Creates *urgency*: spending wisely during a crisis matters.
 *   - Rewards *observation*: milestones fire when the player watches the colony evolve.
 *   - Opt-in: disabled by default so existing behaviour is unaffected.
 *
 * ## Architecture
 * ATPSystem lives entirely on the main thread.  It reads incoming tick stats
 * (cell count) to calculate passive income and receives milestone events to
 * award bonuses.  The worker never sees ATP — it is a UI/game layer concern.
 */

import { bus } from '../../state/EventBus.js';
import { type MilestoneKind } from '../../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// ATP cost table
// ---------------------------------------------------------------------------

/**
 * ATP cost to paint one cell of each drawing-tool type.
 * Costs reflect the strategic value of each cell type:
 *   - High-impact / permanent cells cost more.
 *   - Erasing is always free.
 *   - Life (the primary tool) is cheap to keep the economy approachable.
 *
 * Tools absent from this table default to 0 (free).
 */
export const ATP_COSTS: Readonly<Record<string, number>> = {
  life:        2,
  wall:        1,
  toxin:       3,
  nutrient:    5,
  drain:       2,
  gravityWell: 4,
  barrier:     2,
  fire:        3,
  ice:         3,
  mutagen:     5,
  radioWaste:  8,
  antibiotic:  6,
  rewinder:    5,
  colony:      6,
  erase:       0,
};

// ---------------------------------------------------------------------------
// Milestone reward table
// ---------------------------------------------------------------------------

/**
 * ATP awarded and message shown for each milestone kind.
 */
export const MILESTONE_REWARDS: Readonly<Record<MilestoneKind, { atp: number; message: string }>> = {
  newVariant:      { atp: 50,  message: 'New genetic lineage speciated! +50 ATP' },
  populationBoom:  { atp: 25,  message: 'Population boom: 10 000 cells! +25 ATP' },
  survivedCrisis:  { atp: 100, message: 'Crisis survived! Colony endures. +100 ATP' },
  longLivedVariant:{ atp: 75,  message: 'Lineage survives 1 000 ticks! +75 ATP' },
};

// ---------------------------------------------------------------------------
// ATPSystem class
// ---------------------------------------------------------------------------

/**
 * Manages the player's ATP resource pool.
 *
 * Call {@link ATPSystem.onTick} every time a `fpsUpdate` event fires to
 * accumulate passive income.  Call {@link ATPSystem.spend} before painting a
 * cell to check whether the player can afford it.
 *
 * All state changes emit an `atpChange` event on the shared EventBus so the
 * ATPDisplay component stays in sync.
 */
export class ATPSystem {
  /** Current ATP pool. */
  private _atp: number;

  /** Maximum pool capacity. */
  private _max: number;

  /** Whether economy mode is active. When false, spending always succeeds. */
  private _enabled: boolean;

  /**
   * Passive income rate: ATP earned per live cell per tick.
   * Default 0.0002 — at 10 000 live cells this yields 2 ATP/tick, or
   * ~60 ATP/sec at 30 TPS.  Full pool from empty takes ~8 seconds at peak.
   */
  private _incomeRate: number;

  /**
   * @param startAtp   - Initial ATP amount (default 500).
   * @param maxAtp     - Maximum pool size (default 1000).
   * @param incomeRate - Passive income per live cell per tick (default 0.0002).
   */
  constructor(startAtp = 500, maxAtp = 1000, incomeRate = 0.0002) {
    this._atp        = startAtp;
    this._max        = maxAtp;
    this._enabled    = false;
    this._incomeRate = incomeRate;
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  /** Current ATP pool value. */
  get atp(): number { return this._atp; }

  /** Maximum pool capacity. */
  get max(): number { return this._max; }

  /** True when economy mode is active. */
  get enabled(): boolean { return this._enabled; }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Enables or disables economy mode.
   * When disabled, {@link spend} always returns true and income accrues but
   * the UI still shows the ATP bar (for players who want to observe it).
   *
   * @param enabled - True to enable economy constraints.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    this._emit();
  }

  /**
   * Reconfigures the pool (e.g. when a new game / reset begins).
   *
   * @param startAtp   - New starting ATP value.
   * @param maxAtp     - New maximum pool size.
   * @param incomeRate - New passive income rate per cell per tick.
   */
  reconfigure(startAtp: number, maxAtp: number, incomeRate: number): void {
    this._atp        = Math.min(startAtp, maxAtp);
    this._max        = maxAtp;
    this._incomeRate = incomeRate;
    this._emit();
  }

  // -------------------------------------------------------------------------
  // Core operations
  // -------------------------------------------------------------------------

  /**
   * Returns the ATP cost of painting one cell with the given tool.
   * Zero for unrecognised tools or the erase tool.
   *
   * @param tool - DrawingTool name from AppState.
   * @returns ATP cost per cell.
   */
  costFor(tool: string): number {
    return ATP_COSTS[tool] ?? 0;
  }

  /**
   * Attempts to spend `amount` ATP.
   *
   * When economy mode is disabled this always returns true without deducting.
   * When enabled, returns false (and deducts nothing) if the pool is too low.
   *
   * @param amount - ATP to deduct.
   * @returns True if the spend succeeded; false if insufficient funds.
   */
  spend(amount: number): boolean {
    if (!this._enabled) return true;
    if (amount <= 0) return true;
    if (this._atp < amount) return false;
    this._atp -= amount;
    this._emit();
    return true;
  }

  /**
   * Adds ATP to the pool (capped at `max`).
   * Used for milestone rewards, crisis completion bonuses, and passive income.
   *
   * @param amount - ATP to add (must be non-negative).
   */
  earn(amount: number): void {
    if (amount <= 0) return;
    this._atp = Math.min(this._atp + amount, this._max);
    this._emit();
  }

  /**
   * Resets the pool to `startAtp` (called on grid Reset).
   *
   * @param startAtp - ATP to restore (defaults to same as construction value).
   */
  reset(startAtp?: number): void {
    this._atp = Math.min(startAtp ?? this._atp, this._max);
    this._emit();
  }

  // -------------------------------------------------------------------------
  // Passive income (called every tick via fpsUpdate)
  // -------------------------------------------------------------------------

  /**
   * Accumulates passive income from living cells.
   * Call this every simulation tick with the current live-cell count.
   *
   * Income = liveCells × `_incomeRate` per tick.
   * At the default rate (0.0002 ATP/cell/tick):
   *   - 1 000 cells → 0.2 ATP/tick → 6 ATP/sec @ 30 TPS
   *   - 10 000 cells → 2 ATP/tick  → 60 ATP/sec @ 30 TPS
   *
   * The pool emits an `atpChange` event only when the value visibly changes
   * (i.e. advances by ≥ 1 integer ATP) to avoid flooding the DOM.
   *
   * @param liveCells - Total living Life + LifeVariant cell count this tick.
   */
  onTick(liveCells: number): void {
    if (liveCells <= 0) return;
    const before  = Math.floor(this._atp);
    this._atp     = Math.min(this._atp + liveCells * this._incomeRate, this._max);
    const after   = Math.floor(this._atp);
    // Only emit when the visible integer value changes — avoids 60/sec DOM updates.
    if (after !== before) {
      this._emit();
    }
  }

  // -------------------------------------------------------------------------
  // Milestone handling
  // -------------------------------------------------------------------------

  /**
   * Awards an ATP milestone bonus and emits a `milestoneAchieved` event.
   * The event is consumed by the CrisisOverlay toast and the ATPDisplay bar.
   *
   * @param kind - Which milestone was reached.
   * @param tick - Simulation tick on which it occurred.
   */
  onMilestone(kind: MilestoneKind, tick: number): void {
    const { atp: reward, message } = MILESTONE_REWARDS[kind];
    this.earn(reward);
    bus.emit('milestoneAchieved', {
      kind,
      atpReward: reward,
      message,
      tick,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Emits an `atpChange` event with the current pool state.
   * Called after any mutation to keep subscribers in sync.
   */
  private _emit(): void {
    bus.emit('atpChange', {
      atp:     Math.floor(this._atp),
      atpMax:  this._max,
      enabled: this._enabled,
    });
  }
}

/** Singleton ATP system — shared across main thread modules. */
export const atpSystem = new ATPSystem();
