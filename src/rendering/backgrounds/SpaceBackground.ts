/**
 * @fileoverview Deep space procedural background for the What Simulator.
 *
 * Renders a deep-space vista as a context for panspermia — life expanding
 * across the void between stars.  Features:
 *   - Dense star field with three size/brightness classes
 *   - Parallax twinkle animation (stars shimmer at different rates)
 *   - Two soft nebula clouds (radial gradient blobs in different hues)
 *   - Cosmic dust lane (low-opacity diagonal gradient stripe)
 *   - Distant galaxy smear (elongated ellipse with core glow)
 */

import { type Background } from '../BackgroundRenderer.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns the brightness multiplier [0, 1] for a star of `class_` at `frame`.
 *
 * Stars twinkle because they are point-sources that scatter differently
 * through a turbulent atmosphere.  Each star has a unique phase offset.
 *
 * - Class 0: rapid, deep twinkle (faint background stars)
 * - Class 1: moderate twinkle (medium stars)
 * - Class 2: slow, shallow twinkle (bright foreground stars)
 *
 * @param class_  - Star brightness class (0=faint, 1=medium, 2=bright).
 * @param seed    - Per-star phase seed to desynchronise twinkle.
 * @param frame   - Current animation frame.
 * @returns Brightness multiplier in [0.3, 1.0].
 */
export function starBrightness(class_: 0 | 1 | 2, seed: number, frame: number): number {
  const speeds  = [0.08, 0.04, 0.02];
  const depths  = [0.55, 0.35, 0.15]; // how deep the twinkle dips
  const phase   = seed * 2.399; // golden-ratio offset
  const raw     = Math.sin(frame * speeds[class_] + phase);
  return 1 - depths[class_] * (raw * 0.5 + 0.5);
}

/**
 * Returns the deterministic position of star `i` in canvas-normalised [0,1] space.
 *
 * Uses a Knuth multiplicative hash to scatter stars without `Math.random()`.
 *
 * @param i - 0-based star index.
 * @returns `{ nx, ny }` — normalised [0,1] coordinates.
 */
export function starNormPos(i: number): { nx: number; ny: number } {
  const h1 = ((i * 2654435761) >>> 0) / 0xffffffff;
  const h2 = ((i * 2246822519) >>> 0) / 0xffffffff;
  return { nx: h1, ny: h2 };
}

// ---------------------------------------------------------------------------
// Star catalogue (built once, reused every frame)
// ---------------------------------------------------------------------------

/** Describes a single star's fixed properties. */
interface StarRecord {
  nx: number;
  ny: number;
  radius: number;
  class_: 0 | 1 | 2;
  seed: number;
}

/** Build the star catalogue (called once at construction time). */
function buildStarCatalogue(count: number): readonly StarRecord[] {
  const stars: StarRecord[] = [];
  for (let i = 0; i < count; i++) {
    const { nx, ny } = starNormPos(i);
    // Class distribution: 70% faint, 25% medium, 5% bright.
    const r   = (i * 1664525 + 1013904223) >>> 0;
    const cls = r % 100 < 70 ? 0 : r % 100 < 95 ? 1 : 2;
    const radius = cls === 0 ? 0.6 : cls === 1 ? 1.1 : 1.8;
    stars.push({ nx, ny, radius, class_: cls as 0 | 1 | 2, seed: i });
  }
  return stars;
}

// ---------------------------------------------------------------------------
// Background implementation
// ---------------------------------------------------------------------------

/**
 * Animated deep-space background.
 *
 * The star catalogue is built once in the constructor and reused each frame —
 * only the brightness values are recomputed per-frame.
 */
export class SpaceBackground implements Background {
  /** Pre-built star catalogue — stable across all frames. */
  private readonly _stars: readonly StarRecord[] = buildStarCatalogue(400);

  /**
   * Renders one frame of the space background.
   *
   * @param ctx    - Canvas 2D context.
   * @param width  - Canvas width in pixels.
   * @param height - Canvas height in pixels.
   * @param frame  - Frame counter for twinkle animation.
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frame: number,
  ): void {
    // --- Void background: near-black with a very slight deep-blue tint ---
    ctx.fillStyle = '#030308';
    ctx.fillRect(0, 0, width, height);

    // --- Cosmic dust lane: diagonal low-opacity streak ---
    ctx.save();
    const dustGrad = ctx.createLinearGradient(0, height * 0.3, width, height * 0.7);
    dustGrad.addColorStop(0,   'rgba(30,20,50,0)');
    dustGrad.addColorStop(0.4, 'rgba(30,20,50,0.18)');
    dustGrad.addColorStop(0.6, 'rgba(30,20,50,0.12)');
    dustGrad.addColorStop(1,   'rgba(30,20,50,0)');
    ctx.fillStyle = dustGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // --- Nebula clouds ---
    const nebulae: Array<{
      cx: number; cy: number; rx: number; ry: number;
      r: number; g: number; b: number; alpha: number;
    }> = [
      {
        cx: width * 0.3, cy: height * 0.25,
        rx: width * 0.22, ry: height * 0.18,
        r: 80, g: 20, b: 140, alpha: 0.12,
      },
      {
        cx: width * 0.75, cy: height * 0.65,
        rx: width * 0.18, ry: height * 0.14,
        r: 20, g: 80, b: 160, alpha: 0.1,
      },
    ];

    ctx.save();
    for (const neb of nebulae) {
      const nebGrad = ctx.createRadialGradient(neb.cx, neb.cy, 0, neb.cx, neb.cy, neb.rx);
      nebGrad.addColorStop(0,   `rgba(${neb.r},${neb.g},${neb.b},${neb.alpha})`);
      nebGrad.addColorStop(0.5, `rgba(${neb.r},${neb.g},${neb.b},${neb.alpha * 0.4})`);
      nebGrad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.save();
      // Scale Y separately to make it an ellipse.
      ctx.translate(neb.cx, neb.cy);
      ctx.scale(1, neb.ry / neb.rx);
      ctx.translate(-neb.cx, -neb.cy);
      ctx.fillStyle = nebGrad;
      ctx.beginPath();
      ctx.arc(neb.cx, neb.cy, neb.rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // --- Distant galaxy smear ---
    ctx.save();
    const galaxyCx = width * 0.8;
    const galaxyCy = height * 0.2;
    const galGrad  = ctx.createRadialGradient(galaxyCx, galaxyCy, 0, galaxyCx, galaxyCy, 30);
    galGrad.addColorStop(0,   'rgba(255,240,200,0.25)');
    galGrad.addColorStop(0.4, 'rgba(200,180,160,0.08)');
    galGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(galaxyCx, galaxyCy);
    ctx.rotate(Math.PI * 0.3);
    ctx.scale(2, 0.4);
    ctx.translate(-galaxyCx, -galaxyCy);
    ctx.fillStyle = galGrad;
    ctx.beginPath();
    ctx.arc(galaxyCx, galaxyCy, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // --- Star field ---
    for (const star of this._stars) {
      const x    = star.nx * width;
      const y    = star.ny * height;
      const br   = starBrightness(star.class_, star.seed, frame);
      const base = star.class_ === 0 ? 150 : star.class_ === 1 ? 200 : 255;
      const v    = Math.round(base * br);
      // Tint: faint stars are slightly blue-white; bright stars are warm white.
      const r    = star.class_ === 2 ? v : Math.round(v * 0.88);
      const g    = Math.round(v * 0.92);
      const b    = v;

      ctx.beginPath();
      ctx.arc(x, y, star.radius * br, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fill();

      // Bright stars get a cross-shaped diffraction spike.
      if (star.class_ === 2) {
        const spikeLen = star.radius * 4 * br;
        ctx.save();
        ctx.globalAlpha = br * 0.3;
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.lineWidth   = 0.6;
        ctx.beginPath();
        ctx.moveTo(x - spikeLen, y);
        ctx.lineTo(x + spikeLen, y);
        ctx.moveTo(x, y - spikeLen);
        ctx.lineTo(x, y + spikeLen);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}
