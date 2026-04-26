/**
 * @fileoverview RingLayer — concentric ring obstacle placement.
 *
 * Generates concentric ring obstacles centred on a point (default: grid centre).
 * Rings have configurable thickness and completeness (gap fraction), so life
 * must find the gaps rather than being completely blocked.
 */

import { CellType }      from '../../GridState.js';
import { type RingLayer } from '../types.js';

/**
 * Applies a RingLayer to the grid's cellType buffer.
 *
 * @param layer    - Ring specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator (used for gap placement).
 */
export function applyRingLayer(
  layer: RingLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  const [fx, fy] = layer.center ?? [0.5, 0.5];
  const cx = fx * width;
  const cy = fy * height;

  for (let r = 0; r < layer.count; r++) {
    const targetRadius = (r + 1) * layer.spacing;
    const innerRadius  = targetRadius - layer.thickness / 2;
    const outerRadius  = targetRadius + layer.thickness / 2;

    // Iterate the bounding box of the outer ring.
    const outerCeil = Math.ceil(outerRadius);
    for (let dy = -outerCeil; dy <= outerCeil; dy++) {
      for (let dx = -outerCeil; dx <= outerCeil; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < innerRadius || dist > outerRadius) continue;

        // Gap: reject this cell based on completeness.
        if (rng() >= layer.completeness) continue;

        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const i = y * width + x;
        if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) continue;
        cellType[i] = layer.cellType;
      }
    }
  }
}
