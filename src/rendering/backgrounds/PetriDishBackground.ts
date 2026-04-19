/**
 * @fileoverview Petri dish agar surface background for the What Simulator.
 *
 * Renders the INTERIOR surface of a culture plate — as if the camera is
 * looking straight down at the agar gel from above.  The circular dish shape
 * is applied by the CSS class `env-petri` on `#canvas-frame` (border-radius 50%
 * + overflow hidden), so this renderer simply fills the full canvas rectangle
 * with a convincing agar surface.
 *
 * Features:
 *   - Warm amber agar gel with depth-gradient (slightly darker at edges)
 *   - Faint concentric measurement rings etched into the agar wall
 *   - Subtle surface ripple texture using deterministic sine-wave bands
 *   - Animated condensation droplets scattered across the surface
 *   - Edge-vignette darkening that suggests the plastic dish wall curving up
 */

import { type Background } from '../BackgroundRenderer.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns the CSS colour string for an agar gel pixel at normalised
 * radial distance `r` (0 = centre, 1 = outer edge) and animation `frame`.
 *
 * The amber hue shifts very slightly over time for a living-gel shimmer.
 *
 * @param r     - Normalised radius in [0, 1].
 * @param frame - Current animation frame counter.
 * @returns CSS rgb() colour string.
 */
export function agarColorAt(r: number, frame: number): string {
  const shimmer    = Math.sin(frame * 0.012) * 4;
  const edgeDarken = r * r * 55;
  const red   = Math.round(208 - edgeDarken + shimmer);
  const green = Math.round(174 - edgeDarken * 0.75);
  const blue  = Math.round(112 - edgeDarken * 0.55);
  return `rgb(${red},${green},${blue})`;
}

/**
 * Calculates the (x, y) position and opacity of a surface condensation droplet.
 *
 * Droplets drift slowly using a unique speed per `seed` so they don't move
 * in lock-step.  Position is relative to the canvas centre.
 *
 * @param seed  - Integer index [0, N) uniquely identifying this droplet.
 * @param frame - Current animation frame counter.
 * @param cx    - Canvas centre X in pixels.
 * @param cy    - Canvas centre Y in pixels.
 * @param rimR  - Reference radius for droplet scatter (typically 45% of min dimension).
 * @returns `{ x, y, alpha }` — screen position and opacity [0, 1].
 */
export function dropletPosition(
  seed: number,
  frame: number,
  cx: number,
  cy: number,
  rimR: number,
): { x: number; y: number; alpha: number } {
  // Each droplet orbits at a different angle and radius.
  const baseAngle = (seed / 20) * Math.PI * 2;
  const drift     = frame * (0.0003 + seed * 0.000085);
  const angle     = baseAngle + drift;
  // Scatter droplets across the surface at varying radii (30–95% of rimR).
  const rFrac     = 0.30 + (((seed * 7 + 3) % 13) / 13) * 0.65;
  const r         = rimR * rFrac;
  const alpha     = 0.12 + 0.18 * Math.abs(Math.sin(frame * 0.015 + seed * 1.7));
  return {
    x: cx + Math.cos(angle) * r,
    y: cy + Math.sin(angle) * r,
    alpha,
  };
}

// ---------------------------------------------------------------------------
// Background implementation
// ---------------------------------------------------------------------------

/**
 * Procedural petri dish agar surface background.
 *
 * Fills the entire canvas as if viewed from directly above the culture medium.
 * CSS on `#canvas-frame.env-petri` clips the rectangle to a circle and adds
 * the glass-rim box-shadow.
 */
export class PetriDishBackground implements Background {
  /**
   * Renders one frame of the agar surface into `ctx`.
   *
   * @param ctx    - Canvas 2D rendering context.
   * @param width  - Canvas width in pixels.
   * @param height - Canvas height in pixels.
   * @param frame  - Monotonically increasing frame counter.
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frame: number,
  ): void {
    const cx   = width  / 2;
    const cy   = height / 2;
    // Use the corner-to-centre distance so the gradient extends to corners.
    const maxR = Math.sqrt(cx * cx + cy * cy);
    // Reference radius for droplet scatter — 45% of the shorter dimension.
    const scatterR = Math.min(width, height) * 0.45;

    // --- Agar gel fill: radial gradient from centre to corners ---
    // Fills the entire canvas so CSS border-radius clips it to a circle.
    const gelGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    for (let step = 0; step <= 10; step++) {
      const r = step / 10;
      gelGrad.addColorStop(r, agarColorAt(r, frame));
    }
    ctx.fillStyle = gelGrad;
    ctx.fillRect(0, 0, width, height);

    // --- Edge vignette: extra darkening near the dish wall ---
    // Simulates the plastic side-wall curving up and casting shadow on the agar.
    const vigGrad = ctx.createRadialGradient(cx, cy, scatterR * 0.8, cx, cy, maxR);
    vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
    vigGrad.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vigGrad;
    ctx.fillRect(0, 0, width, height);

    // --- Subtle surface ripple bands: deterministic sine-wave rings ---
    // Simulates the semi-solid gel surface catching overhead light unevenly.
    ctx.save();
    ctx.globalAlpha = 0.035;
    const numRings = 10;
    for (let ring = 1; ring <= numRings; ring++) {
      const ringR = (ring / numRings) * scatterR;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 0.6;
      ctx.stroke();
    }
    ctx.restore();

    // --- Measurement ring markings (faint etched graduations on agar wall) ---
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = '#9090b8';
    ctx.lineWidth   = 0.8;
    for (let ring = 1; ring <= 4; ring++) {
      const ringR = scatterR * 0.92 + (ring * scatterR * 0.02);
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // --- Condensation droplets on the agar surface ---
    ctx.save();
    for (let i = 0; i < 20; i++) {
      const { x, y, alpha } = dropletPosition(i, frame, cx, cy, scatterR);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(210, 230, 255, 0.95)';
      ctx.fill();
    }
    ctx.restore();
  }
}
