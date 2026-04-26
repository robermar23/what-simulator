/**
 * @fileoverview BorderLayer — edge-hugging obstacle band.
 *
 * Fills a band of the specified width along one or more grid edges with the
 * given cell type at the specified density.  Useful for creating containment
 * walls, toxic boundary gradients, or shore effects.
 */

import { CellType }        from '../../GridState.js';
import { type BorderLayer } from '../types.js';

/**
 * Applies a BorderLayer to the grid's cellType buffer.
 *
 * @param layer    - Border specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator for density sampling.
 */
export function applyBorderLayer(
  layer: BorderLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  /** Writes one (x, y) cell if density check passes and cell is empty. */
  const paint = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    if (rng() >= layer.density) return;
    const i = y * width + x;
    if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) return;
    cellType[i] = layer.cellType;
  };

  for (const edge of layer.edges) {
    if (edge === 'top') {
      for (let row = 0; row < layer.width; row++) {
        for (let x = 0; x < width; x++) paint(x, row);
      }
    } else if (edge === 'bottom') {
      for (let row = 0; row < layer.width; row++) {
        for (let x = 0; x < width; x++) paint(x, height - 1 - row);
      }
    } else if (edge === 'left') {
      for (let col = 0; col < layer.width; col++) {
        for (let y = 0; y < height; y++) paint(col, y);
      }
    } else { // right
      for (let col = 0; col < layer.width; col++) {
        for (let y = 0; y < height; y++) paint(width - 1 - col, y);
      }
    }
  }
}
