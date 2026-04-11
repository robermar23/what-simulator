/**
 * @fileoverview Application entry point for the What Simulator.
 *
 * Responsibilities:
 *   1. Wait for the DOM to be ready.
 *   2. Find the required DOM elements (canvas, toolbar container, panel).
 *   3. Mount UI components (Toolbar, ControlPanel).
 *   4. Instantiate and start the App (simulation + render loop).
 *
 * Everything that requires a live DOM reference lives here.  All logic lives
 * in the other modules — this file is intentionally thin.
 */

import { App } from './app.js';
import { Toolbar } from './ui/Toolbar.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { bus } from './state/EventBus.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Bootstraps the whole application once the DOM is ready.
 */
function bootstrap(): void {
  // --- Locate required DOM elements ----------------------------------------

  const canvas = document.getElementById('sim-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error('bootstrap: #sim-canvas element not found in the DOM.');
  }

  const toolbarContainer = document.getElementById('toolbar-container');
  if (!toolbarContainer) {
    throw new Error('bootstrap: #toolbar-container element not found.');
  }

  const panelContainer = document.getElementById('panel-container');
  if (!panelContainer) {
    throw new Error('bootstrap: #panel-container element not found.');
  }

  const statusBar = document.getElementById('status-bar');

  // --- Mount UI components --------------------------------------------------

  const toolbar = new Toolbar();
  toolbar.mount(toolbarContainer);
  toolbar.setCanvas(canvas);

  const controlPanel = new ControlPanel();
  controlPanel.mount(panelContainer);

  // --- Start the application ------------------------------------------------

  const app = new App(canvas);
  app.start();

  // Wire step-requested from toolbar to app (the DOM event bubbles to window).
  // Already handled inside App via the window event listener.

  // --- Status bar updates ---------------------------------------------------

  if (statusBar) {
    let currentTick = 0;
    let currentFps  = 0;
    let currentLive = 0;

    bus.on('tick', ({ tick }) => {
      currentTick = tick;
    });

    bus.on('fpsUpdate', ({ fps, liveCells }) => {
      currentFps  = Math.round(fps);
      currentLive = liveCells;
      statusBar.textContent =
        `Tick: ${currentTick}  |  FPS: ${currentFps}  |  Live cells: ${currentLive.toLocaleString()}`;
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  // DOMContentLoaded already fired (e.g. script loaded via defer).
  bootstrap();
}
