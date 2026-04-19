/**
 * @fileoverview Genome trait heatmap showing the four heritable nibbles for
 * the top active variants.
 *
 * On each 'variantCensus' EventBus event the heatmap redraws a small grid:
 *
 * ```
 *         Spread  Decay  Toxin  Nutrient
 * Var 0   [████]  [████]  [████]  [████]
 * Var 3   [████]  [████]  [████]  [████]
 * ...
 * ```
 *
 * Each cell colour encodes the nibble tier of the variant's modal genome:
 *   - Tier 0  → deep blue  (trait suppressed)
 *   - Tier 7  → mid grey   (neutral baseline)
 *   - Tier 15 → vivid red  (trait maximised)
 *
 * This lets observers instantly see which variants have evolved high toxin
 * resistance, fast spread, slow decay, etc., and compare across lineages.
 *
 * ## Genome nibble layout (GenomeEncoder convention)
 * ```
 * Bits 15–12  Bits 11–8   Bits 7–4    Bits 3–0
 * [nutrient]  [toxin]     [decay]     [spread]
 *   tier        tier        tier        tier
 * ```
 */

import { bus } from '../state/EventBus.js';
import { type VariantCensus } from '../workers/workerBridge.js';
import { VARIANT_PALETTE } from './ColorMap.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Extracts one 4-bit nibble from a 16-bit genome integer.
 *
 * Nibble layout (matching GenomeEncoder):
 *   0 = spread  (bits 3–0)
 *   1 = decay   (bits 7–4)
 *   2 = toxin   (bits 11–8)
 *   3 = nutrient (bits 15–12)
 *
 * @param genome - 16-bit packed genome value.
 * @param nibble - Nibble index (0 = spread … 3 = nutrient).
 * @returns Tier value in [0, 15].
 */
export function extractNibble(genome: number, nibble: 0 | 1 | 2 | 3): number {
  return (genome >>> (nibble * 4)) & 0xF;
}

/**
 * Converts a genome nibble tier [0, 15] to a CSS `rgb(…)` colour string.
 *
 * The colour space is:
 *   - Tier 0  → deep blue  rgb(0, 80, 200)
 *   - Tier 7  → mid grey   rgb(120, 120, 120)
 *   - Tier 15 → vivid red  rgb(220, 40, 0)
 *
 * Linearly interpolated in two segments (0→7 and 7→15).
 *
 * @param tier - Nibble tier value in [0, 15].
 * @returns CSS colour string for the heatmap cell.
 */
export function nibbleToColor(tier: number): string {
  // Clamp to valid range.
  const t = Math.max(0, Math.min(15, tier));

  let r: number, g: number, b: number;

  if (t <= 7) {
    // Blue (0, 80, 200) → Grey (120, 120, 120)
    const frac = t / 7;
    r = Math.round(0   + frac * (120 - 0));
    g = Math.round(80  + frac * (120 - 80));
    b = Math.round(200 + frac * (120 - 200));
  } else {
    // Grey (120, 120, 120) → Red (220, 40, 0)
    const frac = (t - 7) / 8;
    r = Math.round(120 + frac * (220 - 120));
    g = Math.round(120 + frac * (40  - 120));
    b = Math.round(120 + frac * (0   - 120));
  }

  return `rgb(${r},${g},${b})`;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Maximum number of variant rows displayed in the heatmap. */
const MAX_ROWS = 8;
/** Height of each variant row in pixels (includes padding). */
const ROW_H = 24;
/** Height of the column header row in pixels. */
const HEADER_H = 20;
/** Width of the variant label column in pixels. */
const LABEL_W = 36;
/** Width of each nibble trait cell in pixels. */
const CELL_W = 48;
/** Horizontal gap between cells in pixels. */
const CELL_GAP = 4;
/** Vertical padding inside each cell. */
const CELL_PAD = 3;
/** Canvas width in pixels. */
const CANVAS_W = 268;

/** Names of the four genome traits shown as column headers. */
const TRAIT_LABELS = ['Spd', 'Dcy', 'Tox', 'Nut'] as const;

// ---------------------------------------------------------------------------
// GenomeHeatmap class
// ---------------------------------------------------------------------------

/**
 * Genome trait heatmap component.
 *
 * Renders a colour-coded grid showing the spread/decay/toxin/nutrient genome
 * tiers for up to {@link MAX_ROWS} of the most populous active variants.
 *
 * Usage:
 * ```ts
 * const heatmap = new GenomeHeatmap();
 * heatmap.mount(containerElement);
 * ```
 */
export class GenomeHeatmap {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** Canvas element managed by this component. Null before mount. */
  private _canvas: HTMLCanvasElement | null = null;

  /** 2D rendering context. Null before mount. */
  private _ctx: CanvasRenderingContext2D | null = null;

  /** Unsubscribe from 'variantCensus' EventBus event. Null before mount. */
  private _unsub: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Creates the heatmap canvas and begins listening for census data.
   *
   * @param container - Element to append the canvas into.
   */
  mount(container: HTMLElement): void {
    const canvas     = document.createElement('canvas');
    canvas.width     = CANVAS_W;
    canvas.height    = HEADER_H + MAX_ROWS * ROW_H;
    canvas.className = 'evo-chart-canvas';
    canvas.setAttribute('aria-label', 'Genome trait heatmap — top variant lineages');
    container.append(canvas);
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');

    this._drawPlaceholder();

    this._unsub = bus.on('variantCensus', ({ census }) => this._onCensus(census));
  }

  /**
   * Removes the canvas and unsubscribes from the EventBus.
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
   * Re-renders the heatmap from the latest census snapshot.
   *
   * @param census - Population snapshot containing per-variant modal genomes.
   */
  private _onCensus(census: VariantCensus): void {
    // Select top variants by current population.
    const topVariants = this._selectTopVariants(census);
    // Resize canvas to exactly fit the number of rows present.
    const rowCount = Math.min(topVariants.length, MAX_ROWS);
    if (this._canvas) {
      this._canvas.height = HEADER_H + rowCount * ROW_H;
    }
    this._render(census, topVariants);
  }

  // -------------------------------------------------------------------------
  // Data selection helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the IDs of up to {@link MAX_ROWS} variants with the highest
   * current population, sorted descending by count.
   *
   * @param census - Current census snapshot.
   * @returns Sorted array of variant IDs (most populous first).
   */
  private _selectTopVariants(census: VariantCensus): number[] {
    const pairs: Array<{ id: number; count: number }> = [];
    for (let v = 0; v < census.counts.length; v++) {
      if (census.counts[v] > 0) {
        pairs.push({ id: v, count: census.counts[v] });
      }
    }
    pairs.sort((a, b) => b.count - a.count);
    return pairs.slice(0, MAX_ROWS).map(p => p.id);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Placeholder drawn before any census arrives. */
  private _drawPlaceholder(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, CANVAS_W, this._canvas.height);
    ctx.fillStyle = '#3a3a5a';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting census data…', CANVAS_W / 2, this._canvas.height / 2);
  }

  /**
   * Draws the full heatmap grid: column headers + one row per variant.
   *
   * @param census     - Current census snapshot.
   * @param topVariants - Variant IDs to display (most populous first).
   */
  private _render(census: VariantCensus, topVariants: readonly number[]): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;

    const W = CANVAS_W;
    const H = this._canvas.height;

    // Background.
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, W, H);

    // Column headers.
    ctx.fillStyle = '#7070a0';
    ctx.font      = '9px monospace';
    ctx.textAlign = 'center';
    for (let col = 0; col < 4; col++) {
      const cx = LABEL_W + col * (CELL_W + CELL_GAP) + CELL_W / 2;
      ctx.fillText(TRAIT_LABELS[col], cx, HEADER_H - 5);
    }

    // Variant rows.
    for (let row = 0; row < topVariants.length && row < MAX_ROWS; row++) {
      const varId  = topVariants[row];
      const genome = census.meanGenome[varId];
      const y      = HEADER_H + row * ROW_H;

      // Variant label — coloured dot + ID number.
      const rgba = VARIANT_PALETTE[varId & 0xFF];
      const r    =  rgba        & 0xFF;
      const g    = (rgba >>  8) & 0xFF;
      const b    = (rgba >> 16) & 0xFF;

      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(10, y + ROW_H / 2, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#a0a0c0';
      ctx.font      = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(varId), LABEL_W - 4, y + ROW_H / 2 + 4);

      // Four nibble cells: spread(0), decay(1), toxin(2), nutrient(3).
      for (let nibble = 0; nibble < 4; nibble++) {
        const tier  = extractNibble(genome, nibble as 0 | 1 | 2 | 3);
        const cellX = LABEL_W + nibble * (CELL_W + CELL_GAP);
        const cellY = y + CELL_PAD;
        const cellH = ROW_H - CELL_PAD * 2;

        ctx.fillStyle = nibbleToColor(tier);
        ctx.fillRect(cellX, cellY, CELL_W, cellH);

        // Tier number overlay.
        ctx.fillStyle = '#ffffffb0';
        ctx.font      = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(tier), cellX + CELL_W / 2, cellY + cellH / 2 + 4);
      }
    }

    // Border.
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
}
