/**
 * @fileoverview Soil / earth procedural background for the What Simulator.
 *
 * Renders a zoomed-in cross-section of fertile soil — the substrate where
 * microbial life thrives.  Features:
 *   - Dark humus-rich soil gradient (deep brown to near-black)
 *   - Scattered mineral particles (sand grains, silt flecks)
 *   - Organic matter fragments (decaying plant debris)
 *   - Moisture veins (water channels between soil aggregates)
 *   - Slow "moisture seep" animation — water droplets migrating downward
 */

import { type Background } from '../BackgroundRenderer.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns a CSS colour string for a soil mineral particle based on its
 * deterministic `seed`.  Different seeds produce sand, quartz, feldspar, or
 * iron-oxide particle colours.
 *
 * @param seed - Integer seed ≥ 0 for deterministic colour selection.
 * @returns CSS rgb colour string.
 */
export function mineralParticleColor(seed: number): string {
  const palette = [
    'rgb(200,180,140)', // sand grain
    'rgb(220,215,200)', // quartz
    'rgb(180,160,130)', // feldspar
    'rgb(160,100, 60)', // iron oxide
    'rgb(130,120,100)', // silt
    'rgb(240,235,220)', // chalk
  ];
  return palette[seed % palette.length];
}

/**
 * Computes the position and size of a soil particle with index `i`.
 *
 * Particles are spread deterministically across the canvas using a
 * low-discrepancy sequence so no `Math.random()` is needed in the hot path.
 *
 * @param i      - 0-based particle index.
 * @param width  - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @returns `{ x, y, radius, colorSeed }` for this particle.
 */
export function particleLayout(
  i: number,
  width: number,
  height: number,
): { x: number; y: number; radius: number; colorSeed: number } {
  // Scramble index to break up any grid-like regularity.
  const scrambled = (i * 2654435761) >>> 0; // Knuth multiplicative hash
  const x      = (scrambled % width);
  const y      = ((i * 7919) % height);
  const radius = 1.5 + (i % 5) * 0.8; // 1.5–5.0 px
  return { x, y, radius, colorSeed: i };
}

/**
 * Returns the Y position of a moisture seep droplet at frame `f`.
 *
 * Droplets fall slowly through the soil, wrap at the bottom, and restart
 * near the top — simulating percolating groundwater.
 *
 * @param seed   - Droplet identity (0-based index).
 * @param frame  - Current animation frame.
 * @param height - Canvas height in pixels.
 * @returns Y coordinate in pixels.
 */
export function seepDropletY(seed: number, frame: number, height: number): number {
  const speed  = 0.15 + (seed % 5) * 0.08; // 0.15–0.47 px per frame
  const startY = (seed * 97) % height;      // each droplet starts at different Y
  return (startY + frame * speed) % height;
}

// ---------------------------------------------------------------------------
// Background implementation
// ---------------------------------------------------------------------------

/**
 * Procedural soil-surface background.
 *
 * Renders mineral particles and organic matter over a layered gradient,
 * with an animated moisture seep effect.
 */
export class SoilBackground implements Background {
  /**
   * Renders one frame of the soil background.
   *
   * @param ctx    - Canvas 2D context.
   * @param width  - Canvas width in pixels.
   * @param height - Canvas height in pixels.
   * @param frame  - Frame counter for moisture animation.
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frame: number,
  ): void {
    // --- Soil gradient base: humus-rich top layer shading to mineral sub-soil ---
    const soilGrad = ctx.createLinearGradient(0, 0, 0, height);
    soilGrad.addColorStop(0,    '#1a0e06');
    soilGrad.addColorStop(0.25, '#241208');
    soilGrad.addColorStop(0.5,  '#2e160a');
    soilGrad.addColorStop(0.75, '#3a1c0c');
    soilGrad.addColorStop(1,    '#1e1208');
    ctx.fillStyle = soilGrad;
    ctx.fillRect(0, 0, width, height);

    // --- Soil aggregate texture: subtle diagonal striations ---
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#4a2a10';
    ctx.lineWidth   = 1;
    for (let y = -20; y < height; y += 18) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y + width * 0.15);
      ctx.stroke();
    }
    ctx.restore();

    // --- Mineral particles (sand, quartz, iron oxide) ---
    const particleCount = 220;
    ctx.save();
    for (let i = 0; i < particleCount; i++) {
      const { x, y, radius, colorSeed } = particleLayout(i, width, height);
      ctx.globalAlpha = 0.4 + (colorSeed % 5) * 0.08;
      ctx.beginPath();
      // Slightly irregular shape (ellipse rotated by seed angle).
      const angle = (colorSeed * 47) % (Math.PI);
      ctx.ellipse(x, y, radius, radius * 0.65, angle, 0, Math.PI * 2);
      ctx.fillStyle = mineralParticleColor(colorSeed);
      ctx.fill();
    }
    ctx.restore();

    // --- Organic matter fragments (darker, irregular patches) ---
    const organicCount = 40;
    ctx.save();
    for (let i = 0; i < organicCount; i++) {
      const px = ((i * 193) % width);
      const py = ((i * 113) % height);
      const w  = 4 + (i % 6) * 3;
      const h  = 2 + (i % 4) * 1.5;
      ctx.globalAlpha = 0.35;
      ctx.fillStyle   = '#0a0a06';
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((i * 0.7) % Math.PI);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
    ctx.restore();

    // --- Moisture veins (thin water channels between aggregates) ---
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = '#2244aa';
    ctx.lineWidth   = 0.8;
    for (let v = 0; v < 8; v++) {
      const x0 = (v * width / 7);
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      // Winding path down through soil.
      for (let seg = 1; seg <= 6; seg++) {
        const wx = x0 + Math.sin(seg * 1.1 + v * 0.5) * 18;
        const wy = (seg / 6) * height;
        ctx.lineTo(wx, wy);
      }
      ctx.stroke();
    }
    ctx.restore();

    // --- Moisture seep droplets (water percolating downward) ---
    const dropletCount = 18;
    ctx.save();
    for (let i = 0; i < dropletCount; i++) {
      const dx    = (i * 137.5) % width;
      const dy    = seepDropletY(i, frame, height);
      const alpha = 0.08 + 0.06 * Math.sin(frame * 0.04 + i * 0.9);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(dx, dy, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#4488cc';
      ctx.fill();
    }
    ctx.restore();
  }
}
