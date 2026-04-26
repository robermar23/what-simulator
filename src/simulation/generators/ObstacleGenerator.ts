/**
 * @fileoverview Procedural obstacle generator — entry point.
 *
 * Interprets an {@link ObstacleSpec} declarative description and writes cell
 * types directly into the grid's `cellType` Uint8Array.  Pure function — no
 * DOM, no worker messaging.  Designed to run in the SimulationWorker context
 * but has no dependency on it.
 *
 * ## Usage
 *
 * ```typescript
 * import { generateObstacles } from './generators/ObstacleGenerator.js';
 * import { mulberry32, seedFromKey } from './generators/prng.js';
 *
 * // Deterministic layout (same key → same layout):
 * const rng = mulberry32(seedFromKey('coralReef'));
 * generateObstacles(spec, grid.cellType, grid.width, grid.height, rng);
 *
 * // Non-deterministic:
 * generateObstacles(spec, grid.cellType, grid.width, grid.height, Math.random);
 * ```
 */

import { type ObstacleSpec, type ObstacleLayer } from './types.js';
import { applyScatteredLayer }  from './layers/scatteredLayer.js';
import { applyBorderLayer }     from './layers/borderLayer.js';
import { applyClusterLayer }    from './layers/clusterLayer.js';
import { applyZoneLayer }       from './layers/zoneLayer.js';
import { applyGradientLayer }   from './layers/gradientLayer.js';
import { applyRingLayer }       from './layers/ringLayer.js';
import { applyRiverLayer }      from './layers/riverLayer.js';
import { applyMazeLayer }       from './layers/mazeLayer.js';

// Re-export types so callers only need one import path.
export type {
  ObstacleSpec,
  ObstacleLayer,
  ClusterLayer,
  ZoneLayer,
  MazeLayer,
  RingLayer,
  GradientLayer,
  RiverLayer,
  ScatteredLayer,
  BorderLayer,
} from './types.js';
export { mulberry32, seedFromKey } from './prng.js';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Applies an obstacle specification to the given grid buffer.
 *
 * Each layer in `spec.layers` is dispatched to the appropriate placement
 * function and applied in order.  Life cells in the buffer are never
 * overwritten — obstacles are always placed on top of Empty cells only.
 *
 * @param spec     - Declarative obstacle specification.
 * @param cellType - Grid cellType Uint8Array to write into (mutated in-place).
 * @param width    - Grid width in cells.
 * @param height   - Grid height in cells.
 * @param rng      - Random number generator (seeded or `Math.random`).
 *
 * @example
 * const spec: ObstacleSpec = {
 *   layers: [
 *     { type: 'scattered', cellType: CellType.Toxin,   density: 0.05 },
 *     { type: 'cluster',   cellType: CellType.Wall,    count: 4, radiusRange: [3, 8], density: 0.8 },
 *   ],
 * };
 * generateObstacles(spec, grid.cellType, 256, 256, Math.random);
 */
export function generateObstacles(
  spec: ObstacleSpec,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  for (const layer of spec.layers) {
    dispatchLayer(layer, cellType, width, height, rng);
  }
}

// ---------------------------------------------------------------------------
// Internal layer dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches a single layer to its implementation function.
 *
 * @param layer    - Layer descriptor (discriminated union on `type`).
 * @param cellType - Grid buffer.
 * @param width    - Grid width.
 * @param height   - Grid height.
 * @param rng      - RNG.
 */
function dispatchLayer(
  layer: ObstacleLayer,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void {
  switch (layer.type) {
    case 'scattered':  applyScatteredLayer(layer,  cellType, width, height, rng); break;
    case 'border':     applyBorderLayer(layer,     cellType, width, height, rng); break;
    case 'cluster':    applyClusterLayer(layer,    cellType, width, height, rng); break;
    case 'zone':       applyZoneLayer(layer,       cellType, width, height, rng); break;
    case 'gradient':   applyGradientLayer(layer,   cellType, width, height, rng); break;
    case 'ring':       applyRingLayer(layer,       cellType, width, height, rng); break;
    case 'river':      applyRiverLayer(layer,      cellType, width, height, rng); break;
    case 'maze':       applyMazeLayer(layer,       cellType, width, height, rng); break;
    // TypeScript exhaustiveness guard — compile error if a layer type is added
    // to the union without adding a case here.
    default: {
      const _exhaustive: never = layer;
      console.warn('[ObstacleGenerator] Unknown layer type:', (_exhaustive as ObstacleLayer).type);
    }
  }
}
