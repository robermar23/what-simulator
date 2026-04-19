/**
 * @fileoverview Toolbar component for the What Simulator.
 *
 * Renders and manages the top control bar:
 *   [Play/Pause]  [Step]  [Reset]  Ticks/sec: [slider]  [Snapshot]
 *
 * The component owns its DOM nodes and wires them to AppState / EventBus.
 * It does NOT do any simulation work — it only reads and writes AppState.
 */

import { appState } from '../state/AppState.js';
import { bus } from '../state/EventBus.js';
import { type RenderMode } from '../workers/workerBridge.js';

// ---------------------------------------------------------------------------
// Toolbar class
// ---------------------------------------------------------------------------

/**
 * Top-bar toolbar component.
 *
 * Mount it by calling {@link Toolbar.mount} with the target container element.
 */
export class Toolbar {
  // DOM references — held so we can update them reactively.
  private _playBtn!: HTMLButtonElement;
  private _stepBtn!: HTMLButtonElement;
  private _resetBtn!: HTMLButtonElement;
  private _speedSlider!: HTMLInputElement;
  private _speedLabel!: HTMLSpanElement;
  private _snapshotBtn!: HTMLButtonElement;

  /**
   * Builds and inserts the toolbar DOM into `container`.
   *
   * @param container - The element to append the toolbar into.
   */
  mount(container: HTMLElement): void {
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Simulation controls');

    // --- Play / Pause button -----------------------------------------------
    this._playBtn = this._makeButton('▶ Play', 'btn btn-primary', () => {
      appState.running = !appState.running;
    });
    this._playBtn.setAttribute('title', 'Play / Pause (Space)');

    // --- Step button (advance one tick while paused) -----------------------
    this._stepBtn = this._makeButton('⏭ Step', 'btn', () => {
      // The app loop listens for this event and advances one tick.
      bus.emit('reset', {});  // repurpose reset? No — emit a dedicated signal.
      // We'll use a custom approach: expose a step callback via AppState.
      // For Phase 1, step is handled in App.ts which holds the engine ref.
      this._stepBtn.dispatchEvent(new CustomEvent('step-requested', { bubbles: true }));
    });
    this._stepBtn.setAttribute('title', 'Step one tick (→)');

    // --- Reset button -------------------------------------------------------
    this._resetBtn = this._makeButton('↺ Reset', 'btn', () => {
      bus.emit('reset', {});
    });
    this._resetBtn.setAttribute('title', 'Reset simulation (R)');

    // --- Speed slider -------------------------------------------------------
    const speedGroup = document.createElement('div');
    speedGroup.className = 'toolbar-group';

    const speedLabelEl = document.createElement('label');
    speedLabelEl.textContent = 'Ticks/sec:';
    speedLabelEl.htmlFor = 'speed-slider';
    speedLabelEl.className = 'toolbar-label';

    this._speedSlider = document.createElement('input');
    this._speedSlider.type  = 'range';
    this._speedSlider.id    = 'speed-slider';
    this._speedSlider.min   = '1';
    this._speedSlider.max   = '60';
    this._speedSlider.step  = '1';
    this._speedSlider.value = String(appState.hz);
    this._speedSlider.className = 'slider';
    this._speedSlider.setAttribute('aria-label', 'Simulation speed in ticks per second');
    this._speedSlider.addEventListener('input', () => {
      appState.hz = Number(this._speedSlider.value);
    });

    this._speedLabel = document.createElement('span');
    this._speedLabel.className = 'toolbar-value';
    this._speedLabel.textContent = String(appState.hz);

    speedGroup.append(speedLabelEl, this._speedSlider, this._speedLabel);

    // --- Snapshot button ----------------------------------------------------
    this._snapshotBtn = this._makeButton('📷 Snapshot', 'btn btn-secondary', () => {
      this._takeSnapshot();
    });
    this._snapshotBtn.setAttribute('title', 'Save as PNG');

    // Assemble toolbar.
    toolbar.append(
      this._playBtn,
      this._stepBtn,
      this._resetBtn,
      speedGroup,
      this._snapshotBtn,
    );
    container.append(toolbar);

    // --- Subscribe to state changes ----------------------------------------
    bus.on('playStateChange', ({ running }) => {
      this._playBtn.textContent = running ? '⏸ Pause' : '▶ Play';
      this._playBtn.setAttribute('aria-pressed', String(running));
      // Step only makes sense when paused.
      this._stepBtn.disabled = running;
    });

    bus.on('speedChange', ({ hz }) => {
      this._speedSlider.value  = String(hz);
      this._speedLabel.textContent = String(hz);
    });

    // Keyboard shortcuts.
    window.addEventListener('keydown', this._onKeyDown.bind(this));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Creates a styled `<button>` element.
   *
   * @param label - Button text content.
   * @param className - CSS class string.
   * @param onClick - Click handler.
   * @returns The new button element.
   */
  private _makeButton(
    label: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className   = className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Handles global keyboard shortcuts.
   *
   * @param e - The keyboard event.
   */
  private _onKeyDown(e: KeyboardEvent): void {
    // Ignore shortcuts when typing in an input or textarea.
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case ' ':
        e.preventDefault(); // prevent page scroll
        appState.running = !appState.running;
        break;
      case 'r':
      case 'R':
        bus.emit('reset', {});
        break;
      case 'ArrowRight':
        if (!appState.running) {
          this._stepBtn.dispatchEvent(new CustomEvent('step-requested', { bubbles: true }));
        }
        break;
      // Phase 6 — grid lines toggle.
      case 'g':
      case 'G':
        appState.showGridLines = !appState.showGridLines;
        break;
      // Phase 6 — zoom in/out via keyboard (+/=  and  -).
      case '+':
      case '=':
        appState.cellSize = appState.cellSize + 1;
        break;
      case '-':
        appState.cellSize = appState.cellSize - 1;
        break;
      // Phase 15 — cycle render mode through all available visualisation modes.
      case 't':
      case 'T':
        this._cycleRenderMode();
        break;
      // Phase 15 — toggle variant-ID / signal render modes (quick lineage view).
      case 'v':
      case 'V':
        appState.renderMode =
          appState.renderMode === 'variantId' ? 'signal' : 'variantId';
        break;
    }
  }

  /**
   * Cycles `appState.renderMode` through all valid visualisation modes in order.
   *
   * Order: variantId → lifecycle → genome → generation → fitness → signal → variantId…
   */
  private _cycleRenderMode(): void {
    const modes: RenderMode[] = [
      'variantId', 'lifecycle', 'genome', 'generation', 'fitness', 'signal',
    ];
    const current = appState.renderMode;
    const idx     = modes.indexOf(current);
    appState.renderMode = modes[(idx + 1) % modes.length];
  }

  /**
   * Requests a PNG snapshot by emitting `snapshotRequested` on the EventBus.
   *
   * In Phase 4 the canvas has been transferred to the RenderWorker via
   * `transferControlToOffscreen()`, so the main thread can no longer call
   * `canvas.toDataURL()`.  Instead, the App relays the request to the
   * RenderWorker, which responds with a blob URL via `snapshotReady`.
   * The main thread then triggers the download inside `main.ts`.
   */
  private _takeSnapshot(): void {
    bus.emit('snapshotRequested', {});
  }
}
