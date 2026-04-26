/**
 * @fileoverview Environment preset library — Round 5.
 *
 * Each `EnvironmentPreset` bundles:
 *   - A background type (one of the 6 procedural GPU backgrounds)
 *   - A declarative `ObstacleSpec` describing what obstacles to generate
 *   - Display metadata (name, description, difficulty, category)
 *   - A recommended life preset key for suggested pairings
 *
 * Applying an environment preset:
 *   1. Switches the renderer background.
 *   2. Clears all non-life obstacle cells from the grid.
 *   3. Calls `generateObstacles(preset.obstacleSpec, ...)` to place obstacles.
 *   4. Re-seeds life at `seedDensityOverride` (or the current UI density).
 *
 * Presets are ordered from easiest to hardest within each category.
 */

import { CellType }                     from '../GridState.js';
import { type BackgroundType }          from '../../rendering/BackgroundRenderer.js';
import { type ObstacleSpec }            from '../generators/types.js';

// ---------------------------------------------------------------------------
// EnvironmentPreset type
// ---------------------------------------------------------------------------

/**
 * A complete environment preset: background + procedural obstacle layout.
 *
 * Every field is `readonly` — presets are pure data, never mutated at runtime.
 */
export interface EnvironmentPreset {
  /** Stable camelCase key — used for serialisation and EventBus references. */
  readonly key: string;

  /** Short display name shown in the UI card — max 32 characters. */
  readonly name: string;

  /**
   * Two-to-three sentence description of what this environment is and
   * what survival challenge it poses to life.
   */
  readonly description: string;

  /** Background renderer type (one of the 6 procedural environments). */
  readonly backgroundType: BackgroundType;

  /**
   * Difficulty of surviving in this environment.
   * 1 = mostly open; 5 = extremely hostile.
   */
  readonly difficulty: 1 | 2 | 3 | 4 | 5;

  /** Thematic grouping for UI category tabs. */
  readonly category: 'biological' | 'geological' | 'chemical' | 'physical' | 'abstract';

  /**
   * Declarative obstacle layout specification.
   * Passed to `generateObstacles()` when the preset is applied.
   * An empty `layers` array produces a clear grid (The Void).
   */
  readonly obstacleSpec: ObstacleSpec;

  /**
   * Key of the recommended life preset for this environment.
   * Shown as a suggested pairing in the UI.  Must match a `key` in LIFE_PRESETS.
   */
  readonly recommendedLifePreset: string;

  /**
   * Life seed density override [0, 1].
   * `null` = use whatever the UI density slider is currently set to.
   * Some environments benefit from sparse or dense initial seeding.
   */
  readonly seedDensityOverride: number | null;
}

// ---------------------------------------------------------------------------
// Environment preset definitions
// ---------------------------------------------------------------------------

/**
 * All 10 named environment presets, ordered from simplest to most complex.
 *
 * Access by index for UI rendering, or look up by `key` for serialisation.
 */
export const ENVIRONMENT_PRESETS: readonly EnvironmentPreset[] = [

  // =========================================================================
  // 1. The Void — completely empty, no pressure
  // =========================================================================
  {
    key:             'theVoid',
    name:            'The Void',
    description:     'An empty canvas — no obstacles, no resistance, no pressure. Life spreads completely unconstrained, as if in a vacuum. The control condition: useful for comparing against all other environments.',
    backgroundType:  'space',
    difficulty:      1,
    category:        'abstract',
    obstacleSpec: {
      layers: [], // no obstacles
    },
    recommendedLifePreset: 'plague',
    seedDensityOverride:   0.20,
  },

  // =========================================================================
  // 2. Pristine Petri — minimal friction, gentle introduction
  // =========================================================================
  {
    key:             'pristinePetri',
    name:            'Pristine Petri Dish',
    description:     'A clean laboratory petri dish with scattered nutrient patches, a few wall islands, and a partial containment border. Enough friction to be interesting but not enough to seriously threaten life.',
    backgroundType:  'petri',
    difficulty:      1,
    category:        'biological',
    obstacleSpec: {
      layers: [
        // Partial containment border — imperfect cage around the grid.
        {
          type:     'border',
          cellType: CellType.Wall,
          edges:    ['top', 'bottom', 'left', 'right'],
          width:    2,
          density:  0.65,
        },
        // Wall islands to break up open space.
        {
          type:        'cluster',
          cellType:    CellType.Wall,
          count:       5,
          radiusRange: [3, 7] as const,
          density:     0.80,
          avoidCenter: true,
        },
        // Scattered nutrient patches — food sources.
        {
          type:     'scattered',
          cellType: CellType.Nutrient,
          density:  0.04,
        },
        // Sparse drain zones — minor energy sinks.
        {
          type:     'scattered',
          cellType: CellType.Drain,
          density:  0.008,
        },
      ],
    },
    recommendedLifePreset: 'ancientProkaryote',
    seedDensityOverride:   0.25,
  },

  // =========================================================================
  // 3. Coral Reef — rich biology, nutrient hotspots, currents
  // =========================================================================
  {
    key:             'coralReef',
    name:            'Coral Reef',
    description:     'A rich underwater reef with Colony-cell reef structures, nutrient-dense feeding zones, toxin patches from decaying organic matter, and gravity-well currents. Life must navigate between abundant food and sparse toxic zones.',
    backgroundType:  'water',
    difficulty:      2,
    category:        'biological',
    obstacleSpec: {
      layers: [
        // Reef structures — colony cell clusters forming branching coral.
        {
          type:        'cluster',
          cellType:    CellType.Colony,
          count:       6,
          radiusRange: [4, 10] as const,
          density:     0.45,
          avoidCenter: false,
        },
        // Nutrient-rich feeding zones around the reef.
        {
          type:        'cluster',
          cellType:    CellType.Nutrient,
          count:       8,
          radiusRange: [3, 7] as const,
          density:     0.60,
          avoidCenter: true,
        },
        // Scattered toxin — organic decay products.
        {
          type:     'scattered',
          cellType: CellType.Toxin,
          density:  0.015,
        },
        // Gravity wells — ocean current eddies pulling life toward vortex centres.
        {
          type:     'scattered',
          cellType: CellType.GravityWell,
          density:  0.006,
        },
        // Drain zones — cold thermoclines draining energy from surface life.
        {
          type:     'scattered',
          cellType: CellType.Drain,
          density:  0.010,
        },
      ],
    },
    recommendedLifePreset: 'biofilmArchitect',
    seedDensityOverride:   0.20,
  },

  // =========================================================================
  // 4. Ancient Forest Floor — leaf veins, root networks, debris
  // =========================================================================
  {
    key:             'ancientForestFloor',
    name:            'Ancient Forest Floor',
    description:     'A decaying leaf surface with nutrient-rich veins, colony-cell root network hubs, drain puddles, and scattered barrier debris. Life can follow the vein highways to spread quickly, but the drain zones sap frontier cells.',
    backgroundType:  'leaf',
    difficulty:      2,
    category:        'biological',
    obstacleSpec: {
      layers: [
        // Horizontal leaf vein — main nutrient highway.
        {
          type:         'river',
          cellType:     CellType.Nutrient,
          axis:         'horizontal',
          width:        4,
          meanderFactor: 0.20,
          startOffset:  0.5,
        },
        // Vertical secondary vein.
        {
          type:         'river',
          cellType:     CellType.Nutrient,
          axis:         'vertical',
          width:        3,
          meanderFactor: 0.15,
          startOffset:  0.5,
        },
        // Root network hubs — colony cells at vein junctions.
        {
          type:        'cluster',
          cellType:    CellType.Colony,
          count:       4,
          radiusRange: [3, 8] as const,
          density:     0.40,
          avoidCenter: false,
        },
        // Drain puddles — moisture-drain zones between veins.
        {
          type:     'scattered',
          cellType: CellType.Drain,
          density:  0.018,
        },
        // Fallen debris — barrier clusters blocking direct paths.
        {
          type:        'cluster',
          cellType:    CellType.Barrier,
          count:       6,
          radiusRange: [2, 5] as const,
          density:     0.85,
          avoidCenter: true,
        },
      ],
    },
    recommendedLifePreset: 'jurassicMegaflora',
    seedDensityOverride:   0.15,
  },

  // =========================================================================
  // 5. Deep Sea Thermal Vents — vents, cold depths, chemosynthesis
  // =========================================================================
  {
    key:             'deepSeaVents',
    name:            'Deep Sea Thermal Vents',
    description:     'Thermal vent upwellings (gravity wells) create powerful currents; vent mouths are nutrient-rich while the abyssal floor drains energy. Chemosynthetic toxin seeps and occasional ice cold-pockets challenge life at depth.',
    backgroundType:  'deepsea',
    difficulty:      3,
    category:        'geological',
    obstacleSpec: {
      layers: [
        // Vent upwellings — gravity wells pulling life upward.
        {
          type:        'cluster',
          cellType:    CellType.GravityWell,
          count:       5,
          radiusRange: [3, 6] as const,
          density:     0.65,
          avoidCenter: false,
        },
        // Vent mouths — nutrient hotspots at each vent base.
        {
          type:        'cluster',
          cellType:    CellType.Nutrient,
          count:       5,
          radiusRange: [2, 4] as const,
          density:     0.80,
          avoidCenter: true,
        },
        // Cold abyssal floor — drain gradient strongest at edges.
        {
          type:           'gradient',
          cellType:       CellType.Drain,
          direction:      'radial-out',
          minProbability: 0.00,
          maxProbability: 0.06,
        },
        // Chemosynthetic toxin seeps — byproducts of vent chemistry.
        {
          type:     'scattered',
          cellType: CellType.Toxin,
          density:  0.015,
        },
        // Occasional ice cold-pockets — freezing abyssal currents.
        {
          type:     'scattered',
          cellType: CellType.Ice,
          density:  0.008,
        },
      ],
    },
    recommendedLifePreset: 'extremophile',
    seedDensityOverride:   0.20,
  },

  // =========================================================================
  // 6. Volcanic Badlands — fire rivers, toxic gas, lava ridges
  // =========================================================================
  {
    key:             'volcanicBadlands',
    name:            'Volcanic Badlands',
    description:     'Flowing fire rivers divide the landscape; volcanic gas seeps create toxic edge gradients; impenetrable lava ridges force life through narrow passages. Only highly resistant life can establish a foothold.',
    backgroundType:  'soil',
    difficulty:      4,
    category:        'geological',
    obstacleSpec: {
      layers: [
        // Primary lava river crossing the grid horizontally.
        {
          type:         'river',
          cellType:     CellType.Fire,
          axis:         'horizontal',
          width:        3,
          meanderFactor: 0.35,
          startOffset:  0.35,
          addBanks:     true,
        },
        // Secondary diagonal lava flow — vertical meander.
        {
          type:         'river',
          cellType:     CellType.Fire,
          axis:         'vertical',
          width:        2,
          meanderFactor: 0.40,
          startOffset:  0.65,
        },
        // Volcanic gas — toxin gradient increasing toward grid edge.
        {
          type:           'gradient',
          cellType:       CellType.Toxin,
          direction:      'radial-out',
          minProbability: 0.01,
          maxProbability: 0.10,
        },
        // Lava ridges — impassable wall clusters.
        {
          type:        'cluster',
          cellType:    CellType.Wall,
          count:       8,
          radiusRange: [4, 10] as const,
          density:     0.85,
          avoidCenter: true,
        },
        // Fumarole drain zones — sapping energy from nearby cells.
        {
          type:     'scattered',
          cellType: CellType.Drain,
          density:  0.018,
        },
      ],
    },
    recommendedLifePreset: 'extremophile',
    seedDensityOverride:   0.30,
  },

  // =========================================================================
  // 7. Labyrinth — recursive maze, nutrient rewards, gravity attractor
  // =========================================================================
  {
    key:             'labyrinth',
    name:            'The Labyrinth',
    description:     'A dense wall maze covers 70% of the grid. Nutrients are scattered inside the maze interior as rewards for navigation. A central gravity well pulls life toward the maze heart. Colony hubs at junctions provide cooperative support.',
    backgroundType:  'petri',
    difficulty:      3,
    category:        'abstract',
    obstacleSpec: {
      layers: [
        // Recursive division maze — the main obstacle structure.
        {
          type:             'maze',
          cellType:         CellType.Wall,
          density:          0.55,
          corridorWidth:    3,
          coverageFraction: 0.72,
        },
        // Nutrients scattered inside the maze interior (not at edges).
        {
          type:     'scattered',
          cellType: CellType.Nutrient,
          density:  0.030,
          region:   [0.15, 0.15, 0.85, 0.85] as const,
        },
        // Central gravity well — pulls life toward maze heart.
        {
          type:        'zone',
          cellType:    CellType.GravityWell,
          count:       1,
          shape:       'ellipse',
          sizeRange:   [0.05, 0.07] as const,
          density:     0.80,
        },
        // Colony hubs at maze junctions — cooperative support points.
        {
          type:     'scattered',
          cellType: CellType.Colony,
          density:  0.005,
          region:   [0.15, 0.15, 0.85, 0.85] as const,
        },
      ],
    },
    recommendedLifePreset: 'nomadicScavenger',
    seedDensityOverride:   0.20,
  },

  // =========================================================================
  // 8. Antibiotic Gauntlet — selection pressure zones
  // =========================================================================
  {
    key:             'antibioticGauntlet',
    name:            'Antibiotic Gauntlet',
    description:     'Three antibiotic bands divide the grid into four zones. Life must evolve antibiotic resistance to cross each band. Mutagen hotspots near the bands accelerate evolution. Nutrient rewards on the far side incentivise crossing.',
    backgroundType:  'petri',
    difficulty:      4,
    category:        'chemical',
    obstacleSpec: {
      layers: [
        // First antibiotic band at x ≈ 25%.
        {
          type:         'river',
          cellType:     CellType.Antibiotic,
          axis:         'vertical',
          width:        6,
          meanderFactor: 0.05,
          startOffset:  0.25,
        },
        // Second antibiotic band at x ≈ 50%.
        {
          type:         'river',
          cellType:     CellType.Antibiotic,
          axis:         'vertical',
          width:        6,
          meanderFactor: 0.05,
          startOffset:  0.50,
        },
        // Third antibiotic band at x ≈ 75%.
        {
          type:         'river',
          cellType:     CellType.Antibiotic,
          axis:         'vertical',
          width:        6,
          meanderFactor: 0.05,
          startOffset:  0.75,
        },
        // Mutagen hotspots near each band — accelerate evolution.
        {
          type:        'cluster',
          cellType:    CellType.Mutagen,
          count:       6,
          radiusRange: [3, 6] as const,
          density:     0.50,
          avoidCenter: false,
        },
        // Nutrient reward zones on the far side (right quarter).
        {
          type:      'zone',
          cellType:  CellType.Nutrient,
          count:     4,
          shape:     'ellipse',
          sizeRange: [0.04, 0.09] as const,
          density:   0.70,
        },
        // Sparse colony support — rare cooperative refuges.
        {
          type:     'scattered',
          cellType: CellType.Colony,
          density:  0.004,
        },
      ],
    },
    recommendedLifePreset: 'evolutionarySprinter',
    seedDensityOverride:   0.25,
  },

  // =========================================================================
  // 9. Radioactive Wastes — permanent radiation, genome reset zones
  // =========================================================================
  {
    key:             'radioactiveWastes',
    name:            'Radioactive Wastes',
    description:     'RadioWaste clusters blanket the landscape with permanent ionising radiation. Rewinder zones reset genomes of cells that rest in them. No nutrients anywhere — pure survival pressure. Only toxin-resistant life persists.',
    backgroundType:  'space',
    difficulty:      5,
    category:        'chemical',
    obstacleSpec: {
      layers: [
        // Solid containment border — life cannot escape.
        {
          type:     'border',
          cellType: CellType.Wall,
          edges:    ['top', 'bottom', 'left', 'right'],
          width:    1,
          density:  1.0,
        },
        // Major RadioWaste clusters — concentrated radiation sources.
        {
          type:        'cluster',
          cellType:    CellType.RadioWaste,
          count:       10,
          radiusRange: [4, 9] as const,
          density:     0.60,
          avoidCenter: true,
        },
        // Background radiation — scattered individual hot cells.
        {
          type:     'scattered',
          cellType: CellType.RadioWaste,
          density:  0.025,
        },
        // Rewinder zones — genome-reset pressure prevents full resistance.
        {
          type:        'cluster',
          cellType:    CellType.Rewinder,
          count:       4,
          radiusRange: [2, 5] as const,
          density:     0.50,
          avoidCenter: false,
        },
      ],
    },
    recommendedLifePreset: 'radiationWasteland',
    seedDensityOverride:   0.30,
  },

  // =========================================================================
  // 10. Immune System Battleground — antibody zones, memory editing, hubs
  // =========================================================================
  {
    key:             'immuneBattleground',
    name:            'Immune Battleground',
    description:     'Modelling a host immune system: antibody zones (Antibiotic ellipses), immune memory hubs (Colony cells), rewinder patches (immune memory editing), and concentric barrier rings that contain and channel life into kill zones.',
    backgroundType:  'petri',
    difficulty:      5,
    category:        'biological',
    obstacleSpec: {
      layers: [
        // Antibiotic ellipses — antibody attack zones.
        {
          type:      'zone',
          cellType:  CellType.Antibiotic,
          count:     7,
          shape:     'ellipse',
          sizeRange: [0.05, 0.11] as const,
          density:   0.60,
          noOverlap: false,
        },
        // Immune memory hubs — Colony cells providing structural support.
        {
          type:        'cluster',
          cellType:    CellType.Colony,
          count:       3,
          radiusRange: [4, 8] as const,
          density:     0.40,
          avoidCenter: false,
        },
        // Rewinder patches — immune memory editing resets genomes.
        {
          type:        'cluster',
          cellType:    CellType.Rewinder,
          count:       5,
          radiusRange: [2, 6] as const,
          density:     0.50,
          avoidCenter: false,
        },
        // Immune drainage — systemic energy drain across the field.
        {
          type:     'scattered',
          cellType: CellType.Drain,
          density:  0.018,
        },
        // Concentric containment rings with gaps — funnels life into kill zones.
        {
          type:         'ring',
          cellType:     CellType.Barrier,
          count:        2,
          spacing:      30,
          thickness:    2,
          completeness: 0.75,
          center:       [0.5, 0.5] as const,
        },
      ],
    },
    recommendedLifePreset: 'viralStorm',
    seedDensityOverride:   0.25,
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Returns the environment preset with the given key, or `undefined` if not found.
 *
 * @param key - Stable camelCase preset key (e.g. `'coralReef'`).
 * @returns Matching preset or `undefined`.
 */
export function getEnvironmentPreset(key: string): EnvironmentPreset | undefined {
  return ENVIRONMENT_PRESETS.find(p => p.key === key);
}
