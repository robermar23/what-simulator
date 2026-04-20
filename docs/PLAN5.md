# Phase 17 — Round 5: Expanded Presets & Environment Generator

## Vision

Round 5 transforms the preset system from a collection of simple tuning snapshots
into a two-axis design space:

- **Life Presets** — a rich library of named organisms with fully-specified genomes,
  lifecycle stages, adaptive behaviours, quorum logic, chemotaxis weights, and
  competition dynamics.  Every parameter added since Round 1 is wired in.

- **Environment Presets** — a new concept: an *Environment* bundles a background,
  an intelligently-generated obstacle layout, and an initial seed strategy into a
  single one-click scenario.  An empty canvas is a vacuum — environments make that
  vacuum hostile, nutritious, radioactive, or labyrinthine.

Together they answer the question: *"What happens when organism X tries to survive
in environment Y?"*

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [Phase 17a — Life Preset Library v2](#2-phase-17a--life-preset-library-v2)
3. [Phase 17b — Environment Preset Infrastructure](#3-phase-17b--environment-preset-infrastructure)
4. [Phase 17c — Procedural Obstacle Generator](#4-phase-17c--procedural-obstacle-generator)
5. [Phase 17d — Environment Preset Library](#5-phase-17d--environment-preset-library)
6. [Phase 17e — Preset UI/UX Overhaul](#6-phase-17e--preset-uiux-overhaul)
7. [Architecture & Data Flow](#7-architecture--data-flow)
8. [File Manifest](#8-file-manifest)
9. [Implementation Order](#9-implementation-order)
10. [Testing Strategy](#10-testing-strategy)

---

## 1. Current State Audit

### 1.1 Existing Life Presets (9 total)

| Preset | Fields Used | Missing Variables |
|---|---|---|
| `slowBurn` | spreadRate, energyDecayRate, initialEnergy | All Phase 9–15 params |
| `plague` | spreadRate, energyDecayRate, reproductionThreshold, initialEnergy | All Phase 9–15 params |
| `classicGameOfLife` | spreadRate, energyDecayRate, over/under-population | All Phase 9–15 params |
| `ecosystemBalance` | Core + obstacle params + mutation + toxinResistance | Phase 9–15 params |
| `naturalSelection` | Phase 15 params + antibiotic | Missing heatResist, quorum detail |
| `coevolution` | Phase 15 partial | Missing adaptive inheritance detail |
| `mutagenicChaos` | High mutation | Missing lifecycle, chemotaxis |
| `stableColony` | Quorum, colonyBoost | Missing genome-aware obstacles |
| `radiationWasteland` | radioWaste, adaptive bias | Missing quorum, chemotaxis |

**Gap**: No preset uses all 35+ SimulationConfig fields.  All presets spread
`...defaultConfig()` and override a handful of values.  The genome-aware obstacle
parameters (`mutagenBoost`, `rewinderStrength`, `colonyBoost`, etc.) and lifecycle
parameters (`juvenileThreshold`, `senescentThreshold`, `apoptosisBoost`) are only
partially represented.  Phase 15 evolution behaviour (`adaptiveMutationBias`,
`chemotaxisWeight`, `signalDiffusion`, `quorumThreshold`, `adaptiveInheritanceRate`)
is used in only 3 of the 9 presets.

### 1.2 What Environments Currently Look Like

Six procedural backgrounds exist (Petri, Water, Leaf, Soil, Space, DeepSea), all
rendered in WebGL.  Obstacles are placed manually by the user via drawing tools.
There is no "apply an interesting obstacle layout automatically" feature.
An empty canvas with any life preset results in unconstrained flood-fill — there is
no environmental pressure.

### 1.3 SimulationConfig Parameter Inventory

All parameters that a life preset should explicitly set:

**Core (8):** `spreadRate`, `energyDecayRate`, `reproductionThreshold`,
`initialEnergy`, `mutationRate`, `pointMutationRate`, `neighbourhoodMode`,
`censusInterval`

**Lifecycle (3):** `juvenileThreshold`, `senescentThreshold`, `apoptosisBoost`

**Population pressure (2):** `overpopulationLimit`, `underpopulationLimit`

**Variant B (5):** `variantSpreadRate`, `variantEnergyDecayRate`,
`variantReproductionThreshold`, `variantInitialEnergy`, `competitionStrength`

**Environmental sensitivity (3):** `toxinResistance`, `nutrientAbsorption`,
`gravityResponse`

**Obstacle parameters (8):** `toxinStrength`, `toxinDurability`, `nutrientBoost`,
`nutrientDecayRate`, `barrierLifetime`, `gravityStrength`, `drainRate`,
`fireBurnRate`

**Genome-aware obstacles (7):** `mutagenBoost`, `mutagenDecayRate`,
`radioWasteDamage`, `antibioticStrength`, `antibioticDecayRate`,
`rewinderStrength`, `colonyBoost`

**Evolution behaviour (5):** `adaptiveMutationBias`, `chemotaxisWeight`,
`signalDiffusion`, `quorumThreshold`, `adaptiveInheritanceRate`

**Total: 41 parameters.**  Every new life preset must address all 41 explicitly
with a comment explaining why each value was chosen.

---

## 2. Phase 17a — Life Preset Library v2

### 2.1 Design Principles

Each preset represents a coherent **organism archetype** — a life strategy drawn
from real biology and evolution theory:

- All 41 parameters are set explicitly (no invisible defaults).
- Every parameter choice has a one-line rationale comment.
- The preset name and description are stored as metadata, not just code comments.
- Presets are grouped by biology archetype: *Primitive*, *Aggressive*, *Cooperative*,
  *Resilient*, *Chaotic*.
- Existing 9 presets are updated to be fully-specified (non-breaking: only fills in
  previously-defaulted values).

### 2.2 Preset Metadata Type

Add to `SimulationConfig.ts`:

```typescript
/**
 * Metadata attached to every named life preset.
 * Drives the UI card display (name, description, difficulty badge, tags).
 */
export interface PresetMeta {
  /** Short display name shown in the UI card (max 24 chars). */
  readonly name: string;

  /**
   * One or two sentence description of the life strategy and what to watch for.
   * Shown as a tooltip / expanded description in the preset panel.
   */
  readonly description: string;

  /**
   * Difficulty of keeping the life alive and interesting to watch.
   * 1 = very forgiving; 5 = highly challenging (easily goes extinct).
   */
  readonly difficulty: 1 | 2 | 3 | 4 | 5;

  /**
   * Biology-inspired archetype tags used to group presets in the UI.
   * Valid values: 'primitive' | 'aggressive' | 'cooperative' | 'resilient' | 'chaotic'
   */
  readonly archetype: 'primitive' | 'aggressive' | 'cooperative' | 'resilient' | 'chaotic';

  /**
   * Recommended background environment type for this organism.
   * Used by the UI "Apply Recommended Environment" button.
   */
  readonly recommendedEnvironment: string;
}

/**
 * A complete named life preset: metadata + full SimulationConfig.
 */
export interface LifePreset {
  readonly meta: PresetMeta;
  readonly config: SimulationConfig;
}
```

### 2.3 New Life Presets (10 additions)

---

#### **1. Ancient Prokaryote** *(Primitive)*

**Concept:** The simplest self-replicating organism — slow metabolism, no
specialisation, no competition, no adaptive learning.  Models pre-Cambrian
microbial mats.  Spreads via Von Neumann diffusion (no diagonal movement).

**Parameters rationale:**

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.20 | Slow — diffusion-limited, not aggressive |
| `energyDecayRate` | 0.002 | Very efficient metabolism, long-lived |
| `reproductionThreshold` | 0.12 | Low bar — minimal energy needed to divide |
| `initialEnergy` | 0.75 | Moderate start |
| `pointMutationRate` | 0.001 | Rare mutation — stable genome |
| `juvenileThreshold` | 50 | Long juvenile phase — careful growth |
| `senescentThreshold` | 1200 | Very long-lived cells |
| `apoptosisBoost` | 0.01 | Minimal recycling signal |
| `neighbourhoodMode` | `vonNeumann` | Orthogonal diffusion only |
| `overpopulationLimit` | 8 | Disabled — no crowding death |
| `underpopulationLimit` | 0 | Disabled — survives in isolation |
| `competitionStrength` | 0.0 | No variant competition |
| `adaptiveMutationBias` | `false` | Pure random drift |
| `chemotaxisWeight` | 0.1 | Minimal nutrient-seeking |
| `quorumThreshold` | 8 | Never enters colony mode |
| `signalDiffusion` | 0.60 | Short-range signals only |
| `mutagenBoost` | 1.5 | Low sensitivity to mutagenic pressure |

---

#### **2. Viral Storm** *(Aggressive)*

**Concept:** Ultra-fast replication, short lifespan, high mutation — models RNA
virus outbreak dynamics.  Saturates the grid in seconds, mutates rapidly, and
burns out once resources are exhausted.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.95 | Near-maximum replication rate |
| `energyDecayRate` | 0.025 | Rapid burnout — live fast, die young |
| `initialEnergy` | 1.0 | Born at full energy |
| `reproductionThreshold` | 0.02 | Reproduces even at near-death |
| `pointMutationRate` | 0.020 | High mutation — antigen drift |
| `juvenileThreshold` | 5 | Matures instantly |
| `senescentThreshold` | 80 | Very short lifespan |
| `apoptosisBoost` | 0.005 | Minimal recycling |
| `competitionStrength` | 0.7 | Variant aggressively displaces base life |
| `variantSpreadRate` | 0.85 | Resistant variant spreads fast |
| `adaptiveMutationBias` | `true` | Immune evasion bias |
| `adaptiveInheritanceRate` | 0.6 | Strong inheritance of acquired resistance |
| `chemotaxisWeight` | 0.05 | Blind spread — no targeting |
| `quorumThreshold` | 8 | No cooperation |
| `censusInterval` | 3 | Fine-grained chart for outbreak curves |
| `overpopulationLimit` | 5 | Some crowding death — wave dynamics |

---

#### **3. Biofilm Architect** *(Cooperative)*

**Concept:** Models bacterial biofilm formation — strong quorum sensing, signal
gradients drive territory demarcation, cooperative energy sharing through Colony
cells, minimal mutation in stable colony state.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.28 | Moderate — wait for quorum before expanding |
| `energyDecayRate` | 0.003 | Efficient in colony mode |
| `quorumThreshold` | 3 | Colony mode activates at 3 same-variant neighbours |
| `signalDiffusion` | 0.94 | Wide signal field — whole colony communicates |
| `chemotaxisWeight` | 0.7 | Strong nutrient gradient following |
| `colonyBoost` | 0.030 | Colony cells generously feed neighbours |
| `adaptiveInheritanceRate` | 0.5 | Acquired skills pass to offspring |
| `pointMutationRate` | 0.002 | Low in colony mode, bursts in pioneers |
| `juvenileThreshold` | 40 | Long establishment phase |
| `senescentThreshold` | 800 | Long-lived mature cells |
| `apoptosisBoost` | 0.045 | Dense recycling feeds frontier expansion |
| `nutrientAbsorption` | 1.0 | Maximum nutrient uptake |
| `gravityResponse` | 0.9 | Follows gravity wells to resource hotspots |

---

#### **4. Evolutionary Sprinter** *(Chaotic)*

**Concept:** Optimised for rapid evolution under pressure — high mutation rate,
strong adaptive bias, fast generation turnover, antibiotic-resistance evolution is
visible in real time (~200 ticks).  Demonstrates Fisher's fundamental theorem.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.42 | Moderate spread — selection acts on spread variants |
| `energyDecayRate` | 0.006 | Moderate pressure — not trivially easy to survive |
| `pointMutationRate` | 0.018 | High: 1.8% per reproduction — diversity engine |
| `adaptiveMutationBias` | `true` | Fitness-improving flips 3× more likely |
| `adaptiveInheritanceRate` | 0.55 | Strong Lamarckian component |
| `juvenileThreshold` | 12 | Fast maturation — short generations |
| `senescentThreshold` | 150 | Short lifespan — rapid generational turnover |
| `apoptosisBoost` | 0.030 | Recycling fuels next generation |
| `chemotaxisWeight` | 0.6 | Seeks nutrients to maximise fitness |
| `quorumThreshold` | 5 | Slower into colony mode — stays pioneer |
| `antibioticStrength` | 0.15 | Environment pressure drives resistance evolution |
| `antibioticDecayRate` | 0.0005 | Antibiotic lasts long enough to create selection |
| `censusInterval` | 4 | Fine-grained resistance curves in chart |
| `competitionStrength` | 0.4 | Fitter variant displaces wild type |

---

#### **5. Extremophile** *(Resilient)*

**Concept:** Life that thrives in conditions that kill normal cells — high toxin
resistance, high heat resistance, low nutrient requirement.  Models archaea in
hydrothermal vents, acid baths, or high-radiation environments.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.22 | Slow spread — extremophiles are not rapid colonisers |
| `energyDecayRate` | 0.001 | Ultra-efficient metabolism |
| `toxinResistance` | 0.75 | High innate resistance |
| `nutrientAbsorption` | 0.5 | Adapted to low-nutrient conditions |
| `gravityResponse` | 0.4 | Less susceptible to physical forces |
| `pointMutationRate` | 0.003 | Moderate — resists mutagenic pressure better |
| `mutagenBoost` | 1.2 | Mostly immune to external mutagenic exposure |
| `radioWasteDamage` | 0.002 | Radiation has reduced impact |
| `juvenileThreshold` | 60 | Very cautious growth phase |
| `senescentThreshold` | 1500 | Exceptionally long-lived |
| `apoptosisBoost` | 0.015 | Slow recycling — stable but not wasteful |
| `toxinStrength` | 0.02 | Toxins in this environment are weaker (mutual tuning) |
| `adaptiveMutationBias` | `true` | Bias toward stress-resistance mutations |
| `adaptiveInheritanceRate` | 0.7 | Strong Lamarckian inheritance — children born resistant |

---

#### **6. Territorial Conquistador** *(Aggressive)*

**Concept:** Aggressive territorial expansion through a combination of high spread
rate, strong competition, early colony consolidation, and chemotaxis to find and
block nutrient sources before rivals can reach them.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.65 | Fast initial expansion |
| `energyDecayRate` | 0.005 | Moderate cost — can sustain aggression |
| `competitionStrength` | 0.7 | Displaces rivals aggressively |
| `variantSpreadRate` | 0.72 | Variant even more aggressive |
| `variantEnergyDecayRate` | 0.007 | Higher cost for higher aggression |
| `chemotaxisWeight` | 0.8 | Races to nutrients |
| `quorumThreshold` | 2 | Enters colony mode early — locks down territory |
| `signalDiffusion` | 0.88 | Wide territorial signals |
| `overpopulationLimit` | 6 | Enforces territory boundaries via crowding death |
| `underpopulationLimit` | 1 | Can't survive in isolation — drives clustering |
| `colonyBoost` | 0.018 | Cooperative support for territorial consolidation |
| `adaptiveMutationBias` | `true` | Evolves toward more competitive phenotypes |
| `juvenileThreshold` | 20 | Fast maturity — born fighters |
| `senescentThreshold` | 300 | Die-off triggers apoptotic wave to fuel next assault |
| `apoptosisBoost` | 0.040 | Dying cells fuel the frontier |

---

#### **7. Nomadic Scavenger** *(Resilient)*

**Concept:** Life that doesn't build stable colonies — survives by constantly
moving toward nutrients, evading toxins, and never staying long enough to be
antibiotic-targeted.  High chemotaxis, low quorum requirement.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.50 | Moderate spread — always moving |
| `energyDecayRate` | 0.008 | Higher cost — nomadic lifestyle is expensive |
| `initialEnergy` | 0.95 | Full energy on birth |
| `chemotaxisWeight` | 0.9 | Maximum nutrient gradient following |
| `signalDiffusion` | 0.7 | Short-range signals — localised decision-making |
| `quorumThreshold` | 8 | Never enters colony mode — always pioneer |
| `toxinResistance` | 0.4 | Moderate resistance — survives brief toxin exposure |
| `nutrientAbsorption` | 1.0 | Maximum uptake when nutrients found |
| `gravityResponse` | 0.85 | Follows gravity wells strategically |
| `juvenileThreshold` | 8 | Near-instant maturity — always on the move |
| `senescentThreshold` | 120 | Short lifespan — constant turnover |
| `apoptosisBoost` | 0.035 | Recycled energy propels next generation forward |
| `adaptiveMutationBias` | `true` | Adapts to local conditions |
| `adaptiveInheritanceRate` | 0.35 | Moderate inheritance |
| `pointMutationRate` | 0.006 | Enough variation to find nutrient routes |

---

#### **8. Jurassic Megaflora** *(Primitive)*

**Concept:** Models slow-growing large organisms — massive cells with long
lifecycles, overpopulation-limited (like plant competition), minimal mutation,
gravity-well-seeking (sun/water analogue), and strong quorum cooperation in
established groves.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.12 | Very slow spread — trees don't rush |
| `energyDecayRate` | 0.001 | Ultra-low decay — decades-long lifespan |
| `initialEnergy` | 0.7 | Seeds start with moderate energy |
| `reproductionThreshold` | 0.5 | Only reproduces when fully established |
| `juvenileThreshold` | 150 | Long juvenile phase — saplings |
| `senescentThreshold` | 3000 | Ancient old-growth — very long-lived |
| `apoptosisBoost` | 0.06 | Fallen tree enriches forest floor |
| `overpopulationLimit` | 4 | Dense canopy prevents new growth |
| `underpopulationLimit` | 1 | Cannot survive alone — needs a grove |
| `neighbourhoodMode` | `vonNeumann` | Orthogonal root/canopy spread |
| `gravityResponse` | 1.0 | Maximum gravity-well seeking (sun/water) |
| `quorumThreshold` | 3 | Colony mode at 3 neighbours — grove formation |
| `pointMutationRate` | 0.001 | Rare mutation — stable species |
| `nutrientAbsorption` | 1.0 | Maximum nutrient use |
| `chemotaxisWeight` | 0.5 | Moderate nutrient seeking |
| `signalDiffusion` | 0.96 | Wide canopy signalling — grove coordination |

---

#### **9. Parasitic Overload** *(Aggressive / Chaotic)*

**Concept:** Life that depends on a host (Variant A) to survive — Variant B is the
parasite that aggressively extracts energy from Variant A while contributing
nothing.  High competition, Variant B has extreme aggression, models parasitism.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.35 | Base (host) spreads cautiously |
| `energyDecayRate` | 0.004 | Host has moderate metabolic cost |
| `variantSpreadRate` | 0.80 | Parasite spreads aggressively |
| `variantEnergyDecayRate` | 0.020 | Parasite burns fast — needs constant host contact |
| `competitionStrength` | 0.9 | Parasite nearly always wins contact |
| `variantInitialEnergy` | 1.0 | Parasite starts with full energy |
| `variantReproductionThreshold` | 0.05 | Parasite reproduces at near-zero energy |
| `pointMutationRate` | 0.008 | Both mutate to adapt to each other |
| `adaptiveMutationBias` | `true` | Arms-race dynamics |
| `competitionStrength` | 0.85 | Near-overwhelming parasite pressure |
| `toxinResistance` | 0.2 | Host has partial toxin resistance |
| `quorumThreshold` | 6 | Host needs large group for defence |
| `signalDiffusion` | 0.90 | Wide host alarm signals |
| `chemotaxisWeight` | 0.3 | Parasite seeks host density, not nutrients |
| `censusInterval` | 5 | Fine-grained host/parasite population chart |

---

#### **10. Neural Network Colony** *(Cooperative / Chaotic)*

**Concept:** Inspired by neural network emergent behaviour — cells cooperate via
wide signal fields to form coordinated macro-structures.  High quorum threshold
forces large clusters before colony mode.  Signal diffusion is extremely wide.
When a colony forms, it exhibits coordinated border expansion waves.

| Parameter | Value | Why |
|---|---|---|
| `spreadRate` | 0.40 | Moderate — signal-coordinated expansion |
| `energyDecayRate` | 0.004 | Moderate cost |
| `quorumThreshold` | 6 | Large clusters needed for colony mode |
| `signalDiffusion` | 0.97 | Near-maximum signal range — global coordination |
| `chemotaxisWeight` | 0.8 | Strong gradient following |
| `colonyBoost` | 0.025 | Colony cells are energy hubs |
| `apoptosisBoost` | 0.050 | Apoptosis triggers coordinated frontier wave |
| `senescentThreshold` | 600 | Stable long-lived interior cells |
| `juvenileThreshold` | 35 | Moderate development phase |
| `pointMutationRate` | 0.004 | Low — stable genome for coordination |
| `adaptiveMutationBias` | `false` | Coordination, not adaptation |
| `rewinderStrength` | 0.08 | Genome rewinders keep population homogenous |
| `censusInterval` | 5 | Watch coordination emerge in charts |
| `overpopulationLimit` | 7 | Near-disabled — dense packing allowed |
| `underpopulationLimit` | 2 | Needs peers to survive |

### 2.4 Refactored Existing Presets

All 9 existing presets are updated so that every one of the 41 parameters is
explicitly set (no reliance on `defaultConfig()` to fill in Phase 15 fields):

- **slowBurn** → add lifecycle params, evolution behaviour at minimal values
- **plague** → add full lifecycle (very short), high chemotaxis
- **classicGameOfLife** → add genome params at neutral (evolution disabled)
- **ecosystemBalance** → fully specify Phase 12 obstacle params
- **naturalSelection** → add quorumThreshold, chemotaxisWeight explicitly
- **coevolution** → add adaptiveInheritanceRate, mutagenBoost explicitly
- **mutagenicChaos** → add chemotaxis, lifecycle explicitly
- **stableColony** → add radioWasteDamage, antibioticStrength explicitly
- **radiationWasteland** → add quorumThreshold, chemotaxisWeight explicitly

### 2.5 Files Changed (Phase 17a)

| File | Change |
|---|---|
| `src/simulation/config/SimulationConfig.ts` | Add `PresetMeta`, `LifePreset` types; add 10 new presets; refactor 9 existing presets to be fully-specified |

---

## 3. Phase 17b — Environment Preset Infrastructure

### 3.1 What an Environment Preset Is

An **Environment Preset** describes a complete simulation scenario:

```typescript
/**
 * A complete environment preset: background + obstacle layout strategy.
 *
 * Applying an environment preset:
 *   1. Sets the background type on the renderer.
 *   2. Calls ObstacleGenerator.generate() to place obstacles on the grid.
 *   3. Optionally recommends a life preset to pair with it.
 */
export interface EnvironmentPreset {
  /** Short display name (max 32 chars). */
  readonly name: string;

  /**
   * Two-to-three sentence description of what this environment is and
   * what challenge it poses to life.
   */
  readonly description: string;

  /** Background type key (must match a key in BackgroundManager). */
  readonly backgroundType: BackgroundType;

  /**
   * Difficulty of surviving in this environment.
   * 1 = mostly empty; 5 = extremely hostile.
   */
  readonly difficulty: 1 | 2 | 3 | 4 | 5;

  /**
   * Thematic category of the environment.
   * Used to group presets in the UI.
   */
  readonly category: 'biological' | 'geological' | 'chemical' | 'physical' | 'abstract';

  /**
   * The obstacle generation specification for this environment.
   * Passed directly to ObstacleGenerator.generate().
   */
  readonly obstacleSpec: ObstacleSpec;

  /**
   * Key of the recommended life preset for this environment.
   * Shown in the UI as a suggested pairing.
   */
  readonly recommendedLifePreset: string;

  /**
   * Fraction of cells to seed with Life on initial placement.
   * Some environments override the global density slider.
   * null = use whatever is currently set in the UI.
   */
  readonly seedDensityOverride: number | null;
}
```

### 3.2 BackgroundType Reference

Existing backgrounds (from Phase 14 / `BackgroundManager`):

```typescript
export type BackgroundType =
  | 'petri'
  | 'water'
  | 'leaf'
  | 'soil'
  | 'space'
  | 'deepSea';
```

No new backgrounds are added in Phase 17 — we use the 6 existing ones.

### 3.3 ObstacleSpec Type

The `ObstacleSpec` is a declarative description of what obstacles to generate.
The generator interprets it to fill the grid:

```typescript
/**
 * Declarative description of an obstacle layout to generate.
 *
 * Each layer in `layers` is applied in order to the grid.
 * Layers are additive — later layers can overwrite earlier ones.
 */
export interface ObstacleSpec {
  /**
   * Ordered list of obstacle layers to apply.
   * Applied sequentially: layer[0] first, then layer[1], etc.
   */
  readonly layers: readonly ObstacleLayer[];

  /**
   * If true, the generator applies a seeded random (PRNG from the grid
   * dimensions) so the same spec always produces the same layout.
   * If false, a new random layout is generated each time.
   *
   * Default: false (different layout each apply).
   */
  readonly deterministic?: boolean;
}

/**
 * One logical layer within an ObstacleSpec.
 * Each layer has a placement strategy and a target cell type.
 */
export type ObstacleLayer =
  | ClusterLayer
  | ZoneLayer
  | MazeLayer
  | RingLayer
  | GradientLayer
  | RiverLayer
  | ScatteredLayer
  | BorderLayer;
```

---

## 4. Phase 17c — Procedural Obstacle Generator

### 4.1 Overview

`ObstacleGenerator` is a pure function module with no DOM dependencies.
It runs in the `SimulationWorker` context (called via a new `'applyEnvironment'`
worker message type) and writes directly into the grid's `cellType` buffer.

```
src/simulation/generators/
  ObstacleGenerator.ts   ← main entry: generate(spec, grid, config)
  layers/
    clusterLayer.ts      ← organic blob clusters
    zoneLayer.ts         ← rectangular / elliptical zones
    mazeLayer.ts         ← recursive maze walls
    ringLayer.ts         ← concentric rings
    gradientLayer.ts     ← probability gradient placement
    riverLayer.ts        ← wandering path / channel
    scatteredLayer.ts    ← uniform random scatter
    borderLayer.ts       ← edge-hugging wall/obstacle bands
```

### 4.2 Layer Types

#### ClusterLayer — Organic Blob Clusters

Generates `count` independent clusters using a random walk + flood-fill to
produce irregular organic shapes.

```typescript
interface ClusterLayer {
  readonly type: 'cluster';
  readonly cellType: CellType;

  /** Number of independent clusters to place. */
  readonly count: number;

  /**
   * Min and max radius of each cluster (in cells).
   * Actual shape is irregular — radius is the stochastic mean.
   */
  readonly radiusRange: readonly [number, number];

  /**
   * Fraction of cells within the radius envelope that are actually filled.
   * 1.0 = solid circle; 0.4 = sparse, speckled appearance.
   */
  readonly density: number;

  /**
   * If true, clusters are placed only in the outer 60% of the grid
   * (leaving a free zone around the initial life seed in the centre).
   */
  readonly avoidCenter?: boolean;
}
```

**Algorithm:**
1. Pick `count` random centre points (respecting `avoidCenter` if set).
2. For each centre, enumerate all cells within `radiusRange[1]`.
3. Accept each cell with probability `density * (1 - distance/maxRadius)^0.5`
   (organic falloff, not hard circle).
4. Write `cellType` to accepted cells in the back buffer.

---

#### ZoneLayer — Rectangular / Elliptical Zones

Fills rectangular or elliptical regions of the grid with a cell type.
Useful for creating distinct ecological biomes.

```typescript
interface ZoneLayer {
  readonly type: 'zone';
  readonly cellType: CellType;

  /** Number of zones to place. */
  readonly count: number;

  /** Shape of each zone. */
  readonly shape: 'rectangle' | 'ellipse';

  /**
   * Width and height range of each zone as fraction [0, 1] of grid size.
   * e.g. [0.05, 0.15] → zones covering 5–15% of each axis.
   */
  readonly sizeRange: readonly [number, number];

  /**
   * Fill density within the zone boundary.
   * 1.0 = fully filled; < 1.0 = sparse.
   */
  readonly density: number;

  /** If true, zones cannot overlap with each other. */
  readonly noOverlap?: boolean;
}
```

---

#### MazeLayer — Recursive Division Wall Maze

Generates a maze using the recursive division algorithm, then writes wall cells
for maze walls.  Creates labyrinthine structures that challenge life to find
corridors.

```typescript
interface MazeLayer {
  readonly type: 'maze';
  readonly cellType: CellType;  // usually CellType.Wall

  /**
   * Cell wall density [0, 1].
   * 0 = no walls; 1 = maximum cell walls from full recursive division.
   * Values 0.2–0.5 produce partial mazes with wide corridors.
   */
  readonly density: number;

  /**
   * Minimum corridor width in cells (default 2).
   * Higher values produce wider pathways.
   */
  readonly corridorWidth?: number;

  /**
   * Fraction of the grid area to use for the maze.
   * e.g. 0.4 = maze covers a 40%-area centred sub-grid.
   * The rest of the grid is left empty.
   */
  readonly coverageFraction?: number;
}
```

**Algorithm:** Recursive division.
1. Start with the full grid (or a sub-region of size `coverageFraction`).
2. Draw a horizontal or vertical wall across the region, leaving `corridorWidth`
   gaps (with probability `density`).
3. Recurse on both sub-regions until minimum cell size is reached.
4. Write wall cells into the maze structure.

---

#### RingLayer — Concentric Rings / Annuli

Generates concentric ring obstacles centred on the grid (or a specified point).
Creates "bullseye" pressure zones — life must break through each ring to expand
outward.

```typescript
interface RingLayer {
  readonly type: 'ring';
  readonly cellType: CellType;

  /** Number of concentric rings. */
  readonly count: number;

  /**
   * Spacing between ring centres in cells.
   * e.g. 20 → rings at radius 20, 40, 60, … from centre.
   */
  readonly spacing: number;

  /** Ring wall thickness in cells. */
  readonly thickness: number;

  /**
   * Fraction [0, 1] of ring circumference that is filled (rest are gaps).
   * 1.0 = closed ring; 0.7 = ring with 30% gaps (life can pass through gaps).
   */
  readonly completeness: number;

  /** Centre point as fraction of grid [0,1]. Defaults to [0.5, 0.5]. */
  readonly center?: readonly [number, number];
}
```

---

#### GradientLayer — Probability Gradient Scatter

Places obstacles with a probability that varies smoothly across the grid
according to a gradient function.  Creates environmental gradients — e.g. toxin
concentration increasing toward one edge.

```typescript
interface GradientLayer {
  readonly type: 'gradient';
  readonly cellType: CellType;

  /** Gradient direction. */
  readonly direction: 'left-right' | 'top-bottom' | 'radial-in' | 'radial-out';

  /**
   * Placement probability at the low end of the gradient [0, 1].
   * e.g. 0 = no obstacles at the safe edge.
   */
  readonly minProbability: number;

  /**
   * Placement probability at the high end of the gradient [0, 1].
   * e.g. 0.3 = 30% of cells at the dangerous edge are this obstacle type.
   */
  readonly maxProbability: number;
}
```

---

#### RiverLayer — Wandering Path / Channel

Creates a meandering channel of one cell type across the grid, optionally
bounded by walls.  Models rivers (Nutrient/Water channels), lava flows (Fire),
or antibiotic bands.

```typescript
interface RiverLayer {
  readonly type: 'river';
  readonly cellType: CellType;

  /** Which axis the river primarily traverses. */
  readonly axis: 'horizontal' | 'vertical';

  /**
   * Width of the river channel in cells.
   * Actual width varies as the river meanders.
   */
  readonly width: number;

  /**
   * Maximum perpendicular deviation as fraction of grid size [0, 1].
   * e.g. 0.3 = river meanders ±30% of the grid height.
   */
  readonly meanderFactor: number;

  /**
   * If set, wall cells are placed on both banks of the river (1 cell thick).
   * Creates a contained channel.
   */
  readonly addBanks?: boolean;
}
```

---

#### ScatteredLayer — Uniform Random Scatter

Randomly places individual obstacle cells across the entire grid (or a
sub-region) at a given density.  Creates sparse backgrounds of
obstacles — e.g. occasional radioactive waste, background noise of nutrients.

```typescript
interface ScatteredLayer {
  readonly type: 'scattered';
  readonly cellType: CellType;

  /**
   * Fraction [0, 1] of grid cells to fill.
   * 0.05 = 5% sparse scatter; 0.2 = moderate density.
   */
  readonly density: number;

  /**
   * Optional rectangular sub-region to scatter within.
   * [x0, y0, x1, y1] as fractions of grid size.
   * Defaults to the full grid if omitted.
   */
  readonly region?: readonly [number, number, number, number];
}
```

---

#### BorderLayer — Edge-Hugging Band

Places a band of obstacles along one or more grid edges.
Creates boundary effects — walls along the top/bottom, toxin bands at the sides.

```typescript
interface BorderLayer {
  readonly type: 'border';
  readonly cellType: CellType;

  /** Which edges to apply the border to. */
  readonly edges: readonly ('top' | 'bottom' | 'left' | 'right')[];

  /** Width of the border band in cells. */
  readonly width: number;

  /**
   * Density of obstacle fill within the border band.
   * 1.0 = solid border; 0.5 = gaps in the border.
   */
  readonly density: number;
}
```

### 4.3 Generator Entry Point

```typescript
// src/simulation/generators/ObstacleGenerator.ts

/**
 * @fileoverview Procedural obstacle generator for environment presets.
 *
 * Interprets an `ObstacleSpec` declarative description and writes cell types
 * directly into the grid's `cellType` Uint8Array.  Pure function — no DOM,
 * no worker messaging.  Runs in the SimulationWorker context.
 */

/**
 * Applies an obstacle spec to the given grid buffers.
 *
 * The grid is written in-place.  Existing Life cells are never overwritten
 * (obstacles are placed first, life seeds after in the environment workflow).
 * Existing Wall cells are preserved unless `replaceWalls` is true.
 *
 * @param spec      - Declarative obstacle specification.
 * @param cellType  - Uint8Array grid buffer to write into.
 * @param width     - Grid width in cells.
 * @param height    - Grid height in cells.
 * @param rng       - Seeded or live random number generator.
 */
export function generateObstacles(
  spec: ObstacleSpec,
  cellType: Uint8Array,
  width: number,
  height: number,
  rng: () => number,
): void { ... }
```

### 4.4 PRNG Strategy

All procedural generation uses a **mulberry32** seedable PRNG.  When
`ObstacleSpec.deterministic = true`, the seed is derived from
`width * height * presetNameHash`.  This makes deterministic layouts
reproducible across sessions, important for screenshots and sharing.

```typescript
/**
 * Mulberry32 — fast, seeded 32-bit PRNG.
 * Returns a function that produces uniform [0, 1) floats.
 *
 * @param seed - 32-bit integer seed.
 * @returns Seeded RNG function.
 */
function mulberry32(seed: number): () => number { ... }
```

### 4.5 Worker Message Type Addition

Add to `workerBridge.ts`:

```typescript
/**
 * Main thread → SimulationWorker: apply an environment preset.
 * The worker calls ObstacleGenerator.generate() and then re-seeds life.
 */
interface ApplyEnvironmentMsg {
  readonly type: 'applyEnvironment';
  readonly spec: ObstacleSpec;
  readonly seedDensity: number;
  readonly backgroundType: BackgroundType;
}
```

Add to `workerBridge.ts` outgoing types:

```typescript
/**
 * SimulationWorker → RenderWorker: switch background type.
 * Forwarded from main thread after environment preset application.
 */
interface BackgroundChangeMsg {
  readonly type: 'backgroundChange';
  readonly backgroundType: BackgroundType;
}
```

---

## 5. Phase 17d — Environment Preset Library

Ten environment presets covering a range of biomes, difficulty levels, and
obstacle strategies.  Each is a complete `EnvironmentPreset` object.

### 5.1 Preset Catalogue

---

#### **1. Pristine Petri** *(biological, difficulty 1)*

The simplest possible environment — a clean petri dish with a handful of
scattered Nutrient patches and a few Wall obstacles along the edges.  Life spreads
nearly unconstrained but encounters some friction.

**Background:** `petri`
**Layers:**
- `BorderLayer`: Wall, width 2, density 0.6, all 4 edges — creates a partial cage
- `ScatteredLayer`: Nutrient, density 0.04 — scattered food sources
- `ClusterLayer`: Wall, count 4, radiusRange [3, 6], density 0.8, avoidCenter — wall islands
**Recommended life:** `ancientProkaryote`

---

#### **2. Coral Reef** *(biological, difficulty 2)*

Rich underwater environment with nutrient-dense Colony zones, gravity wells
representing currents, and scattered toxin patches from decaying organic matter.
Life must navigate between food-rich and food-poor zones.

**Background:** `water`
**Layers:**
- `ClusterLayer`: Colony, count 6, radiusRange [4, 10], density 0.5 — reef structure
- `ClusterLayer`: Nutrient, count 8, radiusRange [3, 7], density 0.6, avoidCenter
- `ScatteredLayer`: Toxin, density 0.015 — toxin from decay
- `ScatteredLayer`: GravityWell, density 0.008 — ocean currents
- `ScatteredLayer`: Drain, density 0.012 — deep cold pockets
**Recommended life:** `biofilmArchitect`

---

#### **3. Ancient Forest Floor** *(biological, difficulty 2)*

A leaf surface teeming with nutrients, Colony patches (root networks), and
scattered Drain zones (puddles / compacted soil).  Barriers represent fallen
branches.  Moderate complexity.

**Background:** `leaf`
**Layers:**
- `RiverLayer`: Nutrient, axis horizontal, width 4, meanderFactor 0.25 — leaf vein nutrients
- `RiverLayer`: Nutrient, axis vertical, width 3, meanderFactor 0.2 — perpendicular vein
- `ClusterLayer`: Colony, count 3, radiusRange [5, 12], density 0.4 — root network hubs
- `ScatteredLayer`: Drain, density 0.018 — moisture-drain zones
- `ClusterLayer`: Barrier, count 5, radiusRange [2, 4], density 0.9, avoidCenter — debris
**Recommended life:** `jurassicMegaflora`

---

#### **4. Volcanic Badlands** *(geological, difficulty 4)*

Soil background with flowing fire rivers, toxin seeps from volcanic gases,
and impenetrable wall ridges.  Life must evolve fire/toxin resistance quickly
or die out.  Very high challenge.

**Background:** `soil`
**Layers:**
- `RiverLayer`: Fire, axis horizontal, width 3, meanderFactor 0.35, addBanks true — lava river
- `RiverLayer`: Fire, axis vertical, width 2, meanderFactor 0.4 — secondary lava flow
- `GradientLayer`: Toxin, direction radial-out, minProbability 0.02, maxProbability 0.12 — toxic edge
- `ClusterLayer`: Wall, count 8, radiusRange [4, 10], density 0.85 — volcanic ridges
- `ScatteredLayer`: Drain, density 0.02 — sapping energy
**Recommended life:** `extremophile`

---

#### **5. Antibiotic Gauntlet** *(chemical, difficulty 4)*

A petri dish split into three vertical zones by antibiotic bands.  Life must
evolve antibiotic resistance to cross each band.  Mutagen clusters accelerate
evolution.  Nutrients on the far side reward successful crossers.

**Background:** `petri`
**Layers:**
- `RiverLayer`: Antibiotic, axis vertical, width 6, meanderFactor 0.05 — antibiotic band 1 at x=0.33
- `RiverLayer`: Antibiotic, axis vertical, width 6, meanderFactor 0.05 — antibiotic band 2 at x=0.66
- `ClusterLayer`: Mutagen, count 5, radiusRange [3, 6], density 0.5 — mutation hotspots near bands
- `ZoneLayer`: Nutrient, shape ellipse, count 4, sizeRange [0.05, 0.10], density 0.7 — reward zones on far side
- `ScatteredLayer`: Colony, density 0.005 — rare cooperative support
**Recommended life:** `evolutionarySprinter`

---

#### **6. Radioactive Wastes** *(chemical, difficulty 5)*

Space background scattered with RadioWaste clusters and periodic Rewinder zones.
Only toxin-resistant life can survive.  No nutrients anywhere — pure survival
pressure.  The hardest environment.

**Background:** `space`
**Layers:**
- `ClusterLayer`: RadioWaste, count 12, radiusRange [4, 9], density 0.6, avoidCenter
- `ScatteredLayer`: RadioWaste, density 0.025 — background radiation
- `ClusterLayer`: Rewinder, count 4, radiusRange [2, 5], density 0.5 — genome reset zones
- `BorderLayer`: Wall, edges ['top', 'bottom', 'left', 'right'], width 1, density 1.0 — total containment
**Recommended life:** `radiationWasteland` *(the matching life preset)*

---

#### **7. Labyrinth** *(abstract, difficulty 3)*

A dense wall maze with scattered nutrients at dead ends and Colony cells at
junctions.  Life must navigate the maze structure.  Gravity wells pull toward
maze center.

**Background:** `petri`
**Layers:**
- `MazeLayer`: Wall, density 0.55, corridorWidth 3, coverageFraction 0.7 — dense maze
- `ScatteredLayer`: Nutrient, density 0.03, region [0.15, 0.15, 0.85, 0.85] — nutrients in maze interior
- `ZoneLayer`: GravityWell, shape ellipse, count 1, sizeRange [0.05, 0.08], density 0.8 — center attractor
- `ScatteredLayer`: Colony, density 0.006 — junction hubs
**Recommended life:** `nomadScavenger`

---

#### **8. Deep Sea Thermal Vent Field** *(geological, difficulty 3)*

Deep sea background with thermal vents modelled as GravityWell clusters (hot
water column upwellings), Nutrient-rich vent mouths, Drain zones (cold abyssal
floor), and occasional Toxin seeps.

**Background:** `deepSea`
**Layers:**
- `ClusterLayer`: GravityWell, count 5, radiusRange [3, 6], density 0.7 — vent upwellings
- `ClusterLayer`: Nutrient, count 5, radiusRange [2, 4], density 0.8, avoidCenter — vent mouths
- `GradientLayer`: Drain, direction radial-out, minProbability 0.0, maxProbability 0.06 — cold depths at edges
- `ScatteredLayer`: Toxin, density 0.015 — chemosynthetic toxic byproducts
- `ScatteredLayer`: Ice, density 0.008 — cold pockets
**Recommended life:** `extremophile`

---

#### **9. Immune System Battleground** *(biological, difficulty 5)*

Petri background modelling a host immune system.  Antibiotic zones (antibody
patches), Rewinder clusters (immune memory editing), and Colony cells (immune
hubs) create a hostile network that life must outmanoeuvre or overwhelm.
Models bacterial infection dynamics.

**Background:** `petri`
**Layers:**
- `ZoneLayer`: Antibiotic, shape ellipse, count 6, sizeRange [0.06, 0.12], density 0.6, noOverlap — antibody zones
- `ClusterLayer`: Rewinder, count 4, radiusRange [3, 7], density 0.5 — immune memory
- `ClusterLayer`: Colony, count 3, radiusRange [4, 8], density 0.4 — immune hubs
- `ScatteredLayer`: Drain, density 0.02 — immune drainage
- `RingLayer`: Barrier, count 2, spacing 30, thickness 2, completeness 0.75 — containment rings
**Recommended life:** `viralStorm` or `parasitesOverload`

---

#### **10. The Void** *(abstract, difficulty 1)*

Completely empty space — no obstacles, no nutrients, nothing to stop life.
The vacuum scenario.  Demonstrates unconstrained spread.  Useful as a
control condition and for new users.

**Background:** `space`
**Layers:** *(none)*
**Recommended life:** `plague`

---

### 5.2 New File

```
src/simulation/config/EnvironmentPresets.ts
```

Contains the `EnvironmentPreset[]` array exported as `ENVIRONMENT_PRESETS`.

---

## 6. Phase 17e — Preset UI/UX Overhaul

### 6.1 Redesigned Preset Panel

The existing preset selector in `ControlPanel.ts` is replaced with a tabbed
**Preset Panel** containing two tabs:

```
[ Life Presets ] [ Environments ]
```

#### Life Presets Tab

- Cards in a scrollable vertical list.
- Each card shows:
  - **Name** (large, coloured by archetype)
  - **Difficulty dots** (1–5 filled circles)
  - **Archetype badge** (colour-coded: Primitive/Aggressive/Cooperative/Resilient/Chaotic)
  - **One-line description**
  - **[Apply]** button
- Filter chips at the top: `All | Primitive | Aggressive | Cooperative | Resilient | Chaotic`
- Clicking [Apply] updates the config immediately (no simulation restart needed).
- Active preset is highlighted.
- **[Edit in Panel]** opens the full parameter sliders (existing behaviour).

#### Environments Tab

- Same card layout but shows environment cards.
- Each card shows:
  - **Name** + **background type icon**
  - **Difficulty dots**
  - **Category badge**
  - **Description**
  - **Suggested pairing** (name of recommended life preset, clickable)
  - **[Apply Environment]** button
- Clicking [Apply Environment]:
  1. Switches background type.
  2. Sends `applyEnvironment` message to SimulationWorker.
  3. Triggers a Reset + re-seed.
  4. Highlights the suggested life preset.
- A **[Randomize Obstacles]** button at the top of the tab re-generates the current
  environment's obstacle layout with a new random seed.
- A **[Clear Environment]** button removes all obstacle cells (resets to The Void).

### 6.2 UI Components to Add/Modify

| File | Change |
|---|---|
| `src/ui/ControlPanel.ts` | Replace inline preset `<select>` with `PresetPanel` component |
| `src/ui/PresetPanel.ts` | **NEW** — tabbed Life/Environment preset panel component |
| `src/ui/PresetCard.ts` | **NEW** — reusable card Web Component for a single preset |
| `src/ui/EnvironmentCard.ts` | **NEW** — variant card with background preview and apply button |
| `src/app.ts` | Handle `applyEnvironment` EventBus event, route to SimulationWorker |
| `src/workers/workerBridge.ts` | Add `ApplyEnvironmentMsg`, `BackgroundChangeMsg` |
| `src/state/AppState.ts` | Add `activeLifePreset`, `activeEnvironmentPreset` fields |
| `src/state/EventBus.ts` | Add `presetApplied`, `environmentApplied` event types |

### 6.3 CSS Design Tokens

New CSS custom properties for preset card theming:

```css
:root {
  /* Archetype accent colours */
  --archetype-primitive:    #8b5e3c;  /* earth brown */
  --archetype-aggressive:   #cc2233;  /* danger red  */
  --archetype-cooperative:  #2288aa;  /* calm teal   */
  --archetype-resilient:    #22aa66;  /* survivor green */
  --archetype-chaotic:      #9933cc;  /* mutation purple */

  /* Difficulty dot colours */
  --difficulty-filled:  #ffcc00;
  --difficulty-empty:   #444;

  /* Card layout */
  --preset-card-width:  280px;
  --preset-card-gap:    8px;
  --preset-card-radius: 8px;
}
```

---

## 7. Architecture & Data Flow

### 7.1 New Module Dependency Graph

```
ControlPanel.ts
  └─ PresetPanel.ts
       ├─ PresetCard.ts      (life presets)
       └─ EnvironmentCard.ts (environment presets)
            └─ EventBus.emit('environmentApplied', preset)
                  │
                  ▼
              App.ts
                  │
                  ├─ postMessage(ApplyEnvironmentMsg) ──► SimulationWorker.ts
                  │       │
                  │       └─ ObstacleGenerator.generateObstacles()
                  │             ├─ clusterLayer.ts
                  │             ├─ zoneLayer.ts
                  │             ├─ mazeLayer.ts
                  │             ├─ ringLayer.ts
                  │             ├─ gradientLayer.ts
                  │             ├─ riverLayer.ts
                  │             ├─ scatteredLayer.ts
                  │             └─ borderLayer.ts
                  │
                  └─ postMessage(BackgroundChangeMsg) ──► RenderWorker.ts
                          └─ BackgroundManager.setBackground(type)
```

### 7.2 SimulationWorker Handler Addition

```typescript
// Inside SimulationWorker.ts onmessage handler:
case 'applyEnvironment': {
  // 1. Clear non-Life cells from the grid
  clearObstacles(grid);

  // 2. Generate obstacle layout
  const rng = msg.spec.deterministic
    ? mulberry32(presetHash(msg.spec))
    : Math.random;

  generateObstacles(msg.spec, grid.cellType, grid.width, grid.height, rng);

  // 3. Re-seed life at the specified density
  seedLife(grid, msg.seedDensity, config);

  // 4. Notify main thread that environment was applied
  postMessage({ type: 'environmentApplied' });
  break;
}
```

---

## 8. File Manifest

### New Files

| Path | Description |
|---|---|
| `src/simulation/config/EnvironmentPresets.ts` | 10 environment preset definitions |
| `src/simulation/generators/ObstacleGenerator.ts` | Main generator entry point |
| `src/simulation/generators/layers/clusterLayer.ts` | Organic cluster placement |
| `src/simulation/generators/layers/zoneLayer.ts` | Rectangular/elliptical zones |
| `src/simulation/generators/layers/mazeLayer.ts` | Recursive division maze |
| `src/simulation/generators/layers/ringLayer.ts` | Concentric ring placement |
| `src/simulation/generators/layers/gradientLayer.ts` | Probability gradient scatter |
| `src/simulation/generators/layers/riverLayer.ts` | Wandering channel placement |
| `src/simulation/generators/layers/scatteredLayer.ts` | Uniform random scatter |
| `src/simulation/generators/layers/borderLayer.ts` | Edge-band placement |
| `src/simulation/generators/prng.ts` | Mulberry32 seeded PRNG |
| `src/ui/PresetPanel.ts` | Tabbed preset panel Web Component |
| `src/ui/PresetCard.ts` | Life preset card Web Component |
| `src/ui/EnvironmentCard.ts` | Environment preset card Web Component |

### Modified Files

| Path | Change |
|---|---|
| `src/simulation/config/SimulationConfig.ts` | Add `PresetMeta`, `LifePreset` types; add 10 new life presets; fully-specify 9 existing presets |
| `src/workers/workerBridge.ts` | Add `ApplyEnvironmentMsg`, `EnvironmentAppliedMsg`, `BackgroundChangeMsg` |
| `src/simulation/SimulationWorker.ts` | Handle `applyEnvironment` message |
| `src/ui/ControlPanel.ts` | Replace inline preset selector with `PresetPanel` |
| `src/app.ts` | Route `environmentApplied` EventBus event to workers |
| `src/state/AppState.ts` | Add `activeLifePreset`, `activeEnvironmentPreset` fields |
| `src/state/EventBus.ts` | Add `presetApplied`, `environmentApplied` events |
| `dist/index.html` | No direct changes (generated by Vite) |

---

## 9. Implementation Order

### Phase 17a — Life Presets (est. 3–4 hours)

1. Add `PresetMeta` and `LifePreset` types to `SimulationConfig.ts`.
2. Write 10 new life preset functions with all 41 parameters.
3. Update 9 existing presets to fully-specify all fields.
4. Unit test: verify each preset produces a valid `SimulationConfig`
   (all fields present, all values within declared ranges).

### Phase 17b — Obstacle Spec Types (est. 1 hour)

1. Create `ObstacleSpec` and all `ObstacleLayer` types in a new
   `src/simulation/generators/types.ts`.
2. Create `EnvironmentPreset` interface.
3. No runtime code yet — just types.

### Phase 17c — Generator Implementation (est. 4–6 hours)

1. Implement `prng.ts` (mulberry32).
2. Implement each layer module in order (simplest first):
   - `scatteredLayer.ts`  ← trivially testable, good foundation
   - `borderLayer.ts`
   - `zoneLayer.ts`
   - `clusterLayer.ts`
   - `gradientLayer.ts`
   - `ringLayer.ts`
   - `riverLayer.ts`
   - `mazeLayer.ts`       ← most complex algorithm; implement last
3. Implement `ObstacleGenerator.ts` entry point that dispatches layers.
4. Unit tests for each layer (cell count within expected density range,
   no out-of-bounds writes, correct cell types written).

### Phase 17d — Environment Preset Definitions (est. 2 hours)

1. Create `EnvironmentPresets.ts` with all 10 preset objects.
2. Integration test: run each preset through `generateObstacles()` on
   a 256×256 grid, verify expected cell type distributions.

### Phase 17e — Worker Integration (est. 2 hours)

1. Add `ApplyEnvironmentMsg` to `workerBridge.ts`.
2. Handle it in `SimulationWorker.ts`.
3. Add `clearObstacles()` helper to `GridState.ts`.
4. Manual test: apply each environment preset via the browser console,
   verify grid populates correctly.

### Phase 17f — UI (est. 4–5 hours)

1. Implement `PresetCard.ts` Web Component.
2. Implement `EnvironmentCard.ts` Web Component.
3. Implement `PresetPanel.ts` tabbed panel.
4. Integrate into `ControlPanel.ts`.
5. Wire EventBus events in `App.ts`.
6. Visual test: all 10 life presets and 10 environment presets display
   correctly in the panel, apply correctly, and update the simulation.
7. Style: apply CSS design tokens for archetype colour coding.

---

## 10. Testing Strategy

### Unit Tests (Vitest)

New test files:

| File | Tests |
|---|---|
| `src/simulation/generators/layers/scatteredLayer.test.ts` | Density within ±2%, no out-of-bounds |
| `src/simulation/generators/layers/clusterLayer.test.ts` | Count correct, avoidCenter respected |
| `src/simulation/generators/layers/mazeLayer.test.ts` | No isolated cells, corridor width respected |
| `src/simulation/generators/layers/ringLayer.test.ts` | Ring count correct, completeness respected |
| `src/simulation/generators/layers/riverLayer.test.ts` | River traverses full axis, width within range |
| `src/simulation/generators/layers/gradientLayer.test.ts` | Low-prob end has fewer cells than high-prob end |
| `src/simulation/generators/ObstacleGenerator.test.ts` | Full spec applied correctly, layer order respected |
| `src/simulation/config/SimulationConfig.test.ts` | All new presets have all 41 fields; values in range |
| `src/simulation/config/EnvironmentPresets.test.ts` | All env presets have valid backgroundType, valid layerTypes |

### Expected Test Count

Phase 17 adds approximately 70–90 new tests.

**Current count (Phase 16d):** 512 tests
**Target after Phase 17:** ~585–600 tests

### Manual QA Checklist

- [ ] All 10 new life presets apply without errors and produce visibly different behaviours
- [ ] All 9 refactored existing presets produce identical simulation behaviour to before
- [ ] All 10 environment presets generate without errors on 64, 256, 512 grid sizes
- [ ] Maze generator handles grid sizes that aren't powers of 2
- [ ] [Randomize Obstacles] button generates a different layout each time
- [ ] [Clear Environment] removes all obstacle cells and leaves Life + Empty only
- [ ] Suggested life preset link in EnvironmentCard applies the correct preset
- [ ] Applying an environment preset does not crash a running simulation
- [ ] Applying an environment preset mid-run pauses, applies, then restores run state
- [ ] Preset panel filter chips correctly filter by archetype
- [ ] Preset cards are readable on screens ≤ 1366px wide (laptop viewport)

---

## Appendix A — Parameter Quick Reference

Full list of the 41 `SimulationConfig` parameters and their valid ranges,
for use when writing new life presets:

| Parameter | Range | Default |
|---|---|---|
| `spreadRate` | [0, 1] | 0.45 |
| `energyDecayRate` | [0, 0.1] | 0.005 |
| `reproductionThreshold` | [0, 1] | 0.1 |
| `initialEnergy` | [0, 1] | 0.9 |
| `mutationRate` | [0, 0.1] | 0.0 |
| `pointMutationRate` | [0, 0.05] | 0.005 |
| `juvenileThreshold` | [0, 200] | 30 |
| `senescentThreshold` | [100, 3000] | 400 |
| `apoptosisBoost` | [0, 0.1] | 0.02 |
| `neighbourhoodMode` | moore/vonNeumann | moore |
| `overpopulationLimit` | [0, 8] | 8 |
| `underpopulationLimit` | [0, 8] | 0 |
| `variantSpreadRate` | [0, 1] | 0.6 |
| `variantEnergyDecayRate` | [0, 0.1] | 0.008 |
| `variantReproductionThreshold` | [0, 1] | 0.1 |
| `variantInitialEnergy` | [0, 1] | 0.8 |
| `competitionStrength` | [0, 1] | 0.3 |
| `toxinResistance` | [0, 1] | 0.0 |
| `nutrientAbsorption` | [0, 1] | 1.0 |
| `gravityResponse` | [0, 1] | 1.0 |
| `toxinStrength` | [0, 0.2] | 0.05 |
| `toxinDurability` | [1, 50] | 10 |
| `nutrientBoost` | [0, 0.1] | 0.02 |
| `nutrientDecayRate` | [0, 0.01] | 0.001 |
| `barrierLifetime` | [10, 1000] | 200 |
| `gravityStrength` | [0, 1] | 0.5 |
| `drainRate` | [0, 0.05] | 0.01 |
| `fireBurnRate` | [0.001, 0.05] | 0.005 |
| `censusInterval` | [1, 50] | 10 |
| `mutagenBoost` | [1, 10] | 3.0 |
| `mutagenDecayRate` | [0, 0.01] | 0.002 |
| `radioWasteDamage` | [0, 0.05] | 0.008 |
| `antibioticStrength` | [0, 1] | 0.12 |
| `antibioticDecayRate` | [0, 0.01] | 0.001 |
| `rewinderStrength` | [0, 1] | 0.05 |
| `colonyBoost` | [0, 0.05] | 0.012 |
| `adaptiveMutationBias` | boolean | false |
| `chemotaxisWeight` | [0, 1] | 0.3 |
| `signalDiffusion` | [0, 1] | 0.85 |
| `quorumThreshold` | [1, 8] | 4 |
| `adaptiveInheritanceRate` | [0, 1] | 0.3 |

---

## Appendix B — Recommended Pairings

A 10×10 suggested pairing matrix for biologically interesting combinations:

| Life \ Environment | Pristine Petri | Coral Reef | Forest Floor | Volcanic Badlands | Antibiotic Gauntlet | Radioactive Wastes | Labyrinth | Deep Sea Vents | Immune Battleground | The Void |
|---|---|---|---|---|---|---|---|---|---|---|
| Ancient Prokaryote | ★★★ | ★★ | ★★★ | ★ | ★★ | ★ | ★★ | ★★ | ★ | ★★★★ |
| Viral Storm | ★★ | ★★ | ★★ | ★★ | ★★★ | ★★ | ★★ | ★★ | ★★★★ | ★★★★★ |
| Biofilm Architect | ★★★ | ★★★★★ | ★★★★ | ★★ | ★★★ | ★★ | ★★★ | ★★★★ | ★★★ | ★★ |
| Evolutionary Sprinter | ★★ | ★★ | ★★★ | ★★★ | ★★★★★ | ★★★★ | ★★★ | ★★★ | ★★★★ | ★★ |
| Extremophile | ★ | ★★★ | ★★ | ★★★★★ | ★★ | ★★★★★ | ★★ | ★★★★★ | ★★★ | ★ |
| Territorial Conquistador | ★★★ | ★★★ | ★★★ | ★★ | ★★★ | ★★ | ★★★★ | ★★★ | ★★★ | ★★★★★ |
| Nomadic Scavenger | ★★ | ★★★★ | ★★★ | ★★★ | ★★ | ★★ | ★★★★★ | ★★★★ | ★★ | ★★★ |
| Jurassic Megaflora | ★★★ | ★★ | ★★★★★ | ★ | ★ | ★ | ★★★ | ★★ | ★ | ★★★ |
| Parasitic Overload | ★★★ | ★★★ | ★★ | ★★ | ★★★ | ★★ | ★★★ | ★★★ | ★★★★★ | ★★★★ |
| Neural Network Colony | ★★★ | ★★★★ | ★★★★ | ★★ | ★★★ | ★★ | ★★★★ | ★★★★ | ★★★ | ★★★ |

★★★★★ = particularly compelling combination
