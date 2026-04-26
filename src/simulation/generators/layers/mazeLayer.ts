/**
 * @fileoverview MazeLayer — recursive-division wall maze generation.
 *
 * Uses the recursive division algorithm to generate a maze structure within
 * the specified fraction of the grid.  Each recursive subdivision draws a
 * horizontal or vertical wall with one or more gaps, then recurses on both
 * sub-chambers.  The `density` parameter controls how aggressively walls are
 * drawn — lower values produce more open layouts.
 */

import { CellType }      from '../../GridState.js';
import { type MazeLayer } from '../types.js';

/**
 * Applies a MazeLayer to the grid's cellType buffer.
 *
 * @param layer    - Maze specification.
 * @param cellType - Grid cellType buffer (written in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator.
 */
export function applyMazeLayer(
  layer: MazeLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  const frac = layer.coverageFraction ?? 0.8;
  const corridorWidth = layer.corridorWidth ?? 2;

  // Compute a centred sub-grid for the maze.
  const mw = Math.floor(width  * frac);
  const mh = Math.floor(height * frac);
  const ox = Math.floor((width  - mw) / 2);
  const oy = Math.floor((height - mh) / 2);

  divideRecursive(
    ox, oy, mw, mh,
    layer.density,
    corridorWidth,
    layer.cellType,
    cellType,
    width,
    height,
    rng,
  );
}

/**
 * Recursively divides a chamber with a wall + gaps, then recurses on each
 * sub-chamber.  Stops when the chamber is too small for a corridor.
 *
 * @param x       - Left edge of chamber (grid column).
 * @param y       - Top edge of chamber (grid row).
 * @param w       - Chamber width in cells.
 * @param h       - Chamber height in cells.
 * @param density - Probability [0, 1] that a wall is actually drawn in this call.
 * @param cw      - Minimum corridor width (minimum gap size).
 * @param wallType - CellType to write for wall cells.
 * @param cellType - Grid buffer.
 * @param gw      - Total grid width.
 * @param gh      - Total grid height.
 * @param rng     - RNG.
 */
function divideRecursive(
  x: number, y: number, w: number, h: number,
  density: number,
  cw: number,
  wallType: CellType,
  cellType: Uint8Array,
  gw: number,
  gh: number,
  rng: () => number,
): void {
  // Stop: chamber too small to meaningfully subdivide.
  const minSize = cw * 2 + 1;
  if (w < minSize && h < minSize) return;

  // Probabilistically skip this wall entirely (controls density).
  if (rng() >= density) {
    // Even if we skip the wall, recurse so sub-chambers still get filled.
    if (w >= h) {
      const mid = Math.floor(w / 2);
      divideRecursive(x,       y, mid,     h, density, cw, wallType, cellType, gw, gh, rng);
      divideRecursive(x + mid, y, w - mid, h, density, cw, wallType, cellType, gw, gh, rng);
    } else {
      const mid = Math.floor(h / 2);
      divideRecursive(x, y,       w, mid,     density, cw, wallType, cellType, gw, gh, rng);
      divideRecursive(x, y + mid, w, h - mid, density, cw, wallType, cellType, gw, gh, rng);
    }
    return;
  }

  // Choose orientation: horizontal wall if chamber is wider; vertical if taller.
  const horizontal = w >= h;

  if (horizontal && w >= minSize) {
    // Draw a vertical wall at a random x offset, leaving one gap of width cw.
    const wallX = x + cw + Math.floor(rng() * (w - cw * 2));
    const gapY  = y + Math.floor(rng() * (h - cw + 1));

    for (let row = y; row < y + h; row++) {
      // Skip the gap region.
      if (row >= gapY && row < gapY + cw) continue;
      paintWall(wallX, row, wallType, cellType, gw, gh);
    }
    divideRecursive(x,          y, wallX - x,     h, density, cw, wallType, cellType, gw, gh, rng);
    divideRecursive(wallX + 1,  y, x + w - wallX - 1, h, density, cw, wallType, cellType, gw, gh, rng);
  } else if (!horizontal && h >= minSize) {
    // Draw a horizontal wall at a random y offset, leaving one gap of width cw.
    const wallY = y + cw + Math.floor(rng() * (h - cw * 2));
    const gapX  = x + Math.floor(rng() * (w - cw + 1));

    for (let col = x; col < x + w; col++) {
      if (col >= gapX && col < gapX + cw) continue;
      paintWall(col, wallY, wallType, cellType, gw, gh);
    }
    divideRecursive(x, y,          w, wallY - y,     density, cw, wallType, cellType, gw, gh, rng);
    divideRecursive(x, wallY + 1,  w, y + h - wallY - 1, density, cw, wallType, cellType, gw, gh, rng);
  }
}

/**
 * Writes a wall cell at (px, py) if the position is valid and currently empty.
 *
 * @param px       - Grid column.
 * @param py       - Grid row.
 * @param wallType - CellType to write.
 * @param cellType - Grid buffer.
 * @param gw       - Grid width.
 * @param gh       - Grid height.
 */
function paintWall(
  px: number, py: number,
  wallType: CellType,
  cellType: Uint8Array,
  gw: number, gh: number,
): void {
  if (px < 0 || px >= gw || py < 0 || py >= gh) return;
  const i = py * gw + px;
  if (cellType[i] === CellType.Life || cellType[i] === CellType.LifeVariant) return;
  cellType[i] = wallType;
}
