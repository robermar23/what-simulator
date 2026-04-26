/**
 * @fileoverview Type definitions for the procedural obstacle generation system.
 *
 * An `ObstacleSpec` is a declarative description of what obstacle layout to
 * generate.  The `ObstacleGenerator` interprets it and writes cell types
 * directly into the grid buffer.  This separation keeps environment preset
 * data as pure JSON-serialisable objects with no code.
 *
 * Layer types mirror biological/geographical concepts so preset authors can
 * think in terms of "coral reef clusters" or "lava river" rather than
 * algorithm parameters.
 */

import { type CellType } from '../GridState.js';

// ---------------------------------------------------------------------------
// ObstacleSpec — top-level descriptor
// ---------------------------------------------------------------------------

/**
 * Declarative description of an obstacle layout to generate.
 *
 * Each entry in `layers` is applied in order to the grid's `cellType` buffer.
 * Layers are additive — later layers can overwrite earlier ones.
 * Life cells (if any exist before generation) are never overwritten.
 */
export interface ObstacleSpec {
  /**
   * Ordered list of obstacle layers to apply.
   * Applied sequentially: layers[0] first, layers[n-1] last.
   */
  readonly layers: readonly ObstacleLayer[];

  /**
   * When `true`, a seeded PRNG is used so the same spec always produces
   * the same obstacle layout — useful for screenshots and reproducibility.
   * When `false` (default), a fresh random layout is generated each apply.
   */
  readonly deterministic?: boolean;
}

// ---------------------------------------------------------------------------
// ObstacleLayer — union of all placement strategies
// ---------------------------------------------------------------------------

/** Discriminated union of all supported obstacle placement strategies. */
export type ObstacleLayer =
  | ClusterLayer
  | ZoneLayer
  | MazeLayer
  | RingLayer
  | GradientLayer
  | RiverLayer
  | ScatteredLayer
  | BorderLayer;

// ---------------------------------------------------------------------------
// ClusterLayer — organic blob clusters (coral, rock formations, etc.)
// ---------------------------------------------------------------------------

/**
 * Generates `count` independent clusters using a random walk with organic
 * falloff — produces irregular shapes rather than hard circles.
 */
export interface ClusterLayer {
  readonly type: 'cluster';
  /** Cell type to write into accepted positions. */
  readonly cellType: CellType;
  /** Number of independent clusters to place. */
  readonly count: number;
  /**
   * [min, max] radius of each cluster in grid cells.
   * Actual shape is irregular — radius is the stochastic mean.
   */
  readonly radiusRange: readonly [number, number];
  /**
   * Fraction [0, 1] of cells within the radius envelope that are filled.
   * 1.0 = solid mass; 0.4 = sparse, speckled appearance.
   */
  readonly density: number;
  /**
   * When true, cluster centres are restricted to the outer 60% of the grid,
   * leaving a free zone around the initial life seed at the centre.
   */
  readonly avoidCenter?: boolean;
}

// ---------------------------------------------------------------------------
// ZoneLayer — rectangular or elliptical filled regions
// ---------------------------------------------------------------------------

/**
 * Fills rectangular or elliptical regions of the grid with a cell type.
 * Useful for creating distinct ecological biomes or resource zones.
 */
export interface ZoneLayer {
  readonly type: 'zone';
  readonly cellType: CellType;
  /** Number of zones to place. */
  readonly count: number;
  /** Shape of each zone. */
  readonly shape: 'rectangle' | 'ellipse';
  /**
   * [min, max] size of each zone as fraction [0, 1] of the relevant grid axis.
   * e.g. [0.05, 0.15] → zones spanning 5–15% of the grid width/height.
   */
  readonly sizeRange: readonly [number, number];
  /**
   * Fill density within the zone boundary.
   * 1.0 = fully filled; 0.5 = sparse interior.
   */
  readonly density: number;
  /** When true, zones are placed so they do not overlap each other. */
  readonly noOverlap?: boolean;
}

// ---------------------------------------------------------------------------
// MazeLayer — recursive-division wall maze
// ---------------------------------------------------------------------------

/**
 * Generates a maze using the recursive division algorithm then writes wall
 * cells into maze boundaries.  Creates labyrinthine structures that force
 * life to navigate corridors rather than spreading in all directions.
 */
export interface MazeLayer {
  readonly type: 'maze';
  /** Usually `CellType.Wall` but any blocking cell type is valid. */
  readonly cellType: CellType;
  /**
   * Wall density [0, 1].
   * 0 = no walls; 1 = maximum cell walls from full recursive division.
   * Values 0.2–0.5 produce partial mazes with navigable corridors.
   */
  readonly density: number;
  /**
   * Minimum corridor width in cells (default: 2).
   * Higher values produce wider pathways — easier for life to traverse.
   */
  readonly corridorWidth?: number;
  /**
   * Fraction [0, 1] of the grid area to apply the maze to.
   * e.g. 0.6 = maze covers a centred 60%-area sub-grid; rest is clear.
   */
  readonly coverageFraction?: number;
}

// ---------------------------------------------------------------------------
// RingLayer — concentric rings / annuli
// ---------------------------------------------------------------------------

/**
 * Generates concentric ring obstacles centred on a point (default: centre).
 * Creates "bullseye" pressure zones — life must break through each ring
 * to expand outward.
 */
export interface RingLayer {
  readonly type: 'ring';
  readonly cellType: CellType;
  /** Number of concentric rings to generate. */
  readonly count: number;
  /**
   * Spacing between ring radii in cells.
   * e.g. 20 → rings at radius 20, 40, 60… from centre.
   */
  readonly spacing: number;
  /** Ring wall thickness in cells. */
  readonly thickness: number;
  /**
   * Fraction [0, 1] of the ring circumference that is solid obstacle.
   * 1.0 = fully closed ring; 0.7 = 30% gaps — life can pass through gaps.
   */
  readonly completeness: number;
  /**
   * Centre of the rings as [x, y] fractions of grid dimensions [0, 1].
   * Defaults to [0.5, 0.5] (grid centre) when omitted.
   */
  readonly center?: readonly [number, number];
}

// ---------------------------------------------------------------------------
// GradientLayer — probability gradient scatter
// ---------------------------------------------------------------------------

/**
 * Places obstacles with a probability that varies smoothly across the grid.
 * Creates environmental gradients — e.g. toxin concentration increasing
 * toward one edge, or radiation strongest at the grid centre.
 */
export interface GradientLayer {
  readonly type: 'gradient';
  readonly cellType: CellType;
  /** Direction of increasing probability. */
  readonly direction: 'left-right' | 'top-bottom' | 'radial-in' | 'radial-out';
  /**
   * Placement probability at the low end of the gradient (safe side).
   * e.g. 0 = no obstacles at the safe edge.
   */
  readonly minProbability: number;
  /**
   * Placement probability at the high end of the gradient (dangerous side).
   * e.g. 0.3 = 30% of cells at the dangerous edge are obstacle.
   */
  readonly maxProbability: number;
}

// ---------------------------------------------------------------------------
// RiverLayer — wandering channel / path
// ---------------------------------------------------------------------------

/**
 * Creates a meandering channel of one cell type across the grid, traversing
 * from one edge to the opposite.  Models rivers (Nutrient channels), lava
 * flows (Fire), or antibiotic bands.
 */
export interface RiverLayer {
  readonly type: 'river';
  readonly cellType: CellType;
  /** Axis the river primarily traverses. */
  readonly axis: 'horizontal' | 'vertical';
  /**
   * Target width of the river channel in cells.
   * Actual width varies as the river meanders.
   */
  readonly width: number;
  /**
   * Maximum perpendicular deviation as fraction of the grid's perpendicular
   * dimension [0, 1].
   * e.g. 0.3 → river meanders ±30% of the grid height when axis=horizontal.
   */
  readonly meanderFactor: number;
  /**
   * When true, Wall cells are placed on both banks of the river (1 cell wide).
   * Creates a contained channel — life cannot spread across without breaching.
   * Only placed where the bank cell would be Empty.
   */
  readonly addBanks?: boolean;
  /**
   * Starting position along the perpendicular axis as a fraction [0, 1].
   * e.g. 0.5 = starts at the grid's midpoint (default).
   * e.g. 0.33 = starts at one-third of the way across.
   */
  readonly startOffset?: number;
}

// ---------------------------------------------------------------------------
// ScatteredLayer — uniform random scatter
// ---------------------------------------------------------------------------

/**
 * Randomly places individual obstacle cells across the grid (or a
 * sub-region) at a given density.  Creates sparse backgrounds — e.g.
 * occasional radioactive waste, ambient nutrient noise.
 */
export interface ScatteredLayer {
  readonly type: 'scattered';
  readonly cellType: CellType;
  /**
   * Fraction [0, 1] of grid cells (within the optional region) to fill.
   * 0.05 = sparse 5%; 0.20 = moderate density.
   */
  readonly density: number;
  /**
   * Optional sub-region to scatter within, as [x0, y0, x1, y1] fractions
   * of grid dimensions.  Defaults to the full grid when omitted.
   */
  readonly region?: readonly [number, number, number, number];
}

// ---------------------------------------------------------------------------
// BorderLayer — edge-hugging obstacle band
// ---------------------------------------------------------------------------

/**
 * Places a band of obstacles along one or more grid edges.
 * Creates boundary effects — wall containment, toxic edge gradients, etc.
 */
export interface BorderLayer {
  readonly type: 'border';
  readonly cellType: CellType;
  /** Which edges to apply the border to. */
  readonly edges: readonly ('top' | 'bottom' | 'left' | 'right')[];
  /** Width of the border band in cells. */
  readonly width: number;
  /**
   * Density of obstacle fill within the border band [0, 1].
   * 1.0 = solid border; 0.6 = border with gaps.
   */
  readonly density: number;
}
