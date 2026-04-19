/**
 * @fileoverview Real-time stacked area chart showing variant population
 * percentages over time.
 *
 * Subscribes to the {@link EventMap.variantCensus} EventBus event and maintains
 * a rolling history of up to {@link PopulationChart.MAX_HISTORY} census
 * snapshots.  On each update the chart redraws a stacked column chart where
 * each colour band represents one variant lineage, coloured by
 * {@link VARIANT_PALETTE}.
 *
 * Rendered with Canvas 2D — no WebGL needed for this small fixed-size chart.
 *
 * ## Data flow
 * ```
 * SimWorker → variantCensus message → App._onSimMessage
 *   → bus.emit('variantCensus') → PopulationChart._onCensus
 *     → push to circular history → _render()
 * ```
 *
 * ## Reading the chart
 * - X axis: time (left = oldest, right = most recent census)
 * - Y axis: fraction of total live cells (0 % at bottom, 100 % at top)
 * - Each colour band: one variant lineage (from VARIANT_PALETTE)
 * - A variant that went extinct disappears from newer columns
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
/** Canvas height in pixels. */
const CHART_H = 100;
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
export class PopulationChart {
  // -------------------------------------------------------------------------
  // Private state
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

  /**
   * Index of the next write slot in {@link _history}.
   * Advances modulo MAX_HISTORY once the buffer is full.
   */
  private _head = 0;

  /** Number of valid entries currently stored. */
  private _len = 0;

  /** Unsubscribe function returned by {@link bus.on}. Null before mount. */
  private _unsub: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attaches the chart canvas to `container` and subscribes to census events.
   *
   * @param container - Element to append the chart canvas into.
   */
  mount(container: HTMLElement): void {
    const canvas     = document.createElement('canvas');
    canvas.width     = CHART_W;
    canvas.height    = CHART_H;
    canvas.className = 'evo-chart-canvas';
    canvas.setAttribute('aria-label', 'Population timeline — stacked variant areas');
    container.append(canvas);
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');

    this._drawPlaceholder();

    // Subscribe to census events; unsubscribe handle saved for unmount.
    this._unsub = bus.on('variantCensus', ({ census }) => this._onCensus(census));
  }

  /**
   * Removes the canvas and unsubscribes from EventBus.
   * Safe to call if {@link mount} was never called.
   */
  unmount(): void {
    this._unsub?.();
    this._canvas?.remove();
    this._canvas = null;
    this._ctx    = null;
    this._unsub  = null;
  }

  // -------------------------------------------------------------------------
  // Census handler
  // -------------------------------------------------------------------------

  /**
   * Receives a new census snapshot, pushes it into the rolling history, and
   * re-renders the chart.
   *
   * @param census - Population snapshot from the SimulationWorker.
   */
  private _onCensus(census: VariantCensus): void {
    // Deep-copy the counts array so the census object can be GC'd freely.
    const snap = new Uint32Array(census.counts);

    if (this._len < MAX_HISTORY) {
      this._history.push(snap);
      this._len++;
    } else {
      this._history[this._head] = snap;
      this._head = (this._head + 1) % MAX_HISTORY;
    }

    this._render();
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  /**
   * Draws a placeholder message before any census data arrives.
   */
  private _drawPlaceholder(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, CHART_W, CHART_H);
    ctx.fillStyle = '#3a3a5a';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting census data…', CHART_W / 2, CHART_H / 2);
  }

  /**
   * Returns the history snapshots in chronological order (oldest first).
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
   * Redraws the full stacked area chart from current history.
   *
   * Algorithm:
   * 1. Collect all variants that ever had population > 0.
   * 2. For each x pixel (= one census snapshot) compute per-variant fractions.
   * 3. Draw stacked rectangles from bottom to top, one per live variant.
   */
  private _render(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;

    const snaps   = this._getOrderedHistory();
    const n       = snaps.length;
    const variants = getActiveVariants(snaps);

    // Clear background.
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, CHART_W, CHART_H);

    if (n === 0 || variants.length === 0) return;

    // Draw one pixel column per snapshot.
    for (let xi = 0; xi < CHART_W; xi++) {
      // Map this pixel column to a snapshot index (sub-sample when n < W).
      const si = Math.min(n - 1, Math.floor((xi / CHART_W) * n));
      const snap  = snaps[si];
      const total = computeTotal(snap);
      if (total === 0) continue;

      let yAccum = CHART_H; // start from the bottom of the canvas

      for (const v of variants) {
        const count = snap[v];
        if (count === 0) continue;

        const h = (count / total) * CHART_H;

        // Unpack RGBA from VARIANT_PALETTE (little-endian: R, G, B, A).
        const rgba = VARIANT_PALETTE[v & 0xFF];
        const r    =  rgba        & 0xFF;
        const g    = (rgba >>  8) & 0xFF;
        const b    = (rgba >> 16) & 0xFF;

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(xi, Math.round(yAccum - h), 1, Math.ceil(h) || 1);
        yAccum -= h;
      }
    }

    // Draw a hairline border so the chart area is clearly delimited.
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, CHART_W - 1, CHART_H - 1);
  }
}
