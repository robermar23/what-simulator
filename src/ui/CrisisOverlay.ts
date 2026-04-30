/**
 * @fileoverview Crisis event overlay UI for the What Simulator (Phase 23).
 *
 * Renders three distinct visual states:
 *
 *   1. **Warning banner** (200 ticks before crisis onset):
 *      A collapsible amber/red panel at the top of the canvas showing the
 *      incoming crisis type, its description, and a countdown timer.
 *
 *   2. **Active crisis overlay**:
 *      A pulsing red border around the simulation canvas and a compact
 *      status pill showing the crisis type and ticks remaining.
 *
 *   3. **Milestone toasts**:
 *      Brief popup messages that appear bottom-right when a milestone is
 *      achieved (new variant, population boom, etc.) showing the ATP reward.
 *
 * ## Engagement psychology
 *   - The warning countdown creates *urgency* — players scramble to spend ATP.
 *   - The red canvas border signals danger state viscerally, not decoratively.
 *   - Toasts provide positive reinforcement without interrupting the simulation.
 *
 * ## Usage
 * ```ts
 * const overlay = new CrisisOverlay(
 *   document.getElementById('canvas-container')!,
 *   document.getElementById('toast-root')!,
 * );
 * ```
 */

import { bus }                                     from '../state/EventBus.js';
import { CRISIS_NAMES, CRISIS_DESCRIPTIONS }       from '../simulation/events/CrisisScheduler.js';
import { type CrisisType }                         from '../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// CrisisOverlay class
// ---------------------------------------------------------------------------

/**
 * Self-managing crisis UI overlay.
 * Subscribes to `crisisChange` and `milestoneAchieved` on construction.
 */
export class CrisisOverlay {
  /** Container around the simulation canvas (gets the pulsing border). */
  private readonly _canvasContainer: HTMLElement;

  /** Element where milestone toast messages are appended. */
  private readonly _toastRoot: HTMLElement;

  /** The warning banner element (created lazily). */
  private _warningBanner: HTMLElement | null = null;

  /** The active crisis pill element (created lazily). */
  private _activePill: HTMLElement | null = null;

  /**
   * @param canvasContainer - Element wrapping the simulation canvas.
   * @param toastRoot       - Element in which milestone toasts are appended.
   */
  constructor(canvasContainer: HTMLElement, toastRoot: HTMLElement) {
    this._canvasContainer = canvasContainer;
    this._toastRoot       = toastRoot;
    this._injectStyles();
    this._subscribe();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Subscribes to the EventBus events that drive the overlay.
   */
  private _subscribe(): void {
    bus.on('crisisChange', ({ crisis, ticksRemaining, active }) => {
      if (crisis === 'none') {
        this._hideBanner();
        this._hidePill();
        this._canvasContainer.classList.remove('crisis-active-border');
      } else if (!active) {
        // Warning phase — ticksRemaining is negative (counts down to 0).
        const countdown = Math.abs(ticksRemaining);
        this._showWarningBanner(crisis, countdown);
        this._hidePill();
        this._canvasContainer.classList.remove('crisis-active-border');
      } else {
        // Active crisis phase.
        this._hideBanner();
        this._showActivePill(crisis, ticksRemaining);
        this._canvasContainer.classList.add('crisis-active-border');
      }
    });

    bus.on('milestoneAchieved', ({ message }) => {
      this._showToast(message);
    });
  }

  // -------------------------------------------------------------------------
  // Warning banner
  // -------------------------------------------------------------------------

  /**
   * Shows or updates the pre-crisis warning banner.
   *
   * @param crisis    - Incoming crisis type.
   * @param countdown - Ticks until crisis onset.
   */
  private _showWarningBanner(crisis: CrisisType, countdown: number): void {
    if (!this._warningBanner) {
      this._warningBanner = document.createElement('div');
      this._warningBanner.className = 'crisis-warning-banner';
      // Insert before the canvas container so it appears above the simulation.
      this._canvasContainer.insertAdjacentElement('beforebegin', this._warningBanner);
    }

    const name  = CRISIS_NAMES[crisis];
    const desc  = CRISIS_DESCRIPTIONS[crisis];
    const pct   = Math.min(countdown / 200, 1);

    this._warningBanner.innerHTML = `
      <div class="crisis-banner-inner">
        <div class="crisis-banner-header">
          <span class="crisis-icon">☢</span>
          <strong class="crisis-name">${name} approaching</strong>
          <span class="crisis-countdown">${countdown} ticks</span>
        </div>
        <p class="crisis-desc">${desc}</p>
        <div class="crisis-progress-track">
          <div class="crisis-progress-fill" style="width:${((1 - pct) * 100).toFixed(1)}%"></div>
        </div>
      </div>
    `;
  }

  /** Removes the warning banner from the DOM. */
  private _hideBanner(): void {
    this._warningBanner?.remove();
    this._warningBanner = null;
  }

  // -------------------------------------------------------------------------
  // Active crisis pill
  // -------------------------------------------------------------------------

  /**
   * Shows or updates the compact active-crisis status pill.
   *
   * @param crisis         - Active crisis type.
   * @param ticksRemaining - Ticks until the crisis ends.
   */
  private _showActivePill(crisis: CrisisType, ticksRemaining: number): void {
    if (!this._activePill) {
      this._activePill = document.createElement('div');
      this._activePill.className = 'crisis-active-pill';
      document.body.appendChild(this._activePill);
    }
    const name = CRISIS_NAMES[crisis];
    this._activePill.innerHTML = `<span class="crisis-icon">⚠</span> ${name} — ${ticksRemaining} ticks`;
  }

  /** Removes the active crisis pill. */
  private _hidePill(): void {
    this._activePill?.remove();
    this._activePill = null;
  }

  // -------------------------------------------------------------------------
  // Milestone toast
  // -------------------------------------------------------------------------

  /**
   * Shows a brief toast notification for a milestone reward.
   * Auto-dismissed after 3 seconds.
   *
   * @param message - Human-readable milestone message.
   */
  private _showToast(message: string): void {
    const toast = document.createElement('div');
    toast.className   = 'milestone-toast';
    toast.textContent = message;
    this._toastRoot.appendChild(toast);

    // Slide in after a brief delay (allows the CSS transition to fire).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.add('milestone-toast-visible');
      });
    });

    // Auto-dismiss after 3 seconds.
    setTimeout(() => {
      toast.classList.remove('milestone-toast-visible');
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  }

  // -------------------------------------------------------------------------
  // CSS injection
  // -------------------------------------------------------------------------

  /**
   * Injects component-scoped CSS once into the document head.
   */
  private _injectStyles(): void {
    if (document.getElementById('crisis-overlay-styles')) return;

    const style = document.createElement('style');
    style.id    = 'crisis-overlay-styles';
    style.textContent = `
      /* ------------------------------------------------------------------ */
      /* Warning banner                                                       */
      /* ------------------------------------------------------------------ */
      .crisis-warning-banner {
        background: linear-gradient(90deg,
          rgba(255, 96, 48, 0.15) 0%,
          rgba(255, 160, 0, 0.12) 100%);
        border: 1px solid rgba(255, 96, 48, 0.5);
        border-radius: 4px;
        margin-block-end: 8px;
        animation: crisis-banner-pulse 1.2s ease-in-out infinite alternate;
      }

      @keyframes crisis-banner-pulse {
        from { border-color: rgba(255, 96, 48, 0.4); }
        to   { border-color: rgba(255, 96, 48, 0.9); }
      }

      .crisis-banner-inner {
        padding: 10px 14px;
      }

      .crisis-banner-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-block-end: 4px;
      }

      .crisis-icon {
        font-size: 16px;
        flex-shrink: 0;
      }

      .crisis-name {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        color: var(--c-accent-warn, #ff6030);
        flex: 1;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .crisis-countdown {
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        color: var(--c-text, #c8dde8);
        opacity: 0.8;
      }

      .crisis-desc {
        font-size: 12px;
        color: var(--c-text, #c8dde8);
        opacity: 0.75;
        margin: 0 0 8px 0;
        line-height: 1.4;
      }

      /* Progress bar drains left-to-right as countdown approaches zero */
      .crisis-progress-track {
        height: 3px;
        background: var(--c-substrate, #0a0d0f);
        border-radius: 2px;
        overflow: hidden;
      }

      .crisis-progress-fill {
        height: 100%;
        background: var(--c-accent-warn, #ff6030);
        border-radius: 2px;
        transition: width 1s linear;
      }

      /* ------------------------------------------------------------------ */
      /* Active crisis: canvas border                                         */
      /* ------------------------------------------------------------------ */
      .crisis-active-border {
        outline: 2px solid rgba(255, 96, 48, 0.7) !important;
        outline-offset: -2px;
        animation: crisis-border-pulse 0.8s ease-in-out infinite alternate;
      }

      @keyframes crisis-border-pulse {
        from { outline-color: rgba(255, 96, 48, 0.5); }
        to   { outline-color: rgba(255, 96, 48, 1.0); }
      }

      /* ------------------------------------------------------------------ */
      /* Active crisis pill                                                   */
      /* ------------------------------------------------------------------ */
      .crisis-active-pill {
        position: fixed;
        inset-block-start: 12px;
        inset-inline-start: 50%;
        transform: translateX(-50%);
        background: rgba(255, 96, 48, 0.18);
        border: 1px solid rgba(255, 96, 48, 0.6);
        color: var(--c-accent-warn, #ff6030);
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        padding: 5px 14px;
        border-radius: 20px;
        z-index: 9000;
        pointer-events: none;
        letter-spacing: 0.04em;
        animation: crisis-pill-pulse 0.8s ease-in-out infinite alternate;
      }

      @keyframes crisis-pill-pulse {
        from { opacity: 0.75; }
        to   { opacity: 1.0;  }
      }

      /* ------------------------------------------------------------------ */
      /* Milestone toast                                                      */
      /* ------------------------------------------------------------------ */
      .milestone-toast {
        background: rgba(0, 238, 255, 0.12);
        border: 1px solid rgba(0, 238, 255, 0.35);
        color: var(--c-accent-chem, #00eeff);
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        padding: 8px 14px;
        border-radius: 4px;
        margin-block-start: 6px;
        transform: translateX(110%);
        transition: transform 0.3s ease, opacity 0.3s ease;
        opacity: 0;
        pointer-events: none;
      }

      .milestone-toast.milestone-toast-visible {
        transform: translateX(0);
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }
}
