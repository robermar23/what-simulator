/**
 * @fileoverview Math utility helpers for the What Simulator.
 *
 * All grid coordinate math lives here so every other module can stay
 * ignorant of the flat-array layout.  The grid is stored as a 1-D
 * TypedArray of length `width * height`; a cell at column `x`, row `y`
 * lives at index `y * width + x`.
 */

// ---------------------------------------------------------------------------
// Grid index helpers
// ---------------------------------------------------------------------------

/**
 * Converts a 2-D grid coordinate to a flat 1-D array index.
 *
 * @param x - Column (0 … width-1).
 * @param y - Row    (0 … height-1).
 * @param width - Grid width in cells.
 * @returns The flat array index for (x, y).
 */
export function toIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

/**
 * Converts a flat 1-D array index back to a 2-D (x, y) coordinate.
 *
 * @param index - Flat array index.
 * @param width - Grid width in cells.
 * @returns Tuple [x, y].
 */
export function fromIndex(index: number, width: number): [number, number] {
  const x = index % width;
  const y = (index - x) / width;
  return [x, y];
}

/**
 * Returns the flat indices of the 4 Von Neumann neighbors (N, S, E, W) for
 * cell `i`.  Out-of-bounds neighbors are omitted — the result length is 2–4.
 *
 * @param i - Flat index of the source cell.
 * @param width - Grid width in cells.
 * @param height - Grid height in cells.
 * @returns Array of valid neighbor flat indices.
 */
export function vonNeumannNeighbors(
  i: number,
  width: number,
  height: number,
): readonly number[] {
  const x = i % width;
  const y = (i - x) / width;
  const neighbors: number[] = [];

  if (y > 0)          neighbors.push(i - width);   // North
  if (y < height - 1) neighbors.push(i + width);   // South
  if (x > 0)          neighbors.push(i - 1);       // West
  if (x < width - 1)  neighbors.push(i + 1);       // East

  return neighbors;
}

/**
 * Returns the flat indices of the 8 Moore neighbors (N, NE, E, SE, S, SW, W,
 * NW) for cell `i`.  Out-of-bounds neighbors are omitted.
 *
 * @param i - Flat index of the source cell.
 * @param width - Grid width in cells.
 * @param height - Grid height in cells.
 * @returns Array of valid neighbor flat indices (2–8 elements).
 */
export function mooreNeighbors(
  i: number,
  width: number,
  height: number,
): readonly number[] {
  const x = i % width;
  const y = (i - x) / width;
  const neighbors: number[] = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue; // skip self
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        neighbors.push(ny * width + nx);
      }
    }
  }

  return neighbors;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

/**
 * Clamps `value` to the inclusive range [min, max].
 *
 * @param value - Input value.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns Clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Linear interpolation between `a` and `b` by factor `t` (0 … 1).
 *
 * @param a - Start value.
 * @param b - End value.
 * @param t - Interpolation factor.
 * @returns Interpolated value.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Returns a pseudo-random integer in the range [0, max).
 * Uses Math.random — sufficient for simulation randomness.
 *
 * @param max - Exclusive upper bound.
 * @returns Random integer in [0, max).
 */
export function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}
