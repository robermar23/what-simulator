/**
 * @fileoverview RiverLayer — meandering channel placement.
 *
 * Creates a river-like channel of one cell type that traverses the full
 * length of the grid along a primary axis, meandering perpendicularly
 * with configurable amplitude.  Models rivers (Nutrient channels), lava
 * flows (Fire), antibiotic bands, or any corridor obstacle.
 */

import { CellType }       from '../../GridState.js';
import { type RiverLayer } from '../types.js';

/**
 * Applies a RiverLayer to the grid's cellType buffer.
 *
 * The river is defined as a path of centre points; each cell within
 * `layer.width / 2` of the path centre is filled.  Banks (Wall cells)
 * are optionally added one cell outside each edge of the channel.
 *
 * @param layer    - River specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator for meander path.
 */
export function applyRiverLayer(
  layer: RiverLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  const horizontal = layer.axis === 'horizontal';
  // Length = how many steps the river takes (along primary axis).
  const length = horizontal ? width  : height;
  // Perp   = perpendicular dimension.
  const perp   = horizontal ? height : width;

  const halfWidth = layer.width / 2;
  const startFrac = layer.startOffset ?? 0.5;
  // Current perpendicular position of the river centre (float).
  let pos = startFrac * perp;
  // Velocity of the meander (slow random walk).
  let vel = 0;

  for (let step = 0; step < length; step++) {
    // Update meander velocity — small random nudge each step, damped.
    vel += (rng() - 0.5) * 0.8;        // random impulse
    vel *= 0.88;                         // damping — keeps river from hugging edges
    pos += vel;
    // Clamp position to grid + reflection at extremes.
    if (pos < halfWidth) { pos = halfWidth; vel = Math.abs(vel); }
    if (pos > perp - halfWidth) { pos = perp - halfWidth; vel = -Math.abs(vel); }
    // Clamp meander amplitude.
    pos = Math.max(halfWidth, Math.min(perp - halfWidth, pos));
    // Additionally, drift back toward the start offset to prevent runaway.
    const centre = startFrac * perp;
    const drift  = (centre - pos) * 0.005;
    pos += drift;

    const centre_i = Math.round(pos);

    // Paint all cells within halfWidth of the centre on this perpendicular slice.
    for (let t = -Math.ceil(halfWidth); t <= Math.ceil(halfWidth); t++) {
      const perpIdx = centre_i + t;
      if (perpIdx < 0 || perpIdx >= perp) continue;

      const [px, py] = horizontal ? [step, perpIdx] : [perpIdx, step];
      const i = py * width + px;
      if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) continue;
      cellType[i] = layer.cellType;
    }

    // Optional banks: Wall cells on both sides, outside the channel.
    if (layer.addBanks) {
      paintBank(centre_i - Math.ceil(halfWidth) - 1, step, horizontal, cellType, width, height, perp);
      paintBank(centre_i + Math.ceil(halfWidth) + 1, step, horizontal, cellType, width, height, perp);
    }
  }
}

/**
 * Paints a single bank cell (Wall) if the position is in bounds and empty.
 *
 * @param perpIdx    - Perpendicular index of the bank cell.
 * @param step       - Primary-axis step (column if horizontal, row if vertical).
 * @param horizontal - Axis orientation.
 * @param cellType   - Grid buffer.
 * @param width      - Grid width.
 * @param height     - Grid height.
 * @param perp       - Perpendicular dimension.
 */
function paintBank(
  perpIdx: number,
  step: number,
  horizontal: boolean,
  cellType: Uint8Array,
  width: number,
  height: number,
  perp: number,
): void {
  if (perpIdx < 0 || perpIdx >= perp) return;
  const [px, py] = horizontal ? [step, perpIdx] : [perpIdx, step];
  if (px < 0 || px >= width || py < 0 || py >= height) return;
  const i = py * width + px;
  // Banks only replace Empty cells — don't overwrite existing obstacles or life.
  if (cellType[i] !== 0 /* CellType.Empty */) return;
  cellType[i] = 2 /* CellType.Wall */;
}
