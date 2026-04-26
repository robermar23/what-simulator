/**
 * @fileoverview ClusterLayer — organic blob cluster placement.
 *
 * Generates `count` independent clusters using a stochastic falloff model:
 * each cell within the radius envelope is accepted with probability that
 * decreases with distance from the cluster centre.  This produces irregular
 * organic shapes rather than hard circles.
 */

import { CellType }        from '../../GridState.js';
import { type ClusterLayer } from '../types.js';

/**
 * Applies a ClusterLayer to the grid's cellType buffer.
 *
 * @param layer    - Cluster specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator.
 */
export function applyClusterLayer(
  layer: ClusterLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  const [minR, maxR] = layer.radiusRange;

  for (let c = 0; c < layer.count; c++) {
    // Pick a random centre, optionally avoiding the inner 40% of the grid.
    const cx = pickCenter(width, layer.avoidCenter, rng);
    const cy = pickCenter(height, layer.avoidCenter, rng);
    const radius = minR + rng() * (maxR - minR);

    const rx = Math.ceil(radius);
    // Visit all cells within the bounding box of this cluster.
    for (let dy = -rx; dy <= rx; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;

        // Organic falloff: acceptance probability decreases with distance.
        // sqrt falloff gives a natural "sparse outer fringe" effect.
        const falloff = Math.sqrt(1 - dist / radius);
        if (rng() >= layer.density * falloff) continue;

        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const i = y * width + x;
        if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) continue;
        cellType[i] = layer.cellType;
      }
    }
  }
}

/**
 * Picks a random centre coordinate for a cluster.
 *
 * @param size        - Axis length (width or height).
 * @param avoidCenter - When true, restricts to the outer 60% of the axis.
 * @param rng         - RNG function.
 * @returns Integer coordinate in [0, size).
 */
function pickCenter(size: number, avoidCenter: boolean | undefined, rng: () => number): number {
  if (!avoidCenter) {
    return Math.floor(rng() * size);
  }
  // Place only in outer 20–80% zone on each side (avoid central 40%).
  // Split the outer band into two halves and pick from one uniformly.
  const outerBand = Math.floor(size * 0.30); // 30% of axis per side
  const side = rng() < 0.5 ? 0 : 1;
  return side === 0
    ? Math.floor(rng() * outerBand)
    : size - outerBand + Math.floor(rng() * outerBand);
}
