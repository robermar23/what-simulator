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
import { EvolutionPanel } from './ui/EvolutionPanel.js';
import { DrawingTools } from './ui/DrawingTools.js';
import { OverlayRenderer } from './rendering/OverlayRenderer.js';
import { BackgroundManager } from './rendering/BackgroundManager.js';
import { Tooltip } from './ui/Tooltip.js';
import { bus } from './state/EventBus.js';
import { appState } from './state/AppState.js';

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

  const statusBar     = document.getElementById('status-bar');
  const mainArea      = document.getElementById('main-area');
  const canvasContainer = document.getElementById('canvas-container');

  // --- Mount UI components --------------------------------------------------

  const toolbar = new Toolbar();
  toolbar.mount(toolbarContainer);

  const controlPanel = new ControlPanel();
  controlPanel.mount(panelContainer);

  // Phase 13: Evolution visualisation panels — appended below ControlPanel.
  const evolutionPanel = new EvolutionPanel();
  evolutionPanel.mount(panelContainer);

  // --- Start the application ------------------------------------------------

  const app = new App(canvas);
  app.start();

  // --- Mount drawing tools on the canvas -----------------------------------
  // DrawingTools translates pointer events into paintCell calls on the App.
  // Right-click suppresses the context menu (erase mode).
  // Phase 6: also handles scroll-wheel zoom, middle-drag pan, and hover events.
  const drawingTools = new DrawingTools();
  drawingTools.mount(canvas, (cellX, cellY, type) => {
    app.paintCell(cellX, cellY, type);
    // Repaint the overlay after every brush stroke so GravityWell arrows
    // appear / disappear immediately as the user paints or erases wells.
    overlay.repaint();
  });

  // --- Phase 14: canvas-frame wrapper (bg + sim + overlay stack) -----------
  // All three canvases live inside #canvas-frame so they can be shaped
  // together via CSS — e.g. `border-radius: 50%; overflow: hidden` for the
  // petri dish environment.  The frame is display:inline-block so it
  // shrink-wraps to the sim-canvas pixel size automatically.
  const canvasFrame = document.createElement('div');
  canvasFrame.id = 'canvas-frame';
  // Move the sim-canvas (already in the DOM from HTML) into the frame.
  canvas.parentElement?.insertBefore(canvasFrame, canvas);
  canvasFrame.appendChild(canvas);

  // Background canvas: absolutely positioned at inset 0 inside canvas-frame,
  // drawn by BackgroundManager in its own RAF loop.
  const bgCanvas = document.createElement('canvas');
  bgCanvas.id    = 'bg-canvas';
  bgCanvas.setAttribute('aria-hidden', 'true');
  canvasFrame.prepend(bgCanvas); // prepend so it sits behind sim-canvas (z-index)

  const bgManager = new BackgroundManager();
  bgManager.mount(bgCanvas);

  // Keep the env-{type} CSS class on canvas-frame in sync with the active
  // background so per-environment shapes (circle clip, box-shadow) apply.
  bus.on('backgroundChange', ({ type }) => {
    for (const cls of [...canvasFrame.classList]) {
      if (cls.startsWith('env-')) canvasFrame.classList.remove(cls);
    }
    if (type !== 'none') canvasFrame.classList.add(`env-${type}`);
  });

  // Restore the previously selected background (persisted in localStorage).
  if (appState.backgroundType !== 'none') {
    void bgManager.setBackground(appState.backgroundType);
    // Apply CSS class immediately; also fires the App→RenderWorker path.
    bus.emit('backgroundChange', { type: appState.backgroundType });
  }

  // --- Create overlay canvas for GravityWell arrows -------------------------
  // A transparent <canvas> above sim-canvas inside canvas-frame.
  // It never captures pointer events (pointer-events: none in CSS).
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.id    = 'overlay-canvas';
  overlayCanvas.setAttribute('aria-hidden', 'true');
  canvasFrame.append(overlayCanvas); // append so it sits above sim-canvas

  const overlay = new OverlayRenderer();
  overlay.mount(
    overlayCanvas,
    appState.cellSize,
    appState.gridWidth,
    appState.gridHeight,
    () => app.getWellIndices(),
  );

  // Repaint overlay whenever zoom level changes.
  bus.on('cellSizeChange', ({ cellSize }) => overlay.setCellSize(cellSize));
  // Repaint overlay on reset (all well cells are cleared).
  bus.on('reset', () => overlay.repaint());

  // --- Phase 6: Hover tooltip -----------------------------------------------
  // The tooltip is a fixed-position div that shows cell state information
  // when the cursor rests on a grid cell.  It reads from the SAB front buffer
  // via App.getCellInfo so no worker round-trip is needed.
  const tooltip = new Tooltip();
  tooltip.mount(document.body);

  bus.on('cellHover', ({ cellX, cellY }) => {
    if (cellX < 0 || cellY < 0) {
      // Cursor left the canvas.
      tooltip.hide();
      return;
    }
    const info = app.getCellInfo(cellX, cellY);
    if (!info) {
      tooltip.hide();
      return;
    }
    // Use the most-recent pointermove clientX/Y.  We proxy them via a closure
    // updated by a mousemove listener on the canvas so the tooltip follows
    // the cursor accurately even when the cell index hasn't changed.
    tooltip.show(info, _lastClientX, _lastClientY);
  });

  // Track cursor position for tooltip placement.
  let _lastClientX = 0;
  let _lastClientY = 0;
  canvas.addEventListener('mousemove', (e) => {
    _lastClientX = e.clientX;
    _lastClientY = e.clientY;
  });
  canvas.addEventListener('mouseleave', () => tooltip.hide());

  // --- Phase 6: Panel collapse toggle ---------------------------------------
  // A small button at the top of the canvas area lets the user collapse the
  // left panel to gain more canvas width.  The toggle stores its state via a
  // CSS class on #main-area.
  if (mainArea) {
    const collapseBtn = document.createElement('button');
    collapseBtn.id        = 'panel-collapse-btn';
    collapseBtn.className = 'btn panel-collapse-btn';
    collapseBtn.title     = 'Toggle control panel';
    collapseBtn.setAttribute('aria-label', 'Toggle control panel');
    collapseBtn.textContent = '◀';

    collapseBtn.addEventListener('click', () => {
      const collapsed = mainArea.classList.toggle('panel-collapsed');
      collapseBtn.textContent = collapsed ? '▶' : '◀';
      collapseBtn.setAttribute('aria-pressed', String(collapsed));
    });

    // Insert the button as the first child of the canvas container so it
    // is always visible in the top-left corner of the canvas area.
    if (canvasContainer) {
      canvasContainer.prepend(collapseBtn);
    }
  }

  // --- Snapshot download ----------------------------------------------------
  bus.on('snapshotReady', ({ url }) => {
    const link    = document.createElement('a');
    link.href     = url;
    link.download = `what-simulator-${Date.now()}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // --- Status bar updates ---------------------------------------------------

  if (statusBar) {
    bus.on('fpsUpdate', ({ fps, tickNum, liveCells, variantCells }) => {
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
