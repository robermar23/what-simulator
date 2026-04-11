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
import { DrawingTools } from './ui/DrawingTools.js';
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

  const controlPanel = new ControlPanel();
  controlPanel.mount(panelContainer);

  // --- Start the application ------------------------------------------------

  const app = new App(canvas);
  app.start();

  // --- Mount drawing tools on the canvas -----------------------------------
  // DrawingTools translates pointer events into paintCell calls on the App.
  // Right-click is suppressed from the browser context menu (erase mode).
  const drawingTools = new DrawingTools();
  drawingTools.mount(canvas, (cellX, cellY, type) => {
    app.paintCell(cellX, cellY, type);
  });

  // Wire step-requested from toolbar to app (the DOM event bubbles to window).
  // Already handled inside App via the window event listener.

  // --- Snapshot download ----------------------------------------------------
  // In Phase 4 the canvas is owned by the RenderWorker; snapshots come back
  // as blob URLs via the EventBus `snapshotReady` event.
  bus.on('snapshotReady', ({ url }) => {
    const link    = document.createElement('a');
    link.href     = url;
    link.download = `what-simulator-${Date.now()}.png`;
    link.click();
    // Revoke the object URL after the download is triggered to free memory.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // --- Status bar updates ---------------------------------------------------

  if (statusBar) {
    // In Phase 4, all status-bar data comes from fpsUpdate (tickNum is now
    // included in the payload — no separate 'tick' bus listener needed).
    bus.on('fpsUpdate', ({ fps, tickNum, liveCells, variantCells }) => {
      // Show variant count only when variants actually exist, to avoid
      // cluttering the status bar during normal (no-mutation) runs.
      const variantInfo = variantCells > 0
        ? `  |  Variant B: ${variantCells.toLocaleString()}`
        : '';

      statusBar.textContent =
        `Tick: ${tickNum}  |  FPS: ${Math.round(fps)}  |  Live: ${liveCells.toLocaleString()}${variantInfo}`;
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
