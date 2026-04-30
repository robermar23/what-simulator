/**
 * @fileoverview ATP (resource currency) display bar for the What Simulator.
 *
 * Phase 23 — "The Economy":
 *
 * Renders a compact progress bar in the toolbar area showing:
 *   - A progress bar (fill proportion = atp / atpMax)
 *   - A numeric readout (e.g. "342 / 1000 ATP")
 *   - A cost badge on the active drawing tool (e.g. "⚡2")
 *   - An "insufficient funds" flash animation when a paint is rejected
 *
 * When economy mode is disabled the bar is hidden so it does not
 * clutter the UI for players who haven't opted in.
 *
 * ## Usage
 * ```ts
 * const atpDisplay = new ATPDisplay(document.getElementById('atp-bar')!);
 * ```
 * The component self-subscribes to the `atpChange` event and updates
 * automatically.  No manual refresh calls are needed.
 */

import { bus }       from '../state/EventBus.js';
import { appState }  from '../state/AppState.js';
import { ATP_COSTS } from '../simulation/economy/ATPSystem.js';

// ---------------------------------------------------------------------------
// ATPDisplay class
// ---------------------------------------------------------------------------

/**
 * Self-updating ATP progress bar component.
 *
 * Attaches to a provided container element and manages its own inner HTML.
 * Subscribes to `atpChange` on construction; no teardown needed for the
 * lifetime of the app.
 */
export class ATPDisplay {
  /** Root container element. */
  private readonly _root: HTMLElement;

  /** The filled portion of the progress bar. */
  private _fill!: HTMLElement;

  /** Numeric readout element. */
  private _label!: HTMLElement;

  /** Cost badge shown next to the active-tool indicator. */
  private _costBadge!: HTMLElement;

  /** Current ATP value (integer). */
  private _atp = 0;

  /** Maximum ATP pool size. */
  private _max = 1000;

  /**
   * @param container - Element that will contain the ATP bar markup.
   */
  constructor(container: HTMLElement) {
    this._root = container;
    this._render();
    this._subscribe();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Writes the initial ATP bar markup into the container.
   */
  private _render(): void {
    this._root.innerHTML = `
      <div class="atp-bar-wrap" title="ATP — your resource currency. Earn by watching cells evolve.">
        <span class="atp-icon">⚡</span>
        <div class="atp-track">
          <div class="atp-fill" style="width:50%"></div>
        </div>
        <span class="atp-label">500 / 1000</span>
        <span class="atp-cost-badge" aria-hidden="true"></span>
      </div>
    `;

    this._fill      = this._root.querySelector('.atp-fill') as HTMLElement;
    this._label     = this._root.querySelector('.atp-label') as HTMLElement;
    this._costBadge = this._root.querySelector('.atp-cost-badge') as HTMLElement;

    this._injectStyles();
  }

  /**
   * Injects component-scoped CSS once into the document head.
   * Uses a sentinel id to avoid duplicate injection on hot-reload.
   */
  private _injectStyles(): void {
    if (document.getElementById('atp-display-styles')) return;

    const style = document.createElement('style');
    style.id    = 'atp-display-styles';
    style.textContent = `
      /* ATP bar container — sits in the toolbar row */
      .atp-bar-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        background: var(--c-gel, #111820);
        border: 1px solid var(--c-membrane, #1e3040);
        border-radius: 4px;
        cursor: default;
        user-select: none;
      }

      /* Lightning bolt icon */
      .atp-icon {
        font-size: 13px;
        color: var(--c-accent-chem, #00eeff);
        flex-shrink: 0;
      }

      /* Track (background of the bar) */
      .atp-track {
        width: 100px;
        height: 8px;
        background: var(--c-substrate, #0a0d0f);
        border: 1px solid var(--c-membrane, #1e3040);
        border-radius: 2px;
        overflow: hidden;
        flex-shrink: 0;
      }

      /* Fill — changes colour near depletion */
      .atp-fill {
        height: 100%;
        background: var(--c-accent-chem, #00eeff);
        border-radius: 2px;
        transition: width 0.15s ease, background 0.3s ease;
      }

      .atp-fill.atp-low {
        background: var(--c-accent-warn, #ff6030);
      }

      /* Numeric readout */
      .atp-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: var(--c-text, #c8dde8);
        white-space: nowrap;
        min-width: 80px;
      }

      /* Cost badge — shown beside the active-tool readout */
      .atp-cost-badge {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: var(--c-accent-warn, #ff6030);
        white-space: nowrap;
      }

      /* Insufficient-funds flash animation */
      @keyframes atp-flash {
        0%   { background: rgba(255, 96, 48, 0.35); }
        100% { background: transparent; }
      }

      .atp-bar-wrap.atp-insufficient {
        animation: atp-flash 0.4s ease-out;
      }

      /* Hide when economy is disabled */
      .atp-bar-wrap.atp-hidden {
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Subscribes to EventBus events that affect the ATP display.
   */
  private _subscribe(): void {
    bus.on('atpChange', ({ atp, atpMax, enabled }) => {
      this._atp = atp;
      this._max = atpMax;
      this._update(enabled);
    });

    // Update the cost badge whenever the active tool changes.
    // DrawingTools calls appState.activeTool setter — there is no bus event
    // for it, so we use a pointer-event listener on the canvas toolbar instead.
    // A cheap workaround: re-derive cost on every configChange (fires often).
    bus.on('configChange', () => {
      this._refreshCostBadge();
    });
  }

  /**
   * Updates all visual elements to reflect the current ATP state.
   *
   * @param enabled - True when economy mode is active.
   */
  private _update(enabled: boolean): void {
    const wrap = this._root.querySelector('.atp-bar-wrap') as HTMLElement;

    if (!enabled) {
      wrap.classList.add('atp-hidden');
      return;
    }
    wrap.classList.remove('atp-hidden');

    const pct = this._max > 0 ? Math.min(this._atp / this._max, 1) : 0;
    this._fill.style.width = `${(pct * 100).toFixed(1)}%`;
    this._fill.classList.toggle('atp-low', pct < 0.15);
    this._label.textContent = `${this._atp} / ${this._max} ATP`;

    this._refreshCostBadge();
  }

  /**
   * Refreshes the cost badge to show the current tool's ATP cost.
   */
  private _refreshCostBadge(): void {
    const tool = appState.activeTool;
    const cost = ATP_COSTS[tool] ?? 0;
    this._costBadge.textContent = cost > 0 ? `⚡${cost}/cell` : '';
  }

  /**
   * Plays a brief red flash on the bar to signal an insufficient-funds
   * rejection.  Called by DrawingTools when a paint is blocked.
   */
  flashInsufficient(): void {
    const wrap = this._root.querySelector('.atp-bar-wrap') as HTMLElement;
    wrap.classList.remove('atp-insufficient');
    // Force reflow so the animation restarts cleanly.
    void wrap.offsetWidth;
    wrap.classList.add('atp-insufficient');
    setTimeout(() => wrap.classList.remove('atp-insufficient'), 450);
  }
}
