/**
 * @fileoverview ScatteredLayer — uniform random obstacle scatter.
 *
 * Places individual obstacle cells at random positions within the grid
 * (or an optional sub-region) at a specified density fraction.
 */

import { CellType }        from '../../GridState.js';
import { type ScatteredLayer } from '../types.js';

/**
 * Applies a ScatteredLayer to the grid's cellType buffer.
 *
 * Skips any cell that already contains Life or LifeVariant so that
 * obstacles are never placed on top of existing organisms.
 *
 * @param layer    - Scatter specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator (seeded or Math.random).
 */
export function applyScatteredLayer(
  layer: ScatteredLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  // Resolve the region to scatter within (default: full grid).
  const [fx0, fy0, fx1, fy1] = layer.region ?? [0, 0, 1, 1];
  const x0 = Math.floor(fx0 * width);
  const y0 = Math.floor(fy0 * height);
  const x1 = Math.floor(fx1 * width);
  const y1 = Math.floor(fy1 * height);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (rng() >= layer.density) continue;
      const i = y * width + x;
      // Preserve existing life cells — obstacles go on empty terrain only.
      if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) continue;
      cellType[i] = layer.cellType;
    }
  }
}
