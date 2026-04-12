# What Simulator — Round 2 Implementation Plan

## Overview

Round 2 dramatically expands the biological realism of the simulation.  Where
Round 1 built a polished cellular automaton with obstacles, two life variants,
and a WebGL renderer, Round 2 reimagines the **life itself** — replacing the
simple Life/LifeVariant binary with a full genome-driven evolution engine,
lifecycle stages, multi-species competition, emergent colony behaviours, and a
live data-visualization layer that tells the story of evolution as it unfolds.

The core engineering mandate from `feature.md`:

> *"Dramatically increase the number of attributes we track per cell so we can
> take advantage of more options for the cells.  Mutations tend to happen all
> the time.  Life gets a little smarter or more capable over time."*

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [New Cell Schema — Expanded Genome Buffers](#2-new-cell-schema--expanded-genome-buffers)
3. [Genome System Design](#3-genome-system-design)
4. [Mutation Engine](#4-mutation-engine)
5. [Lifecycle Stages and Senescence](#5-lifecycle-stages-and-senescence)
6. [Multi-Species Competition](#6-multi-species-competition)
7. [Emergent Colony Behaviours](#7-emergent-colony-behaviours)
8. [Population Genetics Engine](#8-population-genetics-engine)
9. [Evolution Visualization Layer](#9-evolution-visualization-layer)
10. [New Obstacle Types for Round 2](#10-new-obstacle-types-for-round-2)
11. [Updated Architecture](#11-updated-architecture)
12. [Implementation Phases](#12-implementation-phases)
13. [Performance Budget](#13-performance-budget)
14. [Configuration and Presets](#14-configuration-and-presets)

---

## 1. Current State Audit

### What exists after Round 1 (Phases 1–7)

**Cell schema (4 parallel TypedArrays, `Structure-of-Arrays`):**

| Buffer | Type | Size @ 512×512 | Contents |
|---|---|---|---|
| `cellType` | `Uint8Array` | 256 KB | 11 cell types (Empty, Life, LifeVariant, Wall, Toxin, Nutrient, Drain, GravityWell, Barrier, Fire, Ice) |
| `energy` | `Float32Array` | 1 MB × 2 (double-buffered) | Vitality for Life; fuel for Fire; potency for Nutrient; fade for Barrier |
| `age` | `Uint16Array` | 512 KB | Ticks since cell became its current type |
| `flags` | `Uint8Array` | 256 KB | Bitmask: MUTATED, DORMANT, MARKED_FOR_DEATH |

**Variants:** exactly 2 — Life (variant A, green) and LifeVariant (variant B, yellow).
Mutation rate is a global slider. When A mutates, it always becomes B with a fixed
set of config-level parameters.

**What is missing for biological realism:**

- No per-cell heritable traits — all cells of the same type behave identically.
- No genome — mutation produces one fixed variant, not diversification.
- No lifecycle stages — cells never mature, age, or senesce.
- No selective pressure beyond energy starvation — no adaptive fitness.
- No colony intelligence — cells are fully independent agents.
- No population history or phylogenetics.
- No chemotaxis (directed movement toward resources).

---

## 2. New Cell Schema — Expanded Genome Buffers

Round 2 expands the per-cell record from 4 buffers to **12 buffers**.  All
buffers continue to use the `Structure-of-Arrays` layout for cache efficiency.

### Complete Buffer Table

| Buffer | Type | Per-cell bytes | Contents |
|---|---|---|---|
| `cellType` | `Uint8Array` | 1 | Cell type enum (unchanged, values extended) |
| `energy` | `Float32Array` | 4 | Vitality / fuel / potency (unchanged) |
| `age` | `Uint16Array` | 2 | Ticks in current cell type (unchanged) |
| `flags` | `Uint8Array` | 1 | Bitmask: MUTATED, DORMANT, SENESCENT, JUVENILE, SIGNALING |
| **NEW** `genome` | `Uint16Array` | 2 | 16-bit encoded heritable trait genome |
| **NEW** `variantId` | `Uint8Array` | 1 | Which variant lineage (0–255) |
| **NEW** `generation` | `Uint16Array` | 2 | Reproductive generations from first seed |
| **NEW** `toxinResist` | `Float32Array` | 4 | Per-cell evolved toxin resistance [0, 1] |
| **NEW** `nutrientAbs` | `Float32Array` | 4 | Per-cell evolved nutrient absorption [0, 1] |
| **NEW** `heatResist` | `Float32Array` | 4 | Per-cell evolved fire/heat resistance [0, 1] |
| **NEW** `spreadBonus` | `Float32Array` | 4 | Per-cell evolved spread rate modifier [-0.5, +0.5] |
| **NEW** `signalStrength` | `Float32Array` | 4 | Chemical signal emitted (quorum sensing) |

### Memory Budget

At 512×512 (262,144 cells), double-buffered where needed:

| Buffer | Raw size | Notes |
|---|---|---|
| cellType | 256 KB | Single-buffered OK |
| energy × 2 | 2 MB | Double-buffered |
| age | 512 KB | Single-buffered |
| flags | 256 KB | Single-buffered |
| genome | 512 KB | Single-buffered |
| variantId | 256 KB | Single-buffered |
| generation | 512 KB | Single-buffered |
| toxinResist × 2 | 2 MB | Double-buffered (heritable, can spread) |
| nutrientAbs × 2 | 2 MB | Double-buffered |
| heatResist × 2 | 2 MB | Double-buffered |
| spreadBonus × 2 | 2 MB | Double-buffered |
| signalStrength × 2 | 2 MB | Double-buffered |
| **Total** | **~16.3 MB** | Well within browser constraints |

### Updated `GridBuffers` Interface

```typescript
export interface GridBuffers {
  // --- Round 1 fields (unchanged) ---
  readonly cellType:     Uint8Array;
  readonly energy:       Float32Array;
  readonly age:          Uint16Array;
  readonly flags:        Uint8Array;

  // --- Round 2 genome fields ---
  /** 16-bit encoded genome. Bits 0–3: spreadTier, 4–7: decayTier,
   *  8–11: toxinTier, 12–15: nutrientTier. */
  readonly genome:       Uint16Array;

  /** Variant lineage identifier (0 = base Life, 1–255 = evolved lineages). */
  readonly variantId:    Uint8Array;

  /** Reproductive generation count (how many parent→child spreads from seed). */
  readonly generation:   Uint16Array;

  /** Evolved per-cell toxin damage resistance [0, 1]. */
  readonly toxinResist:  Float32Array;

  /** Evolved per-cell nutrient absorption efficiency [0, 1]. */
  readonly nutrientAbs:  Float32Array;

  /** Evolved per-cell fire/heat resistance [0, 1] — reduces instant-kill chance. */
  readonly heatResist:   Float32Array;

  /** Evolved spread rate delta [-0.5, +0.5] added to base spreadRate. */
  readonly spreadBonus:  Float32Array;

  /** Signal chemical concentration emitted by this cell [0, 1]. */
  readonly signalStrength: Float32Array;
}
```

### Updated Cell Flags

```typescript
export const CellFlags = {
  MUTATED:          0b0000_0001,  // (unchanged) underwent ≥1 mutation
  DORMANT:          0b0000_0010,  // (unchanged) frozen by Ice
  MARKED_FOR_DEATH: 0b0000_0100,  // (unchanged) scheduled to die this tick
  JUVENILE:         0b0000_1000,  // NEW: in juvenile lifecycle stage (age < juvenileThreshold)
  SENESCENT:        0b0001_0000,  // NEW: in senescent lifecycle stage (age > senescentThreshold)
  SIGNALING:        0b0010_0000,  // NEW: emitting a quorum signal this tick
  ADAPTED:          0b0100_0000,  // NEW: has survived at least one obstacle stress event
} as const;
```

---

## 3. Genome System Design

### Design Philosophy

The genome is a **16-bit integer** stored in `genome: Uint16Array`.  Each group
of 4 bits (a "nibble") encodes a **tier** for one heritable trait.  16 tier
steps per trait gives 65,536 unique genome combinations — enough diversity for
visible evolutionary dynamics without per-cell float overhead.

### Genome Bit Layout

```
Bits 15–12  Bits 11–8   Bits 7–4    Bits 3–0
[nutrient]  [toxin]     [decay]     [spread]
  tier        tier        tier        tier
  0–15        0–15        0–15        0–15
```

### Trait → Phenotype Mapping

Each tier maps to a floating-point phenotype value via a lookup table
(`GENOME_LUT: Float32Array[4 * 16]`) computed once at startup.  This turns
genome reads into a single array lookup per trait rather than a formula.

| Trait | Tier 0 (min) | Tier 7 (mid) | Tier 15 (max) |
|---|---|---|---|
| `spreadBonus` | −0.30 | 0.00 | +0.40 |
| `decayModifier` | +0.008 | 0.000 | −0.003 (slower decay) |
| `toxinResist` | 0.00 | 0.40 | 0.90 |
| `nutrientAbs` | 0.20 | 0.60 | 1.00 |

**Key design decisions:**

- Spread tier 7 = neutral (no bonus/penalty) — base config value unchanged.
- Decay tier 15 = slowest decay — survival advantage in low-nutrient zones.
- Toxin tier 0 = no resistance — dies fast in toxin regions, natural selection.
- Nutrient tier 15 = maximum absorption — thrives near nutrient cells.

### Variant Identity

`variantId: Uint8Array` tracks **lineage** — which branching event created this
cell's genome.  Two cells can share the same `variantId` but have slightly
different genomes due to point mutations.  `variantId` changes only when a
**significant mutation** occurs (more than 2 bits differ from the parent's
genome).

This lets the renderer color-code up to 256 distinct lineages while grouping
near-identical genomes into the same color class.

---

## 4. Mutation Engine

### Mutation Model

Round 2 replaces the binary "Life mutates to LifeVariant at rate X" system with
a **continuous per-bit mutation model** with four distinct mutation triggers.

#### 4.1 Spontaneous Point Mutation (background)

Every reproduction event (spread) has a configurable probability
`pointMutationRate` (default 0.002) that **one random bit** in the child's
genome is flipped.

```
For each bit flip:
  bitPosition = floor(random() * 16)
  childGenome ^= (1 << bitPosition)
```

Small effect per event, large cumulative effect over thousands of generations.
This simulates cosmic-ray-style random mutation.

#### 4.2 Stress-Induced Hypermutation

When a cell survives a damaging event (toxin exposure, fire proximity without
death, drain energy drain below 0.2) its **local mutation rate triples** for
the next 50 ticks.  This implements the biological SOS response: stressed DNA
becomes less stable, increasing variation.

```
On stress event:
  cell.flags |= ADAPTED
  cell.stressMutationTimer = 50   // new Uint8Array field
```

During a tick where `stressMutationTimer > 0`, apply 3 random bit flips instead
of 1 during spread.

#### 4.3 Environmental Drift

A new environment concept: **Mutagen Zones**.  These are regions of the grid
(painted via the drawing tool as a new cell type `Mutagen`) where any Life cell
passing through has its genome mutated at 10× the base rate.  Useful for
creating evolutionary pressure hotspots — the area around a mutagen zone will
produce highly diverse variants over time.

#### 4.4 Beneficial Mutation Bias

By default, all 16 genome bits have equal flip probability.  A new config
toggle `adaptiveMutationBias` (default: off) applies **Lamarckian-lite**
selection: when a bit flip would produce a phenotype that is *more suited* to
the current cell's local environment (e.g., higher toxinResist if adjacent to
Toxin), that flip is 3× more likely.  This is a simplification of the
biological concept of directed mutagenesis and makes evolution far more visible
on short timescales.

#### 4.5 Genome Inheritance

When Life cell A spreads into cell B:
1. Child B's genome = A's genome (exact copy).
2. Apply point mutation with probability `pointMutationRate`.
3. Derive child's phenotype from child's genome.
4. Child's `variantId` = A's `variantId` unless ≥3 bits changed → new `variantId`.
5. Child's `generation` = A's generation + 1.

```typescript
// Pseudocode — no heap allocations
function computeChildGenome(parentGenome: number, mutRate: number): number {
  let g = parentGenome;
  if (Math.random() < mutRate) {
    const bit = (Math.random() * 16) | 0;
    g ^= (1 << bit);
  }
  return g & 0xFFFF;
}
```

---

## 5. Lifecycle Stages and Senescence

Life cells now age through **three distinct biological stages** determined by
the `age` field.  Stage thresholds are configurable and heritable (see genome
extension note below).

### Stage Definitions

| Stage | Age Range (default) | Behaviour Modifiers |
|---|---|---|
| Juvenile | age < 30 | spreadBonus × 0.4, energyDecayRate × 0.8, cannot mutate |
| Mature | 30 ≤ age ≤ 400 | full phenotype, normal mutation |
| Senescent | age > 400 | spreadBonus × 0.1, energyDecayRate × 1.5, mutation rate × 2 (last-ditch diversity burst) |

### Lifecycle Flags

The JUVENILE and SENESCENT bits in `flags` mark the current stage so the
renderer can apply distinct visual styles per stage without re-computing
thresholds in the render path.

### Senescence and Apoptosis

When a senescent cell reaches energy ≤ 0.05 it undergoes **apoptosis** (planned
death):

1. The cell releases its accumulated signal (signalStrength → 1.0 for 1 tick).
2. Adjacent cells receive a small energy boost (`apoptosisBoost` config param).
3. The cell dies and becomes Empty — its death *feeds* its neighbours.

This creates realistic population density oscillation: old dense colonies die
off and refeed the environment, allowing younger cells to expand into the
cleared space.

### Longevity as Heritable Trait

The senescence threshold can optionally be encoded in the genome: a new 4-bit
longevity nibble (expanding genome to 20 bits, stored as Uint32Array with upper
12 bits unused) maps tier 0 → 200 ticks lifespan, tier 15 → 800 ticks lifespan.

This allows natural selection to optimise for lifespan in stable environments
and short lifespan (fast turnover) in volatile ones.

---

## 6. Multi-Species Competition

### From 2 to 256 Variants

Round 1 has exactly 2 life types hardcoded into `CellType` enum.  Round 2
replaces this with a **single `CellType.Life` value plus a `variantId`
field** to track up to 256 distinct lineages.

The renderer maps `variantId` to colour using a pre-computed palette:
`VARIANT_PALETTE: Uint32Array[256]` — 256 RGBA entries generated via the
golden-angle hue distribution so adjacent variant IDs have maximally distinct
colours.

### Variant Competition Rules

When LifeVariant species A (variantId = X) spreads into a cell occupied by
species B (variantId = Y):

1. Compute **fitness delta**: A's phenotype advantage over B in the local
   environment (toxin resistance difference if adjacent to toxin, etc.).
2. Competition probability = `competitionStrength * (1 + fitnessDelta * 0.5)`.
   Positive fitnessDelta → A is more likely to win.  Negative → A loses.
3. If competition succeeds, B is replaced by A.

This creates **competitive exclusion** in uniform environments (one winner) and
**coexistence** in heterogeneous environments (each species dominates its
preferred niche).

### Kin Selection

Cells sharing the same `variantId` do **not** compete with each other — they
treat same-lineage cells as non-targets even when touching.  Cells with
`variantId` within ±5 of each other apply only 50% competition strength
(near-kin cooperation).  Cells with `variantId` differing by > 20 apply 150%
competition strength (stranger aggression).

This implements Hamilton's rule in a simplified form and produces visible
territorial boundaries between distantly related lineages.

### Extinction Tracking

A `VariantRegistry` (main-thread data structure, not in hot loop) tracks all
variant IDs that have ever existed, their peak population, and their
extinction tick.  This feeds the Phylogenetics panel in the UI.

```typescript
interface VariantRecord {
  id: number;
  firstSeenTick: number;
  peakPopulation: number;
  extinctionTick: number | null;
  parentVariantId: number;
  genomeSample: number;   // genome of first cell of this variant
}
```

---

## 7. Emergent Colony Behaviours

### 7.1 Quorum Sensing

Quorum sensing is a biological mechanism where cells alter behaviour based on
local population density.  In Round 2, each Life cell counts same-variant
neighbours and enters one of two modes:

**Pioneer mode** (< 2 same-variant neighbours):
- Spread rate × 1.4 (aggressive expansion)
- Energy decay × 1.1 (extra metabolic cost of pioneering)
- High `signalStrength` emission (calling others)

**Colony mode** (≥ 4 same-variant neighbours):
- Spread rate × 0.7 (conserving energy, defending territory)
- Energy decay × 0.8 (collective metabolic efficiency)
- Low `signalStrength` emission (colony is established)

The SIGNALING flag is set on Pioneer-mode cells so the renderer can distinguish
them visually.

### 7.2 Chemotaxis — Nutrient Gradient Following

The `signalStrength` buffer doubles as a nutrient signal diffusion field.
Each Nutrient cell emits signal = 1.0 per tick.  Each Empty cell diffuses signal
from adjacent cells at rate `signalDiffusion` (default 0.85 per step per tick).

Life cells with high `nutrientAbs` phenotype (evolved) sense this gradient:
when choosing which neighbour to spread into, they add a `chemotaxisWeight ×
signalStrength[ni]` bonus to the candidate target's spread probability.

The result: evolved populations learn to "smell" nutrients and expand toward
them directionally rather than spreading uniformly.

### 7.3 Adaptive Immunity — Memory of Past Stress

When a Life cell survives toxin exposure (energy dropped below 0.15 due to
toxin damage but cell survived), its `toxinResist` field is permanently
boosted by 0.05 (up to the genome-encoded cap).  This cell then passes the
elevated `toxinResist` to offspring via the genome encoding:

1. Cell survives toxin → `toxinResist` boosted → `ADAPTED` flag set.
2. On next reproduction, the child's genome `toxinTier` nibble increments by 1
   with probability 0.3 (`adaptiveInheritanceRate`).
3. Over generations, the local population around toxin sources evolves toxin
   resistance without global config changes.

This implements a simplified Lamarckian-lite inheritance for the most visible
and testable case (toxin resistance) as a model for the pattern.

### 7.4 Niche Specialisation

Different genome combinations naturally "prefer" different environments:

- **High toxinTier + low spreadTier**: Survives in toxin zones by trading
  expansion speed for resilience.  Appears as dark, dense colonies around toxin.
- **High spreadTier + low nutrientTier**: Fast-spreading but fragile; floods
  empty space but collapses in hostile regions.
- **High nutrientTier + medium spreadTier**: Thrives near nutrients; produces
  green "oases" of dense stable colonies.
- **High decayTier (lowest decay rate)**: Long-lived generalist; slowly
  outcompetes specialists in mixed environments over hundreds of ticks.

These niches emerge from the physics of the simulation — they are not hard-coded
behaviours but consequences of the selection pressure.

---

## 8. Population Genetics Engine

A new module `src/simulation/genetics/PopulationGenetics.ts` runs on the main
thread (not in the hot loop) and analyses the live variant distribution.

### Variant Census

Every N ticks (configurable; default 10), the SimulationWorker sends a compact
census snapshot to the main thread:

```typescript
interface VariantCensus {
  tick: number;
  // Parallel arrays (index = variantId):
  counts:    Uint32Array;   // population per variant
  meanGenome: Uint16Array;  // modal genome per variant
  meanAge:   Float32Array;  // mean cell age per variant
  meanGen:   Float32Array;  // mean generation depth per variant
}
```

This is a 256 × (4 + 2 + 4 + 4) = ~3.5 KB message per census — negligible
overhead.

### Diversity Metrics

The genetics module computes the following in the main thread after each census:

| Metric | Formula | What it shows |
|---|---|---|
| Shannon diversity index | −Σ pᵢ log(pᵢ) | Species richness and evenness |
| Dominant variant % | max(counts) / totalCells | How monopolised the ecosystem is |
| Mean generation depth | Σ meanGen[i] × counts[i] / total | How many reproductive cycles have occurred |
| Turnover rate | |newExtinctions + newVariants| / N | Evolutionary speed |
| Genome entropy | Shannon of bit-frequency across all genomes | Genetic diversity within population |

These drive the real-time charts described in Section 9.

### Fisher-Wright Drift Simulation (Optional Overlay)

An optional "predicted drift" line on the population chart shows what
**random genetic drift** (Fisher-Wright model) would predict for the current
population size and variant count — allowing the user to visually compare actual
selection-driven evolution against neutral drift.

The Fisher-Wright expectation for extinction time of a variant at frequency p
in population N is: T ≈ −4N × p × ln(p) ticks.

---

## 9. Evolution Visualization Layer

### 9.1 New Canvas Overlays

Three new overlay panels are added alongside the existing simulation canvas:

#### Population Timeline Chart

A 400×150px canvas below the main simulation (or in a collapsible panel)
renders a real-time **stacked area chart** of variant populations over time.

- X axis: tick number (rolling window of last 1000 ticks)
- Y axis: % of total live cells
- Each band = one active variant, coloured by `VARIANT_PALETTE`
- Bands restack dynamically as variants appear and go extinct

**Implementation:** `src/rendering/PopulationChart.ts`
- Maintains a circular buffer of `VariantCensus` snapshots (1000 entries)
- Renders using Canvas 2D path fills (not WebGL — chart is small)
- Updates only when a new census arrives, not every frame

#### Genome Heatmap

A small 32×8 canvas shows a heatmap of **genome bit frequencies** across the
entire living population:

- 32 columns = 32 possible genome bit positions (if genome expands to 32-bit) or 16 columns for 16-bit
- 8 rows = 8 most populous variants
- Cell colour: red = bit mostly 1, blue = bit mostly 0, white = mixed (50/50)

This reveals which genome positions have been strongly selected (monomorphic =
under selection) versus neutral (polymorphic = drifting).

**Implementation:** `src/rendering/GenomeHeatmap.ts`

#### Phylogenetic Tree

A SVG-rendered mini-tree (or Canvas 2D) in the control panel shows variant
lineage:

- Root = variant 0 (base Life seed)
- Each branch = a new `variantId` created by significant mutation
- Branch width = peak population of that variant
- Extinct variants shown in grey; living variants in their VARIANT_PALETTE colour
- Clicking a node highlights all cells of that variant on the main canvas

**Implementation:** `src/rendering/PhylogeneticTree.ts`
- Uses a simple Reingold-Tilford tree layout algorithm
- Updates only on variant creation or extinction events
- Rendered to an offscreen canvas, blitted into a `<canvas>` in the side panel

### 9.2 Enhanced Cell Colour Mapping

The main simulation canvas (both Canvas 2D and WebGL renderers) gets new
colour-mapping modes:

| Render Mode | Colour encodes |
|---|---|
| `variantId` (default) | Hue from VARIANT_PALETTE, brightness from energy |
| `genome` | Hue from spread tier, saturation from toxin tier |
| `lifecycle` | Green = juvenile, bright = mature, purple = senescent |
| `generation` | Heat ramp from cool (generation 0) to hot (deep ancestry) |
| `fitness` | A computed local fitness score: higher = brighter |
| `signal` | Cyan glow intensity = signalStrength (shows chemotaxis field) |

A new "Render Mode" dropdown is added to the Control Panel's Viewport section.

### 9.3 WebGL Shader Extension

The WebGL renderer's fragment shader is updated to support the new render modes.
New uniforms:

```glsl
uniform sampler2D u_variantId;    // Uint8 texture
uniform sampler2D u_genome;       // Uint16 packed as RG bytes
uniform sampler2D u_lifecycle;    // flags texture
uniform sampler2D u_signalStrength; // Float32 → R channel

uniform int u_renderMode;         // 0=variant, 1=genome, 2=lifecycle, etc.
uniform sampler2D u_variantPalette; // 256×1 RGBA lookup
```

The fragment shader samples the appropriate texture based on `u_renderMode` and
maps to the correct colour.

---

## 10. New Obstacle Types for Round 2

Building on the Phase 5 obstacle catalog, Round 2 adds five new environment
cell types to create richer selection pressures.

### New CellType Values

```typescript
export const enum CellType {
  // --- Round 1 (0–10 unchanged) ---
  Empty       = 0,
  Life        = 1,
  Wall        = 2,
  Toxin       = 3,
  Nutrient    = 4,
  Drain       = 5,
  GravityWell = 6,
  Barrier     = 7,
  Fire        = 8,
  Ice         = 9,
  LifeVariant = 10,  // DEPRECATED — kept for save-file compatibility

  // --- Round 2 additions ---
  Mutagen     = 11,  // Dramatically increases mutation rate for Life cells within range
  RadioWaste  = 12,  // Damages Life each tick AND triggers hypermutation; not consumed
  Antibiotic  = 13,  // Kills Life with low toxinResist; Life with high resistance survives
  Rewinder    = 14,  // Reverts Life cells in range to genome tier 7 (neutral) — "resets evolution"
  Colony      = 15,  // Cooperative cell: boosts energy of all same-variantId neighbours
}
```

### Mutagen (CellType 11)

- **Visual:** Pulsing magenta with particle-like noise pixels
- **Effect:** Life cells within range 3 (not just adjacent) have `pointMutationRate × 10`
- **Interaction with spread:** Life CAN spread through Mutagen; each spread event applies 3 bit-flips
- **Decay:** Depletes by `mutageDecayRate` per tick; becomes Empty when exhausted
- **Strategic use:** Creates evolutionary hotspots — populations near mutagen diversify rapidly

### RadioWaste (CellType 12)

- **Visual:** Green-yellow radioactive glow (animated halo)
- **Effect:** −`radioStrength` energy per tick to adjacent Life; also applies 2 random genome bit-flips to survivors
- **Persistence:** Permanent; never decays (unlike Toxin)
- **Challenge:** Forces selection for both `toxinResist` AND the "right" genome via
  radiation damage — a dual selection pressure

### Antibiotic (CellType 13)

- **Visual:** White crystalline patches
- **Effect:** Each tick, adjacent Life cells roll a survival check: `Math.random() < cell.toxinResist` → survive; else die
- **Selective pressure:** This is pure antibiotic resistance selection — cells with high `toxinTier` survive, others die
- **Spread blocking:** Life CAN spread into Antibiotic cells if it has `toxinResist > 0.5`; otherwise blocked
- **Evolution story:** Paint an antibiotic belt across the canvas; watch the population on the other side evolve resistance over ~200 ticks

### Rewinder (CellType 14)

- **Visual:** Blue-silver clockwise spiral animation
- **Effect:** Life cells adjacent to Rewinder have their genome nibbles shifted toward tier 7 (neutral) by 1 per tick; simulates "selection removal"
- **Usage:** Reveals what happens when selection is relaxed — genetic drift and diversity increase, fitness decreases
- **Interaction:** Rewinder never damages energy; only modifies genome

### Colony Cell (CellType 15)

- **Visual:** Warm amber grid (like a honeycomb pattern)
- **Effect:** Life cells of the same `variantId` adjacent to Colony receive +`colonyBoost` energy per tick; other variants receive no benefit
- **Colony decay:** Colony cells slowly deplete; are replenished by adjacent Life cells sacrificing 0.01 energy per tick (simulating building infrastructure)
- **Emergent use:** Variants that settle near Colony cells gain a permanent energy advantage; selects for colonial species

---

## 11. Updated Architecture

### New File Structure

```
src/
  simulation/
    GridState.ts              (MODIFIED — 12-buffer schema)
    SimulationEngine.ts       (MODIFIED — lifecycle, stress mutation, quorum)
    SimulationWorker.ts       (MODIFIED — census broadcast)
    genetics/
      GenomeEncoder.ts        NEW — bit-pack/unpack genome; GENOME_LUT
      MutationEngine.ts       NEW — point mutation, stress mutation, adaptive bias
      VariantRegistry.ts      NEW — variant lineage tracking; extinction events
      PopulationGenetics.ts   NEW — Shannon index, turnover, Fisher-Wright drift
    rules/
      lifeRules.ts            (MODIFIED — lifecycle stages, per-cell phenotype)
      obstacleRules.ts        (MODIFIED — Round 2 obstacle types)
      environmentRules.ts     (MODIFIED — chemotaxis signal diffusion)
      colonyRules.ts          NEW — quorum sensing, kin selection, Colony cell

  rendering/
    Renderer.ts               (MODIFIED — new render modes)
    ColorMap.ts               (MODIFIED — VARIANT_PALETTE, lifecycle colours)
    WebGLRenderer.ts          (MODIFIED — new textures and shader uniforms)
    shaders/
      fragment.glsl            (MODIFIED — render mode switch)
    PopulationChart.ts        NEW — stacked area chart (Canvas 2D)
    GenomeHeatmap.ts          NEW — genome bit frequency heatmap
    PhylogeneticTree.ts       NEW — SVG/Canvas phylogenetic tree

  ui/
    ControlPanel.ts           (MODIFIED — new sliders, render mode dropdown)
    EvolutionPanel.ts         NEW — collapsible panel housing all 3 charts
    GenomeLegend.ts           NEW — shows genome → trait mapping key

  workers/
    workerBridge.ts           (MODIFIED — VariantCensus message type)

  state/
    AppState.ts               (MODIFIED — renderMode state, variant selection)
```

### Worker Message Protocol Extensions

New message types added to `WorkerMessage` discriminated union:

```typescript
// Worker → Main (new)
| { type: 'variantCensus';  data: VariantCensus }
| { type: 'variantCreated'; variantId: number; parentId: number; tick: number; genome: number }
| { type: 'variantExtinct'; variantId: number; tick: number; peakPop: number }

// Main → Worker (new)
| { type: 'setRenderMode'; mode: RenderMode }
| { type: 'highlightVariant'; variantId: number | null }
```

---

## 12. Implementation Phases

### Phase 8 — Expanded Cell Schema (Foundation)

**Goal:** Add all new TypedArrays without breaking existing behaviour.
No new simulation logic yet — just infrastructure.

**Tasks:**
1. Update `GridState.ts`: add 8 new TypedArrays to `GridBuffers`; update `_allocate`, `copyFrontToBack`, `clear`, `paintCell`, `seed`
2. Create `GenomeEncoder.ts`: implement `packGenome(s, d, t, n)`, `unpackGenome(g)`, `GENOME_LUT`
3. Update `GridState.seed()`: assign genome=0x7777 (all neutral tiers) and `variantId=0` to seeded cells
4. Update `sharedBuffers.ts`: add layout constants for new buffers
5. Update `workerBridge.ts`: new SharedArrayBuffer layout helpers
6. Run all 181 existing tests — must pass unchanged

**Deliverable:** All buffers exist; simulation behaves identically to Phase 7.

---

### Phase 9 — Per-Cell Phenotype and Genome Inheritance

**Goal:** Cell traits are now read from the genome per-cell, not from global config.

**Tasks:**
1. Create `MutationEngine.ts`: `computeChildGenome(parentGenome, mutRate, stressLevel)`
2. Update `SimulationEngine._trySpread()`: pass genome to child; apply `computeChildGenome`; set child's per-cell `toxinResist`, `nutrientAbs`, `heatResist`, `spreadBonus` from `GENOME_LUT`
3. Update `SimulationEngine.tick()`: read per-cell phenotype values from new buffers instead of global config for Life cells
4. Update `SimulationEngine._trySpread()`: effective spread rate = `config.spreadRate + cell.spreadBonus`; effective toxin resist = `cell.toxinResist`
5. Update `obstacleRules.ts`: `calcToxinDamage` receives per-cell resistance instead of config resistance
6. Seed initial `variantId=0`, `genome=0x7777`, `generation=0` on all Life cells; mutations diverge from this baseline
7. Write new tests: genome inheritance, phenotype derivation, resistance variation

**Deliverable:** Different Life cells in same simulation now behave differently.
Watch a plain default seed — cells near toxin should visibly evolve resistance over ~500 ticks.

---

### Phase 10 — Lifecycle Stages and Senescence

**Goal:** Life cells age visibly through juvenile, mature, and senescent stages.

**Tasks:**
1. Add `JUVENILE`, `SENESCENT` bits to `CellFlags`
2. Update `SimulationEngine.tick()` Life branch:
   - Compute lifecycle stage from `age` vs `config.juvenileThreshold` / `config.senescentThreshold`
   - Apply stage modifier to effective spread rate and decay rate
   - Set/clear `JUVENILE` and `SENESCENT` flags
3. Implement apoptosis: senescent cells at energy < 0.05 emit signal burst, feed neighbours, become Empty
4. Add lifecycle threshold sliders to `ControlPanel.ts`
5. Update `ColorMap.ts`: add `lifecycle` render mode colours
6. Update `WebGLRenderer.ts` fragment shader: lifecycle render mode

**Deliverable:** Visual colonies show age structure — bright green young at
the frontier, darker older cells in the interior, purple dying cells at the core.

---

### Phase 11 — Variant Registry and Multi-Species System

**Goal:** Replace the binary Life/LifeVariant system with dynamic up-to-256-variant lineages.

**Tasks:**
1. Create `VariantRegistry.ts` (main thread): `VariantRecord[]`, register/extinguish variants
2. Update `MutationEngine.ts`: `assignVariantId(parentId, parentGenome, childGenome)` — new ID if ≥3 bits differ
3. Create `VARIANT_PALETTE: Uint32Array[256]` in `ColorMap.ts` using golden-angle hue distribution
4. Update `Renderer.ts` and `WebGLRenderer.ts`: colour Life cells by `variantId` + `VARIANT_PALETTE`
5. Update `workerBridge.ts`: add census, variantCreated, variantExtinct messages
6. Update `SimulationWorker.ts`: broadcast census every 10 ticks; fire variant events
7. Implement kin selection in competition: reduce competitionStrength for near-variantId pairs
8. Update `ControlPanel.ts`: remove "Life Variant B" section; add "Evolution" section with variantCount display

**Deliverable:** A single seed diverges into 5–20 visible coloured species within 1000 ticks.
The simulation looks like a full ecosystem rather than just two colours.

---

### Phase 12 — Quorum Sensing and Colony Behaviours

**Goal:** Cell behaviour shifts based on local density (pioneer vs colony mode).

**Tasks:**
1. Create `colonyRules.ts`: `countSameVariantNeighbours()`, `isColonyMode()`, `isPioneerMode()`
2. Update `SimulationEngine.tick()` Life branch: query colony/pioneer mode; apply spread and decay multipliers
3. Update `colonyRules.ts`: implement `diffuseSignal(front, back, config)` — one pass of signal diffusion per tick on `signalStrength` buffers
4. Update `SimulationEngine.tick()` Nutrient branch: set `signalStrength = 1.0` at nutrient cells (signal source)
5. Implement chemotaxis in `_trySpread`: weight candidate targets by `chemotaxisWeight × signalStrength[ni]`
6. Implement adaptive immunity: on toxin-survival event, boost `toxinResist` field; apply to genome inheritance
7. Update `sharedBuffers.ts` and `SimulationWorker.ts`: add `signalStrength` to SharedArrayBuffer layout
8. Update `WebGLRenderer.ts` and `ColorMap.ts`: signal render mode (cyan glow overlay)

**Deliverable:** Populations visibly chase nutrients across the canvas.
Pioneer cells (SIGNALING flag) glow differently from dense colony centres.

---

### Phase 13 — Round 2 Obstacle Types

**Goal:** Add Mutagen, RadioWaste, Antibiotic, Rewinder, Colony cells.

**Tasks:**
1. Add new `CellType` enum values (11–15) to `GridState.ts`
2. Implement rules in `obstacleRules.ts`:
   - Mutagen: range scan (r=3) for Life cells; 10× mutation rate; decay via `energy`
   - RadioWaste: adjacent damage + genome bit-flip; permanent
   - Antibiotic: toxinResist survival check; passable if resistance high enough
   - Rewinder: adjacent genome drift toward tier 7
   - Colony: same-variant energy boost; Life sacrifice mechanic
3. Add all new types to `DrawingTools.ts` brush selector
4. Add `ColorMap.ts` entries for all 5 new types
5. Add obstacle parameter sliders to `ControlPanel.ts`
6. Update `WebGLRenderer.ts` fragment shader: new cell type colours
7. Write tests for each new obstacle type's survival-check logic

**Deliverable:** Can paint an antibiotic belt and watch a resistant strain
emerge on the other side over ~300 ticks.

---

### Phase 14 — Evolution Visualization Panels

**Goal:** Real-time charts show the evolutionary story as it unfolds.

**Tasks:**
1. Create `EvolutionPanel.ts`: collapsible panel below main canvas (or in sidebar)
2. Create `PopulationChart.ts`:
   - Circular buffer of 1000 census snapshots
   - Canvas 2D stacked area chart; variant bands coloured by VARIANT_PALETTE
   - X axis: ticks, Y axis: % of total cells, automatic Y autoscale
   - Hover tooltip: variant ID, current pop %, genome summary
3. Create `GenomeHeatmap.ts`:
   - 16×(top 8 variants) heatmap
   - Red=1 selected, Blue=0 selected, White=polymorphic
   - Reveals which genome positions are under selection
4. Create `PhylogeneticTree.ts`:
   - Reingold-Tilford layout algorithm for left-to-right tree
   - Branch width ∝ peak population; colour = VARIANT_PALETTE
   - Extinct variants greyed with dashed branches
   - Click to highlight variant on main canvas
5. Wire `VariantRegistry` events to all three charts
6. Add render mode dropdown to Control Panel (Viewport section)
7. Add genome legend panel: shows current phenotype values for selected variant

**Deliverable:** The UI tells the evolutionary story — users can watch
species diverge, go extinct, and leave descendants in the tree.

---

### Phase 15 — Configuration, Presets, and Polish

**Goal:** All new parameters are tunable; new presets demonstrate key concepts.

**Tasks:**

1. Add to `SimulationConfig.ts`:

| Parameter | Type | Default | Effect |
|---|---|---|---|
| `pointMutationRate` | float 0–0.05 | 0.002 | Genome bit-flip probability per spread |
| `adaptiveMutationBias` | boolean | false | Lamarckian-lite directed mutation |
| `juvenileThreshold` | int 0–200 | 30 | Age at which juvenile → mature |
| `senescentThreshold` | int 100–2000 | 400 | Age at which mature → senescent |
| `apoptosisBoost` | float 0–0.1 | 0.02 | Energy fed to neighbours on apoptosis |
| `chemotaxisWeight` | float 0–1 | 0.3 | How strongly Life follows signal gradient |
| `signalDiffusion` | float 0–1 | 0.85 | Signal fade rate per step |
| `censusInterval` | int 1–50 | 10 | Ticks between population census broadcasts |
| `quorumThreshold` | int 1–8 | 4 | Neighbours needed for colony mode |
| `adaptiveInheritanceRate` | float 0–1 | 0.3 | Probability stress-adaptation is inherited |
| `mutageDecayRate` | float 0–0.01 | 0.001 | Mutagen cell depletion rate |
| `radioStrength` | float 0–0.1 | 0.03 | RadioWaste energy damage per tick |
| `colonyBoost` | float 0–0.05 | 0.015 | Energy bonus from Colony cell per tick |

2. Add new presets:

| Preset Name | Description |
|---|---|
| `naturalSelection` | High mutation, antibiotic belt in the middle; watch resistance evolve |
| `coevolution` | Two seeded variant regions; heavy competition and kin selection |
| `mutagenicChaos` | Entire centre filled with Mutagen; genome entropy stays maximal |
| `stableColony` | Low mutation, quorum mode dominant, Colony cells scattered; stable ecosystem |
| `radiationWasteland` | RadioWaste field; only highly resistant genomes survive long-term |

3. Add keyboard shortcut: `T` = cycle render mode through all modes
4. Add shortcut: `V` = click variant from tree → highlight on canvas
5. Polish: ensure all new sliders are labelled with range and units

**Deliverable:** A complete, polished Round 2 application.  Every evolutionary
concept in the plan is demonstrable with a one-click preset.

---

## 13. Performance Budget

### Hot Loop Additions (per cell, per tick)

| New Operation | Cost estimate | Mitigation |
|---|---|---|
| Read 4 new Float32 buffers (per-cell phenotype) | ~4 cache reads | Laid out contiguously in SharedArrayBuffer |
| `computeChildGenome` (bit-flip + comparison) | ~5 integer ops | Inlined; no allocation |
| Same-variant neighbour count (quorum) | 4–8 int comparisons | Already walking neighbours; no extra loop |
| Signal diffusion pass | Full O(N) pass | Run every 3 ticks, not every tick |
| Lifecycle stage check | 2 int comparisons | Branchless: multiply modifiers by stage |

**Estimated total tick overhead at 512×512:** +15–25% vs Round 1.
At 10Hz simulation rate, this is ~25 ms per tick — well within the 100ms budget.
At 60Hz simulation rate, a grid resize down to 256×256 is recommended (256K
cells × overhead = ~6 ms per tick, 60Hz needs 16.6ms).

### Signal Diffusion Optimisation

Signal diffusion (chemotaxis field) is the most expensive new operation.
Optimisations applied:

1. **Sparse update:** Only cells adjacent to at least one Nutrient or Life cell
   with SIGNALING flag need signal recalculation.  Maintain a dirty-cell bitmask
   (Uint8Array, 1 bit per cell) updated during the Life cell pass.

2. **Reduced frequency:** Signal diffuses every 3 simulation ticks, not every tick.
   Signal values are approximate guides, not physically precise — 3-tick lag is
   invisible.

3. **WASM upgrade path:** Signal diffusion is already structured as a pure
   typed-array operation.  If 60Hz + 512×512 requires it, `diffuseSignal()` can
   be compiled to WebAssembly without architectural changes.

### Memory Pressure at 1024×1024 (Phase 7 WebGL Mode)

At 1024×1024 (1M cells), Round 2 buffers total:
- 12 buffers × 4 bytes × 2 (double-buffered where needed) × 1M cells ≈ **96 MB**
- Plus signal diffusion dirty mask: 128 KB
- Plus VARIANT_PALETTE, GENOME_LUT: negligible

96 MB is within the typical browser `ArrayBuffer` limit (1–4 GB) but warrants a
config warning if the user selects 1024+ grid with Round 2 features enabled.

**Mitigation:** Offer a "Light Genome Mode" toggle that uses `Uint8Array` for
all per-cell resistance fields (quantised to 256 steps) instead of `Float32Array`,
reducing the new buffer overhead from ~48 MB to ~12 MB at 1024×1024.

---

## 14. Configuration and Presets

### Config Object Growth

`SimulationConfig` grows from 22 fields (Round 1) to 35 fields (Round 2).
The new fields are all optional-with-defaults for backwards compatibility with
saved Round 1 configs.

### Preset Showcase: `naturalSelection`

```typescript
naturalSelection(): SimulationConfig {
  return {
    ...defaultConfig(),
    spreadRate:           0.40,
    energyDecayRate:      0.003,
    pointMutationRate:    0.008,
    adaptiveMutationBias: true,
    juvenileThreshold:    25,
    senescentThreshold:   350,
    apoptosisBoost:       0.025,
    chemotaxisWeight:     0.5,
    signalDiffusion:      0.9,
    quorumThreshold:      3,
    adaptiveInheritanceRate: 0.4,
    // Antibiotic obstacle painting instructions:
    // Paint a 5-cell-wide Antibiotic band across the midline of the grid,
    // then watch both sides evolve resistance independently.
  };
}
```

### Save / Load Format Update

The `GridState.serialize()` / `deserialize()` functions (planned for a future
phase) are updated to include all 12 buffers.  The serialization format
includes a version field (`"v2"`) so Round 1 saves can still be loaded (new
buffers are zero-initialized, genome defaults to 0x7777).

---

## Summary: Priority Order

| Phase | Milestone | Payoff |
|---|---|---|
| 8 | Buffer schema expansion | Unlocks everything; no visible change yet |
| 9 | Per-cell phenotype + inheritance | Cells start diverging; first visible evolution |
| 10 | Lifecycle stages | Visible age structure; apoptosis feeds colonies |
| 11 | Multi-species variants | Colourful ecosystem; phylogenetic tree active |
| 12 | Quorum sensing + chemotaxis | Emergent colony intelligence visible |
| 13 | Round 2 obstacle types | Rich new scenarios; antibiotic resistance demo |
| 14 | Evolution visualization panels | Tells the full story; charts prove evolution happened |
| 15 | Config, presets, polish | Shareable, demonstrable, production-ready |

Each phase delivers a running, testable application.  Phase 9 alone is already a
significant visual upgrade over Round 1.  Phases 10–11 are the core payoff.
Phases 12–15 are the polish and "wow" layer.

---

*Last updated: 2026-04-12 — based on Round 1 completion audit (Phases 1–7
complete, 181 tests passing, WebGL 2 renderer operational).*
