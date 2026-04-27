/**
 * @fileoverview Real-time population chart for the What Simulator.
 *
 * Two display modes, toggled by a button below the canvas:
 *
 * **Variants mode** (default) — stacked area chart showing variant population
 * percentages over time.  Subscribes to {@link EventMap.variantCensus} events.
 * Each colour band represents one variant lineage (from {@link VARIANT_PALETTE}).
 *
 * **Pred/Prey mode** (Phase 21) — dual-line chart showing predator count (red)
 * and prey count (teal) over time, plus spore count (brown).  Subscribes to
 * {@link EventMap.fpsUpdate} events so it updates at ~4 Hz regardless of census
 * interval.  Reveals Lotka-Volterra oscillations when predator mechanics are on.
 *
 * Rendered with Canvas 2D — no WebGL needed for this small fixed-size chart.
 *
 * ## Data flow — Variants mode
 * ```
 * SimWorker → variantCensus → App._onSimMessage
 *   → bus.emit('variantCensus') → PopulationChart._onCensus → _renderVariants()
 * ```
 *
 * ## Data flow — Pred/Prey mode
 * ```
 * SimWorker → tick → App._onSimMessage
 *   → bus.emit('fpsUpdate') → PopulationChart._onFps → _renderPredprey()
 * ```
 */

import { bus } from '../state/EventBus.js';
import { type VariantCensus } from '../workers/workerBridge.js';
import { VARIANT_PALETTE } from './ColorMap.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Sums all population counts in a census snapshot.
 *
 * @param snap - Uint32Array[256] of per-variant population counts.
 * @returns Total number of living cells across all variants.
 */
export function computeTotal(snap: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < snap.length; i++) total += snap[i];
  return total;
}

/**
 * Returns the sorted list of variant IDs that have non-zero population in at
 * least one snapshot.  Sorted ascending so colour assignment is stable across
 * redraws regardless of insertion order.
 *
 * @param snaps - Ordered array of census count snapshots (oldest first).
 * @returns Sorted array of active variant IDs.
 */
export function getActiveVariants(snaps: readonly Uint32Array[]): number[] {
  const seen = new Set<number>();
  for (const snap of snaps) {
    for (let v = 0; v < snap.length; v++) {
      if (snap[v] > 0) seen.add(v);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// PopulationChart class
// ---------------------------------------------------------------------------

/** Canvas width in pixels. Matches usable inner width of the 300 px panel. */
const CHART_W = 268;
/** Canvas height in pixels (main stacked area). */
const CHART_H = 96;
/** Height of the tick/variant-count label row below the chart. */
const LABEL_H = 14;
/** Total canvas height. */
const TOTAL_H = CHART_H + LABEL_H;
/** Number of census snapshots retained in the rolling history. */
const MAX_HISTORY = 268; // one snapshot maps to one pixel column

/**
 * Stacked area chart component visualising variant population over time.
 *
 * Usage:
 * ```ts
 * const chart = new PopulationChart();
 * chart.mount(containerElement);
 * // ... later ...
 * chart.unmount();
 * ```
 */
/** Compact record for one pred/prey snapshot. */
interface PredPreySnap {
  predators: number;
  prey:      number;
  spores:    number;
  tick:      number;
}

export class PopulationChart {
  // -------------------------------------------------------------------------
  // Private state — variants mode
  // -------------------------------------------------------------------------

  /** The canvas element owned by this chart. Null before mount. */
  private _canvas: HTMLCanvasElement | null = null;

  /** 2D rendering context for the canvas. Null before mount. */
  private _ctx: CanvasRenderingContext2D | null = null;

  /**
   * Rolling history of census count snapshots.
   * Stored as a flat pre-allocated array for GC efficiency.
   * New entries overwrite the oldest when the buffer is full.
   */
  private readonly _history: Array<Uint32Array> = [];

  /** Index of the next write slot in {@link _history}. */
  private _head = 0;

  /** Number of valid entries currently stored. */
  private _len = 0;

  /** Tick number from the most recent census. Used for the label row. */
  private _lastTick = 0;

  /** Living variant count from the most recent census. */
  private _lastLivingVariants = 0;

  /** Unsubscribe handle for the variantCensus subscription. */
  private _unsub: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Private state — pred/prey mode (Phase 21)
  // -------------------------------------------------------------------------

  /**
   * Which data the chart is currently displaying.
   * 'variants' = stacked area chart; 'predprey' = dual-line predator/prey.
   */
  private _mode: 'variants' | 'predprey' = 'variants';

  /** Rolling history of pred/prey population snapshots. */
  private readonly _ppHistory: PredPreySnap[] = [];

  /** Ring-buffer write index for {@link _ppHistory}. */
  private _ppHead = 0;

  /** Number of valid pred/prey entries stored. */
  private _ppLen  = 0;

  /** Unsubscribe handle for the fpsUpdate subscription (pred/prey mode). */
  private _unsubFps: (() => void) | null = null;

  /** The mode-toggle button element. Null before mount. */
  private _toggleBtn: HTMLButtonElement | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attaches the chart canvas and mode-toggle button to `container`, then
   * subscribes to both census and fpsUpdate events.
   *
   * @param container - Element to append the chart canvas and toggle into.
   */
  mount(container: HTMLElement): void {
    const canvas     = document.createElement('canvas');
    canvas.width     = CHART_W;
    canvas.height    = TOTAL_H;
    canvas.className = 'evo-chart-canvas';
    canvas.setAttribute('aria-label', 'Population timeline');
    container.append(canvas);
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');

    // Mode-toggle button rendered below the canvas.
    const btn = document.createElement('button');
    btn.className   = 'chart-mode-btn';
    btn.textContent = 'Pred/Prey view';
    btn.title       = 'Switch between variant stacked-area chart and predator/prey line chart.';
    btn.addEventListener('click', () => {
      this._mode = this._mode === 'variants' ? 'predprey' : 'variants';
      btn.textContent = this._mode === 'variants' ? 'Pred/Prey view' : 'Variants view';
      this._drawPlaceholder();
    });
    container.append(btn);
    this._toggleBtn = btn;

    this._drawPlaceholder();

    // Subscribe to census events for variants mode.
    this._unsub = bus.on('variantCensus', ({ census, livingVariants }) => {
      this._lastLivingVariants = livingVariants;
      this._onCensus(census);
    });

    // Subscribe to fpsUpdate for pred/prey mode (Phase 21).
    this._unsubFps = bus.on('fpsUpdate', ({ tickNum, liveCells, predatorCells, sporeCells }) => {
      // prey = live cells that are not predators and not spores
      const prey = Math.max(0, liveCells - predatorCells - sporeCells);
      this._onFps({ predators: predatorCells, prey, spores: sporeCells, tick: tickNum });
    });
  }

  /**
   * Removes the canvas, toggle button, and unsubscribes from EventBus.
   * Safe to call if {@link mount} was never called.
   */
  unmount(): void {
    this._unsub?.();
    this._unsubFps?.();
    this._canvas?.remove();
    this._toggleBtn?.remove();
    this._canvas    = null;
    this._ctx       = null;
    this._unsub     = null;
    this._unsubFps  = null;
    this._toggleBtn = null;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  /**
   * Receives a new census snapshot, pushes it into the variant history, and
   * re-renders the chart if in variants mode.
   *
   * @param census - Population snapshot from the SimulationWorker.
   */
  private _onCensus(census: VariantCensus): void {
    this._lastTick = census.tick;
    const snap = new Uint32Array(census.counts);

    if (this._len < MAX_HISTORY) {
      this._history.push(snap);
      this._len++;
    } else {
      this._history[this._head] = snap;
      this._head = (this._head + 1) % MAX_HISTORY;
    }

    if (this._mode === 'variants') this._renderVariants();
  }

  /**
   * Phase 21: receives a pred/prey tick snapshot from `fpsUpdate`, pushes it
   * into the pred/prey ring buffer, and re-renders if in predprey mode.
   *
   * @param snap - Current predator, prey, and spore counts.
   */
  private _onFps(snap: PredPreySnap): void {
    if (this._ppLen < MAX_HISTORY) {
      this._ppHistory.push(snap);
      this._ppLen++;
    } else {
      this._ppHistory[this._ppHead] = snap;
      this._ppHead = (this._ppHead + 1) % MAX_HISTORY;
    }

    if (this._mode === 'predprey') this._renderPredprey();
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  /**
   * Draws a placeholder message before any data arrives.
   */
  private _drawPlaceholder(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, CHART_W, TOTAL_H);
    ctx.fillStyle = '#3a3a5a';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting data…', CHART_W / 2, CHART_H / 2);
  }

  /**
   * Returns the variant history snapshots in chronological order (oldest first).
   */
  private _getOrderedHistory(): Uint32Array[] {
    if (this._len < MAX_HISTORY) {
      return this._history.slice(0, this._len);
    }
    const ordered: Uint32Array[] = [];
    for (let i = 0; i < MAX_HISTORY; i++) {
      ordered.push(this._history[(this._head + i) % MAX_HISTORY]);
    }
    return ordered;
  }

  /**
   * Returns the pred/prey history in chronological order (oldest first).
   */
  private _getOrderedPpHistory(): PredPreySnap[] {
    if (this._ppLen < MAX_HISTORY) {
      return this._ppHistory.slice(0, this._ppLen);
    }
    const ordered: PredPreySnap[] = [];
    for (let i = 0; i < MAX_HISTORY; i++) {
      ordered.push(this._ppHistory[(this._ppHead + i) % MAX_HISTORY]);
    }
    return ordered;
  }

  /**
   * Redraws the stacked area variant chart from current history.
   *
   * Algorithm:
   * 1. Collect all variants that ever had population > 0.
   * 2. For each x pixel (= one census snapshot) compute per-variant fractions.
   * 3. Draw stacked rectangles from bottom to top, one per live variant.
   */
  private _renderVariants(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;

    const snaps    = this._getOrderedHistory();
    const n        = snaps.length;
    const variants = getActiveVariants(snaps);

    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, CHART_W, CHART_H);

    if (n === 0 || variants.length === 0) return;

    for (let xi = 0; xi < CHART_W; xi++) {
      const si    = Math.min(n - 1, Math.floor((xi / CHART_W) * n));
      const snap  = snaps[si];
      const total = computeTotal(snap);
      if (total === 0) continue;

      let yAccum = CHART_H;

      for (const v of variants) {
        const count = snap[v];
        if (count === 0) continue;

        const h = (count / total) * CHART_H;

        const rgba = VARIANT_PALETTE[v & 0xFF];
        const r    =  rgba        & 0xFF;
        const g    = (rgba >>  8) & 0xFF;
        const b    = (rgba >> 16) & 0xFF;

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(xi, Math.round(yAccum - h), 1, Math.ceil(h) || 1);
        yAccum -= h;
      }
    }

    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, CHART_W - 1, CHART_H - 1);

    ctx.fillStyle = '#111120';
    ctx.fillRect(0, CHART_H, CHART_W, LABEL_H);
    ctx.fillStyle = '#5a6080';
    ctx.font      = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`T:${this._lastTick}`, 4, CHART_H + LABEL_H - 3);
    ctx.textAlign = 'right';
    ctx.fillText(`${this._lastLivingVariants}V`, CHART_W - 4, CHART_H + LABEL_H - 3);
  }

  /**
   * Phase 21: draws a dual-line chart of predator (red) and prey (teal) counts.
   *
   * Y axis is normalised to the rolling maximum so both lines stay in-frame.
   * A brown spore line is drawn if any spores are present.
   * Reveals Lotka-Volterra oscillations when predator mechanics are active.
   */
  private _renderPredprey(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;

    const snaps = this._getOrderedPpHistory();
    const n     = snaps.length;

    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, CHART_W, CHART_H);

    if (n === 0) return;

    // Find rolling maximum for normalisation.
    let maxVal = 1;
    for (const s of snaps) {
      if (s.predators > maxVal) maxVal = s.predators;
      if (s.prey      > maxVal) maxVal = s.prey;
      if (s.spores    > maxVal) maxVal = s.spores;
    }

    const lastSnap = snaps[n - 1];

    // Draw a guide line at 50% so scale is readable.
    ctx.strokeStyle = '#1a1a2a';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, CHART_H / 2);
    ctx.lineTo(CHART_W, CHART_H / 2);
    ctx.stroke();

    /** Draws a single data series as a polyline. */
    const drawLine = (color: string, getValue: (s: PredPreySnap) => number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      let started = false;
      for (let xi = 0; xi < CHART_W; xi++) {
        const si  = Math.min(n - 1, Math.floor((xi / CHART_W) * n));
        const val = getValue(snaps[si]);
        const y   = CHART_H - (val / maxVal) * (CHART_H - 2) - 1;
        if (!started) { ctx.moveTo(xi, y); started = true; }
        else           { ctx.lineTo(xi, y); }
      }
      ctx.stroke();
    };

    // Spores — brown (#5c3d1a), only if any non-zero history.
    const hasSpores = snaps.some(s => s.spores > 0);
    if (hasSpores) drawLine('#5c3d1a', s => s.spores);
    // Prey — teal (#00ddbb)
    drawLine('#00ddbb', s => s.prey);
    // Predators — vivid red (#ff2200)
    drawLine('#ff2200', s => s.predators);

    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, CHART_W - 1, CHART_H - 1);

    // Label row: tick + live predator/prey counts.
    ctx.fillStyle = '#111120';
    ctx.fillRect(0, CHART_H, CHART_W, LABEL_H);
    ctx.font      = '9px monospace';
    ctx.fillStyle = '#ff6644';
    ctx.textAlign = 'left';
    ctx.fillText(`P:${lastSnap.predators}`, 4, CHART_H + LABEL_H - 3);
    ctx.fillStyle = '#00ddbb';
    ctx.textAlign = 'center';
    ctx.fillText(`Pr:${lastSnap.prey}`, CHART_W / 2, CHART_H + LABEL_H - 3);
    ctx.fillStyle = '#5a6080';
    ctx.textAlign = 'right';
    ctx.fillText(`T:${lastSnap.tick}`, CHART_W - 4, CHART_H + LABEL_H - 3);
  }
}
