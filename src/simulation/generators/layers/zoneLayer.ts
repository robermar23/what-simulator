/**
 * @fileoverview ZoneLayer — rectangular or elliptical filled regions.
 *
 * Fills rectangular or elliptical zones of the grid with a cell type at
 * the specified density.  Zones can optionally be placed without overlap.
 */

import { CellType }      from '../../GridState.js';
import { type ZoneLayer } from '../types.js';

/** Axis-aligned bounding box for placed zones — used for noOverlap checks. */
interface PlacedZone {
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * Applies a ZoneLayer to the grid's cellType buffer.
 *
 * @param layer    - Zone specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator.
 */
export function applyZoneLayer(
  layer: ZoneLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  const placed: PlacedZone[] = [];
  // Allow up to 5× attempts per zone to satisfy noOverlap constraint.
  const maxAttempts = layer.count * 5;
  let attempts = 0;
  let placed_count = 0;

  while (placed_count < layer.count && attempts < maxAttempts) {
    attempts++;

    const [minS, maxS] = layer.sizeRange;
    const halfW = Math.floor((minS + rng() * (maxS - minS)) * width  / 2);
    const halfH = Math.floor((minS + rng() * (maxS - minS)) * height / 2);
    const cx    = Math.floor(rng() * width);
    const cy    = Math.floor(rng() * height);
    const x0    = cx - halfW;
    const y0    = cy - halfH;
    const x1    = cx + halfW;
    const y1    = cy + halfH;

    if (layer.noOverlap && overlapsAny({ x0, y0, x1, y1 }, placed)) continue;

    placed.push({ x0, y0, x1, y1 });
    placed_count++;

    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
        if (!inShape(x, y, cx, cy, halfW, halfH, layer.shape)) continue;
        if (rng() >= layer.density) continue;
        const i = y * width + x;
        if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) continue;
        cellType[i] = layer.cellType;
      }
    }
  }
}

/**
 * Returns true when (x, y) is inside the given zone shape.
 *
 * @param x     - Cell column.
 * @param y     - Cell row.
 * @param cx    - Zone centre column.
 * @param cy    - Zone centre row.
 * @param hw    - Half-width.
 * @param hh    - Half-height.
 * @param shape - 'rectangle' or 'ellipse'.
 */
function inShape(
  x: number, y: number,
  cx: number, cy: number,
  hw: number, hh: number,
  shape: 'rectangle' | 'ellipse',
): boolean {
  if (hw === 0 || hh === 0) return false;
  if (shape === 'rectangle') return true;
  // Ellipse test: (dx/hw)² + (dy/hh)² ≤ 1
  const dx = (x - cx) / hw;
  const dy = (y - cy) / hh;
  return dx * dx + dy * dy <= 1;
}

/**
 * Returns true if candidate overlaps any previously placed zone.
 *
 * @param candidate - Zone to test.
 * @param placed    - Already-placed zones.
 */
function overlapsAny(candidate: PlacedZone, placed: readonly PlacedZone[]): boolean {
  for (const p of placed) {
    if (
      candidate.x0 < p.x1 && candidate.x1 > p.x0 &&
      candidate.y0 < p.y1 && candidate.y1 > p.y0
    ) return true;
  }
  return false;
}
