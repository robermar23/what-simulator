/**
 * @fileoverview Leaf surface procedural background for the What Simulator.
 *
 * Renders a magnified view of a leaf's upper epidermis — the surface cells
 * would be trying to colonise.  Features:
 *   - Green-to-yellow gradient base (chloroplast density gradient)
 *   - Fractal-like vein network (midrib + secondary + tertiary veins)
 *   - Waxy surface sheen (highlight diagonal across the leaf)
 *   - Stomata dots (tiny pores scattered across the surface)
 *   - Subtle "breathing" animation as the leaf transpires
 */

import { type Background } from '../BackgroundRenderer.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns branch endpoints for a secondary vein emerging from the midrib.
 *
 * Secondary veins fan outward from the midrib at regular intervals.  Each
 * vein arcs toward the leaf margin and then turns slightly upward.
 *
 * @param index    - 0-based index of this vein along the midrib.
 * @param total    - Total number of secondary veins on one side.
 * @param side     - `1` for right side, `-1` for left side.
 * @param midX     - X coordinate of the midrib (centre of canvas).
 * @param leafH    - Height of the leaf region in pixels.
 * @param leafW    - Half-width of the leaf in pixels.
 * @returns `{ x1, y1, x2, y2 }` start and end points in canvas coordinates.
 */
export function secondaryVeinEndpoints(
  index: number,
  total: number,
  side: 1 | -1,
  midX: number,
  leafH: number,
  leafW: number,
): { x1: number; y1: number; x2: number; y2: number } {
  // Place the vein origin along the midrib, evenly spaced.
  const t  = (index + 1) / (total + 1); // [0,1] position along leaf length
  const y1 = leafH * 0.05 + t * leafH * 0.9;
  const x1 = midX;

  // Vein fans outward; angle is wider near the tip, narrower at the base.
  const angle  = (Math.PI * 0.3) + t * (Math.PI * 0.15); // 54° to 81° from midrib
  const length = leafW * (0.5 + t * 0.4); // longer veins toward the middle of the leaf

  const x2 = x1 + side * Math.cos(angle) * length;
  const y2 = y1 + Math.sin(angle) * length * 0.35; // veins have gentle upward curve

  return { x1, y1, x2, y2 };
}

/**
 * Returns the deterministic position of stomata pore `i` in canvas space.
 *
 * Stomata are tiny pores used for gas exchange.  They are scattered evenly
 * across the leaf surface.  We use a deterministic pseudo-random placement
 * (no `Math.random()`) so positions are stable across frames.
 *
 * @param i      - 0-based pore index.
 * @param width  - Canvas width.
 * @param height - Canvas height.
 * @returns `{ x, y }` pixel position of the stomata centre.
 */
export function stomataPosition(
  i: number,
  width: number,
  height: number,
): { x: number; y: number } {
  // Spread positions using a low-discrepancy sequence (Van der Corput-like).
  const frac = ((i * 0.6180339887) % 1); // golden ratio fractional part
  const x = width  * 0.15 + frac * width  * 0.7;
  const y = height * 0.1  + ((i * 137.508) % (height * 0.8));
  return { x, y };
}

// ---------------------------------------------------------------------------
// Background implementation
// ---------------------------------------------------------------------------

/**
 * Procedural leaf-surface background.
 *
 * Renders from back (gradient fill) to front (veins → stomata → sheen)
 * so each layer composites naturally over the previous.
 */
export class LeafBackground implements Background {
  /**
   * Renders one frame of the leaf surface.
   *
   * @param ctx    - Canvas 2D context.
   * @param width  - Canvas width in pixels.
   * @param height - Canvas height in pixels.
   * @param frame  - Frame counter (used for transpiration animation).
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frame: number,
  ): void {
    const midX = width / 2;

    // --- Chloroplast gradient base (green-yellow-green) ---
    // The gradient runs top-left to bottom-right to simulate light hitting
    // the waxy upper surface at an angle.
    const baseGrad = ctx.createLinearGradient(0, 0, width, height);
    baseGrad.addColorStop(0,   '#1a5c1a');
    baseGrad.addColorStop(0.3, '#267326');
    baseGrad.addColorStop(0.6, '#2d8c2d');
    baseGrad.addColorStop(0.8, '#3ba33b');
    baseGrad.addColorStop(1,   '#245c24');
    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, 0, width, height);

    // --- Cell wall grid (epidermal cells — faint polygon mesh) ---
    // Simplified as a regular grid with rounded corners.
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#1a3d1a';
    ctx.lineWidth   = 0.8;
    const cellW = 28;
    const cellH = 22;
    for (let row = 0; row * cellH < height; row++) {
      for (let col = 0; col * cellW < width; col++) {
        const ox = col * cellW + (row % 2 === 0 ? 0 : cellW * 0.5);
        const oy = row * cellH;
        ctx.strokeRect(ox + 2, oy + 2, cellW - 4, cellH - 4);
      }
    }
    ctx.restore();

    // --- Midrib (central vein) ---
    const midribBreath = Math.sin(frame * 0.015) * 0.5; // transpiration pulse
    ctx.save();
    ctx.strokeStyle = '#1a4d1a';
    ctx.lineWidth   = 4 + midribBreath;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(midX, height * 0.02);
    ctx.lineTo(midX, height * 0.98);
    ctx.stroke();
    ctx.restore();

    // --- Secondary veins (fan out from midrib on both sides) ---
    const veinCount = 8;
    ctx.save();
    ctx.strokeStyle = '#1e5a1e';
    ctx.lineCap     = 'round';
    for (const side of [1, -1] as const) {
      for (let i = 0; i < veinCount; i++) {
        const { x1, y1, x2, y2 } = secondaryVeinEndpoints(
          i, veinCount, side, midX, height, width * 0.45,
        );
        const w = 1.5 + midribBreath * 0.3;
        ctx.lineWidth = w;
        ctx.beginPath();
        // Quadratic curve for natural vein arc.
        const cpx = (x1 + x2) / 2;
        const cpy = y1 - height * 0.04;
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(cpx, cpy, x2, y2);
        ctx.stroke();

        // Tertiary veins (finer branches off secondary)
        ctx.lineWidth = 0.6;
        ctx.globalAlpha = 0.5;
        const tx = (x1 + x2 * 2) / 3;
        const ty = (y1 + y2 * 2) / 3;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + side * 18, ty - 12);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    // --- Stomata pores (tiny elliptical openings) ---
    const stomataCount = 60;
    ctx.save();
    for (let i = 0; i < stomataCount; i++) {
      const { x, y } = stomataPosition(i, width, height);
      // Stomata open and close with a slow "breathing" rhythm.
      const openFrac = 0.5 + 0.4 * Math.sin(frame * 0.012 + i * 0.31);
      ctx.globalAlpha = 0.55;
      // Guard cells (outer ring)
      ctx.beginPath();
      ctx.ellipse(x, y, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#0d330d';
      ctx.fill();
      // Pore opening (inner transparent slit)
      ctx.globalAlpha = 0.8 * openFrac;
      ctx.beginPath();
      ctx.ellipse(x, y, 2 * openFrac, 1.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#041404';
      ctx.fill();
    }
    ctx.restore();

    // --- Waxy surface sheen (diagonal highlight) ---
    ctx.save();
    ctx.globalAlpha = 0.08 + 0.04 * Math.sin(frame * 0.01);
    const sheenGrad = ctx.createLinearGradient(0, 0, width * 0.7, height * 0.5);
    sheenGrad.addColorStop(0,   'rgba(255,255,200,0.5)');
    sheenGrad.addColorStop(0.3, 'rgba(255,255,200,0.15)');
    sheenGrad.addColorStop(1,   'rgba(255,255,200,0)');
    ctx.fillStyle = sheenGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}
