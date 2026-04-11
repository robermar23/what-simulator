/**
 * @fileoverview Hover tooltip component for the What Simulator.
 *
 * Displays a small floating panel near the cursor that shows information
 * about the grid cell currently under the pointer:
 *   - Cell type name
 *   - Energy level (formatted to 2 decimal places)
 *   - Age in simulation ticks
 *   - Grid coordinates (column × row)
 *
 * The tooltip follows the cursor using `position: fixed` and is hidden when
 * the cursor leaves the canvas or when {@link Tooltip.hide} is called.
 *
 * Phase 6.
 */

import { CellType } from '../simulation/GridState.js';
import { type CellInfo } from '../app.js';

// ---------------------------------------------------------------------------
// Cell type name table
// ---------------------------------------------------------------------------

/**
 * Human-readable names for every CellType enum value.
 * Indexed by the raw numeric CellType so lookup is O(1).
 */
const CELL_TYPE_NAMES: Readonly<Record<number, string>> = {
  [CellType.Empty]:       'Empty',
  [CellType.Life]:        'Life',
  [CellType.Wall]:        'Wall',
  [CellType.Toxin]:       'Toxin',
  [CellType.Nutrient]:    'Nutrient',
  [CellType.Drain]:       'Drain',
  [CellType.GravityWell]: 'Gravity Well',
  [CellType.Barrier]:     'Barrier',
  [CellType.Fire]:        'Fire',
  [CellType.Ice]:         'Ice',
  [CellType.LifeVariant]: 'Life Variant B',
};

/** Fallback label when the CellType is unknown or unregistered. */
const UNKNOWN_TYPE = 'Unknown';

// ---------------------------------------------------------------------------
// Offset to keep the tooltip from being clipped at viewport edges
// ---------------------------------------------------------------------------

/** Horizontal pixel gap between cursor and tooltip left edge. */
const OFFSET_X = 14;

/** Vertical pixel gap between cursor and tooltip top edge. */
const OFFSET_Y = 10;

// ---------------------------------------------------------------------------
// Tooltip class
// ---------------------------------------------------------------------------

/**
 * Lightweight hover tooltip that shows cell state information.
 *
 * Usage:
 * ```ts
 * const tooltip = new Tooltip();
 * tooltip.mount(document.body);
 *
 * canvas.addEventListener('mousemove', (e) => {
 *   const info = app.getCellInfo(cellX, cellY);
 *   if (info) tooltip.show(info, e.clientX, e.clientY);
 * });
 * canvas.addEventListener('mouseleave', () => tooltip.hide());
 * ```
 */
export class Tooltip {
  /** The root tooltip DOM element (a `<div>`). */
  private _el: HTMLDivElement | null = null;

  /** Span showing the cell type name. */
  private _typeLine!: HTMLSpanElement;

  /** Span showing the energy reading. */
  private _energyLine!: HTMLSpanElement;

  /** Span showing the age reading. */
  private _ageLine!: HTMLSpanElement;

  /** Span showing the coordinate pair. */
  private _coordLine!: HTMLSpanElement;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Creates the tooltip element and appends it to `container`.
   * The element is hidden by default until {@link show} is called.
   *
   * @param container - The element to append the tooltip into (typically `document.body`).
   */
  mount(container: HTMLElement): void {
    const el = document.createElement('div');
    el.className    = 'cell-tooltip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-live', 'off');

    // --- Type line (heading) ------------------------------------------------
    const typeLine = document.createElement('span');
    typeLine.className = 'cell-tooltip-type';
    this._typeLine = typeLine;

    // --- Separator ----------------------------------------------------------
    const sep = document.createElement('hr');
    sep.className = 'cell-tooltip-sep';

    // --- Detail lines -------------------------------------------------------
    const energyLine = document.createElement('span');
    energyLine.className = 'cell-tooltip-row';
    this._energyLine = energyLine;

    const ageLine = document.createElement('span');
    ageLine.className = 'cell-tooltip-row';
    this._ageLine = ageLine;

    const coordLine = document.createElement('span');
    coordLine.className = 'cell-tooltip-row cell-tooltip-coord';
    this._coordLine = coordLine;

    el.append(typeLine, sep, energyLine, ageLine, coordLine);
    container.append(el);
    this._el = el;
    // Start hidden.
    el.setAttribute('aria-hidden', 'true');
  }

  /**
   * Positions and populates the tooltip with `info`, then makes it visible.
   *
   * The tooltip is offset from `(clientX, clientY)` by {@link OFFSET_X} /
   * {@link OFFSET_Y} pixels and automatically flipped horizontally if it
   * would overflow the right edge of the viewport.
   *
   * @param info    - Cell state snapshot from {@link App.getCellInfo}.
   * @param clientX - Cursor X position in viewport coordinates.
   * @param clientY - Cursor Y position in viewport coordinates.
   */
  show(info: CellInfo, clientX: number, clientY: number): void {
    if (!this._el) return;

    // Populate content.
    const typeName = CELL_TYPE_NAMES[info.cellType] ?? UNKNOWN_TYPE;
    this._typeLine.textContent  = typeName;
    this._energyLine.textContent = `Energy: ${info.energy.toFixed(2)}`;
    this._ageLine.textContent    = `Age:    ${info.age} ticks`;
    this._coordLine.textContent  = `(${info.cellX}, ${info.cellY})`;

    // Position tooltip — start with offset to the right.
    let left = clientX + OFFSET_X;
    const top  = clientY + OFFSET_Y;

    // Flip left if the tooltip would overflow the right viewport edge.
    const tooltipWidth = this._el.offsetWidth || 140;
    if (left + tooltipWidth > window.innerWidth) {
      left = clientX - tooltipWidth - OFFSET_X;
    }

    this._el.style.left = `${left}px`;
    this._el.style.top  = `${top}px`;
    this._el.removeAttribute('aria-hidden');
    this._el.classList.add('visible');
  }

  /**
   * Hides the tooltip without removing it from the DOM.
   * Safe to call when the tooltip is already hidden.
   */
  hide(): void {
    if (!this._el) return;
    this._el.classList.remove('visible');
    this._el.setAttribute('aria-hidden', 'true');
  }

  /**
   * Removes the tooltip element from the DOM and releases references.
   * Call when the parent component is torn down.
   */
  unmount(): void {
    this._el?.remove();
    this._el = null;
  }
}
