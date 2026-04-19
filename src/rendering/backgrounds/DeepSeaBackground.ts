/**
 * @fileoverview Deep sea procedural background for the What Simulator.
 *
 * Renders the floor of a deep ocean trench — an extreme environment where
 * chemosynthetic life thrives around hydrothermal vents.  Features:
 *   - Pitch-dark abyssal gradient (near-black blue)
 *   - Hydrothermal vent plume (rising dark smoke column with heat shimmer)
 *   - Bioluminescent particles — drifting orbs that pulse with light
 *   - Pressure-wave ripples expanding from the vent
 *   - Faint bacterial mat on the seafloor (low-opacity streaks)
 */

import { type Background } from '../BackgroundRenderer.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns the luminance [0, 1] of a bioluminescent particle at frame `f`.
 *
 * Each organism pulses independently at a rate determined by `seed`.
 * The pulse is sinusoidal with a non-zero minimum so organisms are always
 * faintly visible even at the darkest point of their cycle.
 *
 * @param seed  - Unique per-organism integer seed.
 * @param frame - Current animation frame counter.
 * @returns Luminance in [0.1, 1.0].
 */
export function bioluminescentPulse(seed: number, frame: number): number {
  const speed = 0.025 + (seed % 7) * 0.007;
  const phase = seed * 1.618;
  return 0.1 + 0.9 * (0.5 + 0.5 * Math.sin(frame * speed + phase));
}

/**
 * Returns the position and radius of vent plume particle `i` at `frame`.
 *
 * Plume particles rise from the vent mouth, wobble sideways, and fade as
 * they cool and disperse.  Each particle loops continuously.
 *
 * @param i      - 0-based particle index.
 * @param ventX  - X coordinate of vent mouth in pixels.
 * @param ventY  - Y coordinate of vent mouth in pixels (bottom area).
 * @param frame  - Frame counter.
 * @returns `{ x, y, alpha, radius }` of this plume particle.
 */
export function ventPlumeParticle(
  i: number,
  ventX: number,
  ventY: number,
  frame: number,
): { x: number; y: number; alpha: number; radius: number } {
  // Each particle has a different rise speed and lateral wobble.
  const speed   = 0.4 + (i % 5) * 0.15;
  const phase   = i * 13.7; // deterministic starting offset (simulates different birth times)
  // How far this particle has risen (0 = vent mouth, 1 = maximum height).
  const riseT   = ((frame * speed + phase) % 300) / 300;
  // Height above vent — rises non-linearly (slows as it cools).
  const riseH   = ventY * riseT * (1 - riseT * 0.3) * 2;
  // Lateral wobble increases as plume rises and disperses.
  const wobble  = Math.sin(frame * 0.02 + i * 0.8) * riseT * 30;
  const spread  = Math.sin(frame * 0.015 + i * 1.2) * riseT * 20;

  return {
    x:      ventX + wobble + spread,
    y:      ventY - riseH,
    alpha:  0.25 * (1 - riseT) * (1 - riseT), // fades as it rises
    radius: 8 + riseT * 24, // expands as it disperses
  };
}

// ---------------------------------------------------------------------------
// Background implementation
// ---------------------------------------------------------------------------

/**
 * Animated deep-sea abyssal background.
 *
 * Hydrothermal vent in the lower-centre of the canvas; bioluminescent
 * organisms drift around the scene.
 */
export class DeepSeaBackground implements Background {
  /**
   * Renders one frame of the deep-sea background.
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
    const ventX = width  * 0.5;
    const ventY = height * 0.92;

    // --- Abyssal void gradient ---
    const voidGrad = ctx.createLinearGradient(0, 0, 0, height);
    voidGrad.addColorStop(0,    '#000508');
    voidGrad.addColorStop(0.6,  '#010a12');
    voidGrad.addColorStop(0.85, '#020f18');
    voidGrad.addColorStop(1,    '#030a0a');
    ctx.fillStyle = voidGrad;
    ctx.fillRect(0, 0, width, height);

    // --- Seafloor (darker band at the bottom) ---
    const floorGrad = ctx.createLinearGradient(0, height * 0.85, 0, height);
    floorGrad.addColorStop(0, 'rgba(0,0,0,0)');
    floorGrad.addColorStop(1, 'rgba(5,15,10,0.85)');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, height * 0.85, width, height * 0.15);

    // --- Bacterial mat on seafloor (faint horizontal streaks) ---
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = '#204030';
    ctx.lineWidth   = 1.5;
    for (let s = 0; s < 12; s++) {
      const sy = height * 0.88 + s * 2.5;
      const sx = (s * 47) % (width * 0.6);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 30 + (s % 4) * 20, sy + (s % 2) * 1.5);
      ctx.stroke();
    }
    ctx.restore();

    // --- Hydrothermal vent glow (orange-red cone at base) ---
    ctx.save();
    const ventGlowGrad = ctx.createRadialGradient(ventX, ventY, 0, ventX, ventY, 60);
    ventGlowGrad.addColorStop(0,   'rgba(255,100,20,0.35)');
    ventGlowGrad.addColorStop(0.3, 'rgba(200,60,10,0.18)');
    ventGlowGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = ventGlowGrad;
    ctx.beginPath();
    ctx.arc(ventX, ventY, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- Vent plume particles (rising hot gases) ---
    const plumeCount = 20;
    ctx.save();
    for (let i = 0; i < plumeCount; i++) {
      const { x, y, alpha, radius } = ventPlumeParticle(i, ventX, ventY, frame);
      if (alpha < 0.01) continue;
      const plumeGrad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      plumeGrad.addColorStop(0,   `rgba(80,60,50,${alpha})`);
      plumeGrad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.fillStyle = plumeGrad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // --- Pressure-wave rings from vent (expanding circles) ---
    ctx.save();
    const ringPeriod = 120;
    for (let r = 0; r < 3; r++) {
      const age   = (frame + r * 40) % ringPeriod;
      const t     = age / ringPeriod;       // 0 = born, 1 = fully expanded
      const rad   = t * height * 0.4;
      const alpha = 0.08 * (1 - t);
      if (alpha < 0.005) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(50,150,100,0.8)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.arc(ventX, ventY, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // --- Bioluminescent organisms (drifting glowing dots) ---
    const bioCount = 35;
    ctx.save();
    for (let i = 0; i < bioCount; i++) {
      // Deterministic base position + slow drift.
      const baseX    = (i * 137.5) % width;
      const baseY    = height * 0.05 + (i * 97.3) % (height * 0.82);
      const driftX   = Math.sin(frame * 0.007 + i * 0.9) * 25;
      const driftY   = Math.cos(frame * 0.005 + i * 0.6) * 15;
      const px       = (baseX + driftX + width)  % width;
      const py       = (baseY + driftY + height) % height;
      const lum      = bioluminescentPulse(i, frame);
      const radius   = 1.5 + (i % 3) * 0.8;

      // Soft glow + bright core.
      const glowRad = radius * 4;
      const glowGrad = ctx.createRadialGradient(px, py, 0, px, py, glowRad);

      // Colour palette: cyan, blue-green, pale yellow-green.
      const hues: Array<[number, number, number]> = [
        [0, 220, 180],
        [20, 180, 255],
        [120, 255, 120],
      ];
      const [cr, cg, cb] = hues[i % 3];

      glowGrad.addColorStop(0, `rgba(${cr},${cg},${cb},${lum * 0.5})`);
      glowGrad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(px, py, glowRad, 0, Math.PI * 2);
      ctx.fill();

      // Bright core dot.
      ctx.globalAlpha = lum * 0.9;
      ctx.fillStyle   = `rgb(${cr},${cg},${cb})`;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}
