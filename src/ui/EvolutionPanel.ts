/**
 * @fileoverview Evolution Visualization Panel for the What Simulator.
 *
 * Mounts three collapsible chart sections into the left sidebar:
 *
 * 1. **Population Timeline** — {@link PopulationChart}: stacked area chart
 *    showing variant population percentages over the last N censuses.
 *
 * 2. **Genome Profile** — {@link GenomeHeatmap}: colour-coded grid showing
 *    the four heritable trait tiers (spread, decay, toxin, nutrient) for the
 *    most populous active variants.
 *
 * 3. **Phylogenetic Tree** — {@link PhylogeneticTree}: left-to-right tree
 *    of all variant lineages tracked by {@link VariantRegistry}.
 *
 * Each section is a native `<details>` element that starts collapsed, so the
 * panel does not overwhelm the sidebar on first load.  Users open whichever
 * chart they want to inspect.
 *
 * ## Usage
 * ```ts
 * const panel = new EvolutionPanel();
 * panel.mount(panelContainer);
 * // ... later ...
 * panel.unmount();
 * ```
 */

import { PopulationChart }  from '../rendering/PopulationChart.js';
import { GenomeHeatmap }    from '../rendering/GenomeHeatmap.js';
import { PhylogeneticTree } from '../rendering/PhylogeneticTree.js';

// ---------------------------------------------------------------------------
// EvolutionPanel class
// ---------------------------------------------------------------------------

/**
 * Sidebar panel housing all three evolution visualisation charts.
 *
 * Appended after the ControlPanel in {@link HTMLElement #panel-container}.
 * Each chart is independently collapsible via native `<details>` semantics.
 */
export class EvolutionPanel {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** The outer container element created by {@link mount}. */
  private _aside: HTMLElement | null = null;

  /** Stacked area chart component. */
  private readonly _chart = new PopulationChart();

  /** Genome trait heatmap component. */
  private readonly _heatmap = new GenomeHeatmap();

  /** Phylogenetic tree component. */
  private readonly _tree = new PhylogeneticTree();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Builds the panel DOM and mounts all three chart components.
   *
   * @param container - The `#panel-container` element to append into.
   */
  mount(container: HTMLElement): void {
    const aside = document.createElement('aside');
    aside.className    = 'evolution-panel';
    aside.setAttribute('aria-label', 'Evolution visualisations');

    // --- Section 1: Population Timeline ------------------------------------
    const chartSection = this._makeSection('Population Timeline');
    const chartBody    = chartSection.querySelector('.evo-section-body') as HTMLElement;
    this._chart.mount(chartBody);
    aside.append(chartSection);

    // --- Section 2: Genome Profile -----------------------------------------
    const heatSection = this._makeSection('Genome Profile');
    const heatBody    = heatSection.querySelector('.evo-section-body') as HTMLElement;
    this._heatmap.mount(heatBody);
    aside.append(heatSection);

    // --- Section 3: Phylogenetic Tree --------------------------------------
    const treeSection = this._makeSection('Phylogenetic Tree');
    const treeBody    = treeSection.querySelector('.evo-section-body') as HTMLElement;
    this._tree.mount(treeBody);
    aside.append(treeSection);

    container.append(aside);
    this._aside = aside;
  }

  /**
   * Unmounts all chart components and removes the panel from the DOM.
   * Safe to call if {@link mount} was never called.
   */
  unmount(): void {
    this._chart.unmount();
    this._heatmap.unmount();
    this._tree.unmount();
    this._aside?.remove();
    this._aside = null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Creates a collapsible `<details>` section with a `<summary>` heading and
   * an inner `.evo-section-body` div where chart canvases are appended.
   *
   * The section starts collapsed so it does not dominate the sidebar on load.
   *
   * @param title - Human-readable section heading text.
   * @returns The `<details>` element containing a body div.
   */
  private _makeSection(title: string): HTMLDetailsElement {
    const details     = document.createElement('details');
    details.className = 'evo-section';
    details.open      = false;

    const summary     = document.createElement('summary');
    summary.className = 'evo-section-heading';
    summary.textContent = title;

    const body        = document.createElement('div');
    body.className    = 'evo-section-body';

    details.append(summary, body);
    return details;
  }
}
