/**
 * @fileoverview Aquatic water background for the What Simulator.
 *
 * Renders a water surface viewed from above, with animated caustic light
 * patterns — the shifting lattice of bright lines that appear when sunlight
 * is refracted through an undulating water surface.  Features:
 *   - Deep blue-teal gradient base
 *   - Three overlapping sine-wave caustic meshes that move over time
 *   - Subtle light rays emanating from the top-left (surface reflection)
 *   - Sparse floating particles (algae / debris) that drift with the current
 */

import { type Background } from '../BackgroundRenderer.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Computes the intensity [0, 1] of a caustic light pattern at grid position
 * `(gx, gy)` for a given animation `phase`.
 *
 * Three sine waves at different frequencies and angles are summed.  The result
 * models the interference pattern that produces caustic "lace" on a pool floor.
 *
 * @param gx    - Normalised X coordinate [0, 1].
 * @param gy    - Normalised Y coordinate [0, 1].
 * @param phase - Animation phase in radians (advances with frame).
 * @returns Caustic intensity in [0, 1].
 */
export function causticIntensity(gx: number, gy: number, phase: number): number {
  // Three overlapping sine waves at different scales / angles.
  const w1 = Math.sin(gx * 12 + phase) * Math.sin(gy * 9  - phase * 0.7);
  const w2 = Math.sin(gx * 7  - phase * 1.3 + gy * 5 + 1.5);
  const w3 = Math.sin((gx + gy) * 8 + phase * 0.5);

  // Map the [-1,1] sum to [0,1], squaring it to create sharp bright lines.
  const raw = (w1 + w2 + w3) / 3; // range [-1, 1]
  return Math.max(0, raw) ** 2;
}

/**
 * Returns the base water colour as an RGB object based on normalised depth `d`.
 *
 * Shallow water (d=0) is a lighter cyan; deep water (d=1) is dark navy.
 *
 * @param d - Normalised depth [0, 1].
 * @returns `{ r, g, b }` base colour.
 */
export function waterBaseColor(d: number): { r: number; g: number; b: number } {
  return {
    r: Math.round(10  + d * 5),
    g: Math.round(60  + (1 - d) * 50),
    b: Math.round(120 + (1 - d) * 60),
  };
}

// ---------------------------------------------------------------------------
// Background implementation
// ---------------------------------------------------------------------------

/**
 * Animated aquatic water-surface background.
 *
 * Uses Canvas 2D `fillRect` with semi-transparent fills rather than
 * per-pixel `ImageData` writes for efficiency — acceptable because the
 * background is visually additive (caustics brighten the base colour).
 */
export class WaterBackground implements Background {
  /**
   * Renders one frame of the water caustic animation.
   *
   * @param ctx    - Canvas 2D context.
   * @param width  - Canvas width in pixels.
   * @param height - Canvas height in pixels.
   * @param frame  - Frame counter for animation.
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frame: number,
  ): void {
    const phase = frame * 0.018;

    // --- Base deep-water gradient ---
    const waterGrad = ctx.createLinearGradient(0, 0, 0, height);
    waterGrad.addColorStop(0,   '#0a4878');
    waterGrad.addColorStop(0.5, '#083060');
    waterGrad.addColorStop(1,   '#051840');
    ctx.fillStyle = waterGrad;
    ctx.fillRect(0, 0, width, height);

    // --- Caustic light lattice ---
    // We sample on a coarse grid and render overlapping semi-transparent
    // ellipses — much faster than per-pixel ImageData and looks organic.
    const step    = 24; // grid spacing in pixels
    const cols    = Math.ceil(width  / step) + 1;
    const rows    = Math.ceil(height / step) + 1;

    ctx.save();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Animate the sample position with a tiny per-cell wobble.
        const wobble = Math.sin(frame * 0.03 + row * 0.4 + col * 0.5) * 4;
        const px = col * step + wobble;
        const py = row * step + wobble * 0.6;

        const gx  = px / width;
        const gy  = py / height;
        const cint = causticIntensity(gx, gy, phase);

        if (cint < 0.05) continue; // skip dim spots — no visible contribution

        const radius = step * 0.6 * (0.5 + cint * 0.8);
        const alpha  = cint * 0.22;

        ctx.globalAlpha = alpha;
        ctx.beginPath();
        // Slightly elongated ellipse in the Y direction for realism.
        ctx.ellipse(px, py, radius * 0.7, radius, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(100,200,255)`;
        ctx.fill();
      }
    }
    ctx.restore();

    // --- Subtle light rays from top surface ---
    ctx.save();
    ctx.globalAlpha = 0.04 + 0.02 * Math.sin(frame * 0.025);
    const rayCount  = 6;
    for (let i = 0; i < rayCount; i++) {
      const angle = -Math.PI * 0.15 + (i / rayCount) * Math.PI * 0.3;
      const rayGrad = ctx.createLinearGradient(0, 0, Math.sin(angle) * width, height * 1.5);
      rayGrad.addColorStop(0,   'rgba(160,230,255,0.15)');
      rayGrad.addColorStop(0.4, 'rgba(80,160,255,0.05)');
      rayGrad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      // Each ray is a thin triangle from the top edge.
      const spreadX = width * 0.08;
      ctx.moveTo(width * (i / rayCount) - spreadX, 0);
      ctx.lineTo(width * (i / rayCount) + spreadX, 0);
      ctx.lineTo(width * (i / rayCount) + Math.sin(angle) * height, height);
      ctx.closePath();
      ctx.fillStyle = rayGrad;
      ctx.fill();
    }
    ctx.restore();

    // --- Drifting particles (algae / sediment) ---
    ctx.save();
    const particleCount = 24;
    for (let i = 0; i < particleCount; i++) {
      // Deterministic position based on frame so no random() in render loop.
      const baseX = ((i * 137.5) % width);
      const baseY = ((i * 97.3)  % height);
      // Each particle drifts at a different rate to simulate current.
      const driftX = (Math.sin(frame * 0.008 + i) * 30);
      const driftY = (Math.cos(frame * 0.006 + i * 0.7) * 20);
      const px = (baseX + driftX + width)  % width;
      const py = (baseY + driftY + height) % height;
      const alpha = 0.15 + 0.1 * Math.sin(frame * 0.05 + i * 0.8);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#80ccaa';
      ctx.fill();
    }
    ctx.restore();
  }
}
