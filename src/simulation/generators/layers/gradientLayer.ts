/**
 * @fileoverview GradientLayer — probability gradient obstacle scatter.
 *
 * Places obstacles with placement probability varying smoothly across the
 * grid according to a directional gradient function.  Creates environmental
 * gradients — e.g. toxin concentration increasing from left to right, or
 * radiation strongest at the grid centre.
 */

import { CellType }          from '../../GridState.js';
import { type GradientLayer } from '../types.js';

/**
 * Applies a GradientLayer to the grid's cellType buffer.
 *
 * @param layer    - Gradient specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator.
 */
export function applyGradientLayer(
  layer: GradientLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  const { minProbability, maxProbability, direction } = layer;
  const cx = width  / 2;
  const cy = height / 2;
  // Maximum possible distance from centre (corner distance).
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = gradientT(x, y, width, height, cx, cy, maxDist, direction);
      const prob = minProbability + t * (maxProbability - minProbability);
      if (rng() >= prob) continue;
      const i = y * width + x;
      if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) continue;
      cellType[i] = layer.cellType;
    }
  }
}

/**
 * Computes the gradient parameter t ∈ [0, 1] for a cell position.
 * t = 0 → minProbability side; t = 1 → maxProbability side.
 *
 * @param x       - Cell column.
 * @param y       - Cell row.
 * @param width   - Grid width.
 * @param height  - Grid height.
 * @param cx      - Grid centre column.
 * @param cy      - Grid centre row.
 * @param maxDist - Corner distance (normaliser for radial modes).
 * @param dir     - Gradient direction.
 */
function gradientT(
  x: number, y: number,
  width: number, height: number,
  cx: number, cy: number,
  maxDist: number,
  dir: GradientLayer['direction'],
): number {
  switch (dir) {
    case 'left-right':  return x / (width  - 1);
    case 'top-bottom':  return y / (height - 1);
    case 'radial-in': {
      // Probability highest at centre (small distance → high t).
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      return 1 - dist / maxDist;
    }
    case 'radial-out': {
      // Probability highest at edges (large distance → high t).
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      return dist / maxDist;
    }
  }
}
