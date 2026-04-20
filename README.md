# What Simulator

A browser-based cellular life simulator that models the expansion, mutation, and evolution of life cells across various realistic environmental backgrounds. Watch as life spreads, mutates, and adapts to obstacles in real-time with an advanced genetics system.

![License](https://img.shields.io/badge/license-Private-red)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)
![Vite](https://img.shields.io/badge/Vite-6.3-purple)

---

## Table of Contents

1. [Overview](#overview)
2. [Key Features](#key-features)
3. [Demo](#demo)
4. [Technology Stack](#technology-stack)
5. [Getting Started](#getting-started)
6. [Project Architecture](#project-architecture)
7. [Core Concepts](#core-concepts)
8. [Development Workflow](#development-workflow)
9. [Testing](#testing)
10. [Performance Optimizations](#performance-optimizations)
11. [Contributing](#contributing)

---

## Overview

**What Simulator** is a visual cellular automaton that simulates life expansion through hostile environments. It demonstrates emergent behavior through:

- **Genetic Evolution**: 16-bit genome encoding with 4 heritable traits (spread, decay, toxin resistance, nutrient absorption)
- **Mutation System**: Mutagen zones, radioactive waste, and natural mutation rates that drive evolution
- **Environmental Challenges**: Multiple obstacle types (toxins, drains, fire, ice, barriers, gravity wells)
- **Realistic Backgrounds**: Petri dish, water, soil, leaf, deep sea, and space environments
- **Real-time Interaction**: Paint cells, adjust parameters, and watch evolution unfold at adjustable speeds

This project was built as an exploration of:
- High-performance browser-based simulations using Web Workers
- Structure-of-Arrays (SoA) data layout for cache efficiency
- Double-buffered state management for deterministic cellular automata
- Zero-copy data sharing via SharedArrayBuffer
- WebGL rendering with fallback to Canvas 2D

---

## Key Features

### 🧬 Advanced Genetics System

- **16-bit Genome Encoding**: Four 4-bit nibbles encode spread bonus, decay modifier, toxin resistance, and nutrient absorption
- **65,536 Unique Combinations**: Extensive genetic diversity enables complex evolutionary dynamics
- **Mutation Mechanics**: Multiple mutation triggers including mutagen zones, radiation, and random mutations
- **Variant Tracking**: Color-coded visualization of genetic variants with phylogenetic tree display
- **Generation Counter**: Track evolutionary lineages across generations

### 🎨 Multiple Environment Types

Six distinct background environments, each with unique visual theming:

| Environment | Description | Visual Features |
|-------------|-------------|-----------------|
| **Petri Dish** | Classic agar gel culture plate | Amber gel, measurement rings, condensation droplets |
| **Water** | Aquatic environment | Caustics, light rays, particle drift |
| **Soil** | Underground substrate | Layered strata, mineral deposits, root networks |
| **Leaf** | Plant surface | Cell structure, chloroplasts, stomata |
| **Deep Sea** | Abyssal zone | Bioluminescent particles, pressure gradients |
| **Space** | Cosmic void | Nebula clouds, stars, zero-gravity aesthetics |

### 🚧 Obstacle System

Eight types of interactive obstacles that challenge life expansion:

- **Wall**: Permanent static barrier
- **Toxin**: Kills life cells after contact
- **Nutrient**: Accelerates life spread and regenerates energy
- **Drain**: Slowly depletes life energy
- **Gravity Well**: Creates directional bias toward center
- **Barrier**: Temporary obstacle that decays over time
- **Fire**: Spreading environmental hazard with heat damage
- **Ice**: Slows expansion and freezes cells

### 🎮 Interactive Controls

- **Play/Pause/Step**: Control simulation execution
- **Speed Control**: Adjust simulation speed (1-60 ticks per second)
- **Drawing Tools**: Paint life, obstacles, and environmental features in real-time
- **Parameter Sliders**: Fine-tune simulation behavior on-the-fly
- **Presets**: Quick configurations for different scenarios (default, harsh, abundant, competitive)
- **Snapshot Export**: Save canvas states as PNG images
- **Save/Load**: Persist simulation configurations for reproducibility

### 📊 Visualization Features

- **Population Chart**: Real-time graph of cell counts over time
- **Genome Heatmap**: 2D visualization of genome distribution in the grid
- **Phylogenetic Tree**: Hierarchical display of variant lineages
- **Hover Tooltips**: Detailed cell information (type, energy, age, genome, generation)
- **Status Bar**: Live updates of tick count, FPS, and population statistics

---

## Demo

### Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Open http://localhost:5173
```

### Basic Usage

1. **Start Simulation**: Click ▶️ Play to begin
2. **Paint Life**: Select "Life" tool and paint on the canvas
3. **Add Obstacles**: Choose obstacle types and paint barriers
4. **Watch Evolution**: Observe as life spreads, mutates, and adapts
5. **Adjust Parameters**: Use sliders to modify behavior in real-time
6. **Change Environment**: Select different background themes from the toolbar

---

## Technology Stack

### Core Technologies

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Language** | TypeScript 5.7+ | Type-safe simulation logic with strict mode |
| **Build Tool** | Vite 6.3 | Lightning-fast HMR, zero-config bundling |
| **Rendering** | Canvas 2D / WebGL | Dual rendering pipeline for compatibility + performance |
| **Concurrency** | Web Workers (2) | Off-thread simulation + rendering via OffscreenCanvas |
| **State Management** | Custom EventBus | Pub/sub event system for decoupled communication |
| **Testing** | Vitest 3.2 | Fast unit tests with jsdom for DOM testing |

### Why These Choices?

- **TypeScript Strict Mode**: Catches grid indexing bugs at compile time, essential for correctness in dense cellular automata
- **Vite**: Sub-second HMR enables rapid iteration on rendering code; no Webpack config complexity
- **Web Workers**: Keeps 60fps render loop smooth even during intensive simulation ticks
- **Canvas 2D First**: 512×512 grid (262K cells) is perfectly handled by ImageData bulk writes; WebGL available as upgrade path
- **No Framework**: UI is simple control panel + canvas; vanilla Web Components avoid React/Vue overhead
- **Structure-of-Arrays**: Parallel TypedArrays instead of object-per-cell provide 3-5× cache performance

---

## Getting Started

### Prerequisites

- **Node.js** 18+ (uses native ESM, Web Workers)
- **Modern Browser** with SharedArrayBuffer support (Chrome 92+, Firefox 95+, Safari 15.2+)
- **Git** for cloning the repository

### Installation

```bash
# Clone repository
git clone https://github.com/yourusername/what-simulator.git
cd what-simulator

# Install dependencies
npm install
```

### Development Commands

```bash
# Start dev server with HMR (http://localhost:5173)
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview

# Run all tests
npm test

# Watch mode for TDD
npm run test:watch

# Generate coverage report
npm run test:coverage
```

### Browser Compatibility

| Browser | Minimum Version | Notes |
|---------|----------------|-------|
| Chrome | 92+ | Full SharedArrayBuffer support |
| Firefox | 95+ | Enable SharedArrayBuffer via headers |
| Safari | 15.2+ | Requires COOP/COEP headers |
| Edge | 92+ | Chromium-based versions |

**Note**: The app requires `SharedArrayBuffer` for zero-copy worker communication. Development server includes required COOP/COEP headers. Production deployment must serve these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## Project Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────┐
│                   Main Thread                       │
│  ┌──────────────┐  ┌────────────────────────────┐  │
│  │  UI Layer    │  │  App Orchestrator          │  │
│  │  - Toolbar   │◄─┤  - Worker management       │  │
│  │  - Control   │  │  - Event routing           │  │
│  │  - Panels    │  │  - SharedArrayBuffer       │  │
│  └──────────────┘  └────────────────────────────┘  │
│         │                    │                      │
│         │                    │ postMessage          │
│         ▼                    ▼                      │
└─────────────────────────────────────────────────────┘
          │                    │
          │                    │
┌─────────┴────────┐  ┌────────┴─────────┐
│ SimulationWorker │  │  RenderWorker    │
│  - GridState     │  │  - OffscreenCanvas│
│  - SimEngine     │  │  - WebGLRenderer │
│  - Tick loop     │  │  - Background    │
│  - Genetics      │  │  - Overlays      │
└──────────────────┘  └──────────────────┘
         │                     │
         └──► SharedArrayBuffer ◄────┘
              (zero-copy grid state)
```

### Data Flow

1. **UI → Main Thread**: User interactions (button clicks, slider changes) update `AppState`
2. **Main Thread → Workers**: `EventBus` events converted to `postMessage` calls
3. **SimulationWorker**: Runs tick loop, updates grid in SharedArrayBuffer
4. **RenderWorker**: Reads grid via SharedArrayBuffer, renders to OffscreenCanvas
5. **Workers → Main Thread**: Status updates (FPS, tick count) sent back via `postMessage`
6. **Main Thread → UI**: `EventBus` emissions trigger UI updates (charts, tooltips)

### Module Organization

```
src/
├── main.ts                    # Entry point, DOM bootstrap
├── app.ts                     # App orchestrator, worker lifecycle
├── state/
│   ├── AppState.ts           # Global application state singleton
│   └── EventBus.ts           # Pub/sub event system
├── simulation/
│   ├── GridState.ts          # Core grid data structures (SoA)
│   ├── SimulationEngine.ts   # Tick loop, cell rules
│   ├── SimulationWorker.ts   # Worker entry point
│   ├── config/
│   │   └── SimulationConfig.ts # Configuration types + presets
│   ├── genetics/
│   │   ├── GenomeEncoder.ts  # 16-bit genome encoding/decoding
│   │   ├── MutationEngine.ts # Mutation logic + variant tracking
│   │   └── VariantRegistry.ts# Variant color assignments
│   └── rules/
│       ├── environmentRules.ts # Obstacle interaction rules
│       └── obstacleRules.ts   # Obstacle-specific behaviors
├── rendering/
│   ├── Renderer.ts           # Canvas 2D renderer
│   ├── WebGLRenderer.ts      # WebGL shader pipeline
│   ├── RenderWorker.ts       # Worker entry point
│   ├── BackgroundRenderer.ts # Environment background system
│   ├── BackgroundManager.ts  # Background lifecycle
│   ├── GenomeHeatmap.ts      # Genome distribution viz
│   ├── PopulationChart.ts    # Time-series line chart
│   ├── PhylogeneticTree.ts   # Variant lineage tree
│   └── backgrounds/
│       ├── PetriDishBackground.ts
│       ├── WaterBackground.ts
│       ├── SoilBackground.ts
│       ├── LeafBackground.ts
│       ├── DeepSeaBackground.ts
│       └── SpaceBackground.ts
├── ui/
│   ├── Toolbar.ts            # Top controls (play/pause/speed)
│   ├── ControlPanel.ts       # Left sidebar sliders
│   ├── DrawingTools.ts       # Brush tool handlers
│   ├── EvolutionPanel.ts     # Genetics visualization panel
│   └── Tooltip.ts            # Cell info hover display
├── workers/
│   ├── sharedBuffers.ts      # SharedArrayBuffer allocation
│   └── workerBridge.ts       # Type-safe worker message contracts
└── utils/
    ├── colorUtils.ts         # Color interpolation helpers
    ├── math.ts              # Vector math, clamping
    └── performance.ts       # FPS counter
```

---

## Core Concepts

### 1. Cellular Automaton Model

The simulator is an **extended cellular automaton** — similar to Conway's Game of Life but with continuous state variables and richer rules.

#### Cell State Structure

Each cell stores 12 attributes in parallel TypedArrays (Structure-of-Arrays layout):

```typescript
// Round 1 attributes (base state)
cellType:       Uint8Array    // CellType enum (0-15)
energy:         Float32Array  // Energy level [0.0, 1.0]
age:            Uint16Array   // Age in ticks
flags:          Uint8Array    // Status flags (mutated, dormant)

// Round 2 attributes (genetics)
genome:         Uint16Array   // 16-bit genome (4 traits × 4 bits)
variantId:      Uint8Array    // Genetic variant identifier
generation:     Uint16Array   // Generation counter
toxinResist:    Float32Array  // Toxin resistance [0.0, 0.9]
nutrientAbs:    Float32Array  // Nutrient absorption [0.2, 1.0]
heatResist:     Float32Array  // Heat resistance [0.0, 1.0]
spreadBonus:    Float32Array  // Spread rate modifier [-0.3, +0.4]
signalStrength: Float32Array  // Colony communication strength
```

**Why Structure-of-Arrays?**

Traditional object-per-cell layout (`cells[i].energy`) scatters memory access. SoA layout (`energy[i]`) enables:
- CPU prefetching of sequential memory
- SIMD vectorization opportunities
- 3-5× faster iteration in hot loops

#### Double Buffering

Two complete sets of buffers ("front" and "back") eliminate read/write ordering issues:

```typescript
// Tick N: Read from front, write to back
for (let i = 0; i < gridSize; i++) {
  const neighbors = getNeighbors(i, frontBuffer);
  backBuffer.cellType[i] = applyRules(neighbors);
}

// Swap pointers (no data copy!)
[frontBuffer, backBuffer] = [backBuffer, frontBuffer];
```

### 2. Genetics System

#### Genome Encoding

Each life cell carries a **16-bit genome** divided into four 4-bit nibbles:

```
Bits 15-12    Bits 11-8     Bits 7-4      Bits 3-0
┌───────────┬─────────────┬─────────────┬───────────┐
│ Nutrient  │  Toxin      │  Decay      │  Spread   │
│ Absorption│  Resistance │  Modifier   │  Bonus    │
│  (0-15)   │   (0-15)    │   (0-15)    │  (0-15)   │
└───────────┴─────────────┴─────────────┴───────────┘
```

**Neutral genome**: `0x7777` (all traits at tier 7, the starting state)

#### Phenotype Lookup

Each tier (0-15) maps to a phenotype value via pre-computed lookup table `GENOME_LUT`:

| Trait | Tier 0 (min) | Tier 7 (neutral) | Tier 15 (max) |
|-------|--------------|------------------|---------------|
| **Spread Bonus** | -0.30 | 0.00 | +0.40 |
| **Decay Modifier** | +0.008 | 0.000 | -0.003 |
| **Toxin Resist** | 0.00 | 0.40 | 0.90 |
| **Nutrient Abs** | 0.20 | 0.60 | 1.00 |

Lookup is O(1) with zero floating-point math:
```typescript
const spreadTier = (genome >> 0) & 0xF;
const spreadBonus = GENOME_LUT[TRAIT_SPREAD * 16 + spreadTier];
```

#### Mutation Mechanics

Three mutation sources:

1. **Natural Mutation**: Low baseline rate (configurable, ~0.1%)
2. **Mutagen Zones**: Cells within range 3 of Mutagen obstacles get 10× mutation rate
3. **Radiation**: RadioWaste causes random genome bit-flips every tick

Mutations flip random bits in the genome, creating new trait combinations.

#### Variant Tracking

When a mutation produces a novel genome:
- `MutationEngine` assigns a unique `variantId` (0-255)
- Variant gets a random HSL color for visualization
- `PhylogeneticTree` tracks parent-child relationships
- `generation` counter increments from parent

### 3. Environment Backgrounds

Six background renderers implement the `Background` interface:

```typescript
interface Background {
  render(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  update?(frame: number): void; // Optional animation
}
```

Each background uses deterministic procedural generation for consistency:

- **Petri Dish**: Radial gradients, sine-wave ripples, animated droplets
- **Water**: Caustics using ray-marching, particle drift with Perlin noise
- **Soil**: Layered strata with Voronoi cells, mineral deposits
- **Leaf**: Cellular structure with Delaunay triangulation, chloroplasts
- **Deep Sea**: Bioluminescent particles, pressure gradients
- **Space**: Nebula clouds via fractal noise, star field

Backgrounds are rendered once to an offscreen canvas, then cached for performance.

### 4. Rendering Pipeline

#### Canvas 2D Renderer (Default)

1. **Background**: Draw cached background image
2. **Grid Cells**: Bulk write to `ImageData` buffer (262K pixels in ~2ms)
3. **Overlays**: Draw genome heatmap, phylogenetic tree, population chart
4. **Tooltips**: Render cell info on hover

```typescript
const imageData = ctx.createImageData(width, height);
const pixels = imageData.data; // Uint8ClampedArray

for (let i = 0; i < gridSize; i++) {
  const color = cellColor(cellType[i], energy[i], variantId[i]);
  pixels[i * 4 + 0] = color.r;
  pixels[i * 4 + 1] = color.g;
  pixels[i * 4 + 2] = color.b;
  pixels[i * 4 + 3] = 255;
}

ctx.putImageData(imageData, 0, 0);
```

#### WebGL Renderer (Future)

Fragment shader reads grid state from texture:

```glsl
uniform sampler2D u_cellTypeTexture;
uniform sampler2D u_energyTexture;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float cellType = texture2D(u_cellTypeTexture, uv).r;
  float energy = texture2D(u_energyTexture, uv).r;
  
  vec3 color = cellTypeColor(cellType, energy);
  gl_FragColor = vec4(color, 1.0);
}
```

Enables GPU-accelerated color mapping and post-processing effects.

### 5. Worker Architecture

#### Why Two Workers?

- **SimulationWorker**: CPU-intensive tick loop (can run slower than 60fps)
- **RenderWorker**: GPU-bound rendering (must maintain 60fps)

Separating them prevents simulation stutter from blocking rendering.

#### SharedArrayBuffer Communication

Traditional `postMessage` copies data — unacceptable for 16MB grid state at 60fps.

`SharedArrayBuffer` provides zero-copy shared memory:

```typescript
// Main thread allocates
const sab = new SharedArrayBuffer(16 * 1024 * 1024);
const cellTypeView = new Uint8Array(sab, 0, gridSize);

// Transfer to workers (by reference)
simWorker.postMessage({ type: 'init', buffer: sab });
renderWorker.postMessage({ type: 'init', buffer: sab });

// Workers read directly
const cellType = new Uint8Array(sharedBuffer, 0, gridSize);
```

**Control buffer**: Small SAB used for coordination:
```typescript
const ctrl = new Int32Array(controlSAB);
const FRONT_INDEX = ctrl[0]; // Which buffer is currently front (0 or 1)
```

SimulationWorker writes `FRONT_INDEX` after each tick; RenderWorker reads it before rendering.

---

## Development Workflow

### Project Setup

```bash
# Install dependencies
npm install

# Start dev server (http://localhost:5173)
npm run dev
```

Vite's HMR enables instant feedback:
- Edit a component → See changes without page reload
- Edit styles → CSS hot-swaps without state loss
- Edit worker code → Worker automatically restarts

### Code Style

This project follows **Google TypeScript Style Guide** with strict mode enabled.

#### Key Rules

1. **Use `const` by default**: Only use `let` when reassignment is needed
2. **Explicit return types**: All exported functions must specify return type
3. **Prefer `unknown` over `any`**: Use type guards to narrow
4. **Interfaces vs Types**:
   - `interface` for object shapes that may be extended
   - `type` for unions, intersections, mapped types
5. **JSDoc comments**: Every public function, class, and module

#### Example

```typescript
/**
 * Calculates the next cell state based on neighbor count.
 * 
 * @param neighbors - Array of neighboring cell types.
 * @param current - Current cell energy level.
 * @returns The updated energy value.
 */
export function applyLifeRules(
  neighbors: readonly CellType[],
  current: number
): number {
  const lifeCount = neighbors.filter(n => n === CellType.Life).length;
  if (lifeCount >= 2) {
    return Math.min(current + 0.1, 1.0);
  }
  return Math.max(current - 0.01, 0.0);
}
```

### TypeScript Configuration

`tsconfig.json` uses strict mode with all safety checks:

```json
{
  "compilerOptions": {
    "strict": true,                    // Enable all strict checks
    "noUnusedLocals": true,            // Catch unused variables
    "noUnusedParameters": true,        // Catch unused params
    "noFallthroughCasesInSwitch": true // Prevent switch fallthrough bugs
  }
}
```

### Adding New Features

#### 1. Adding a New Obstacle Type

**Step 1**: Update `CellType` enum in `GridState.ts`:

```typescript
export const enum CellType {
  // ...existing types...
  MyNewObstacle = 16,
}
```

**Step 2**: Add rule in `obstacleRules.ts`:

```typescript
export function applyMyNewObstacleRules(
  idx: number,
  state: GridState,
  config: SimulationConfig
): void {
  // Your rule logic here
}
```

**Step 3**: Call rule in `SimulationEngine.ts` tick loop:

```typescript
if (cellType === CellType.MyNewObstacle) {
  applyMyNewObstacleRules(i, this._state, this._config);
}
```

**Step 4**: Add color mapping in `ColorMap.ts`:

```typescript
case CellType.MyNewObstacle:
  return { r: 255, g: 128, b: 0 }; // Orange
```

**Step 5**: Add drawing tool in `ControlPanel.ts`:

```typescript
{
  tool: 'myNewObstacle',
  label: 'My Obstacle',
  color: '#ff8000',
  title: 'Paint my new obstacle type.'
}
```

#### 2. Adding a New Background

**Step 1**: Create file in `src/rendering/backgrounds/`:

```typescript
// MyBackground.ts
import { type Background } from '../BackgroundRenderer.js';

export class MyBackground implements Background {
  render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    // Your rendering logic
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, width, height);
  }

  update(frame: number): void {
    // Optional animation logic
  }
}
```

**Step 2**: Register in `BackgroundRenderer.ts`:

```typescript
import { MyBackground } from './backgrounds/MyBackground.js';

const BACKGROUNDS: Record<BackgroundType, () => Background> = {
  // ...existing backgrounds...
  'myBackground': () => new MyBackground(),
};

export const BACKGROUND_LABELS: Record<BackgroundType, string> = {
  // ...existing labels...
  'myBackground': 'My Custom Background',
};
```

**Step 3**: Update `BackgroundType` union:

```typescript
export type BackgroundType =
  | 'petri'
  | 'water'
  | 'soil'
  | 'leaf'
  | 'deepSea'
  | 'space'
  | 'myBackground';
```

### Debugging Tips

#### 1. Inspect Grid State

Use browser DevTools to access SharedArrayBuffer:

```javascript
// In console (during simulation)
const app = window.app; // Exposed by main.ts
const cellType = app._frontBuffer.cellType;
const energy = app._frontBuffer.energy;

// Check cell at position (x, y)
const idx = y * 512 + x;
console.log({
  type: cellType[idx],
  energy: energy[idx],
  age: app._frontBuffer.age[idx]
});
```

#### 2. Worker Logging

Workers can't use `console.log` — send messages to main thread:

```typescript
// In SimulationWorker.ts
function debug(msg: string): void {
  self.postMessage({ type: 'debug', message: msg });
}

debug(`Tick ${tickCount}: ${liveCount} cells alive`);
```

Catch in `App.ts`:

```typescript
this._simWorker.onmessage = (e) => {
  if (e.data.type === 'debug') {
    console.log('[SimWorker]', e.data.message);
  }
};
```

#### 3. Performance Profiling

Chrome DevTools Performance tab can profile workers:

1. Open Performance tab
2. Check "Enable advanced paint instrumentation"
3. Record profile
4. Look for `SimulationWorker` and `RenderWorker` frames
5. Identify hot functions (red in flame graph)

---

## Testing

### Test Framework: Vitest

Tests use Vitest with jsdom for DOM testing and vi.fn() for mocks.

```bash
# Run all tests once
npm test

# Watch mode (re-run on file change)
npm run test:watch

# Coverage report (html + text)
npm run test:coverage
```

### Test Structure

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GenomeEncoder } from './GenomeEncoder';

describe('GenomeEncoder', () => {
  describe('getSpreadBonus', () => {
    it('returns 0.0 for neutral genome 0x7777', () => {
      expect(GenomeEncoder.getSpreadBonus(0x7777)).toBe(0.0);
    });

    it('returns -0.30 for minimum tier 0', () => {
      const genome = 0x0000; // All traits tier 0
      expect(GenomeEncoder.getSpreadBonus(genome)).toBe(-0.30);
    });

    it('returns +0.40 for maximum tier 15', () => {
      const genome = 0xFFFF; // All traits tier 15
      expect(GenomeEncoder.getSpreadBonus(genome)).toBe(0.40);
    });
  });
});
```

### Mocking Shared Dependencies

Use `vi.mock()` for module mocks:

```typescript
import { vi } from 'vitest';

vi.mock('./GridState', () => ({
  GridState: vi.fn().mockImplementation(() => ({
    getCellType: vi.fn(() => CellType.Life),
    setEnergy: vi.fn(),
  })),
}));
```

### Testing Canvas Code

Vitest with jsdom provides basic Canvas API:

```typescript
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Renderer } from './Renderer';

describe('Renderer', () => {
  it('creates 2D context', () => {
    const canvas = document.createElement('canvas');
    const renderer = new Renderer(canvas);
    expect(renderer.context).toBeDefined();
  });
});
```

For complex rendering tests, use snapshot testing with canvas data URLs.

### Coverage Goals

- **Simulation logic**: 90%+ coverage (critical correctness)
- **Rendering code**: 60%+ coverage (visual correctness is manual)
- **UI components**: 70%+ coverage (interaction flows)

---

## Performance Optimizations

### 1. Structure-of-Arrays Layout

**Problem**: Object-per-cell layout causes cache misses.

```typescript
// ❌ Slow: Random memory access
class Cell {
  type: number;
  energy: number;
  age: number;
}
const cells: Cell[] = []; // Objects scattered in memory

for (const cell of cells) {
  if (cell.energy > 0.5) { /* ... */ }
}
```

**Solution**: Parallel TypedArrays for sequential access.

```typescript
// ✅ Fast: Sequential memory access
const energy = new Float32Array(gridSize);

for (let i = 0; i < gridSize; i++) {
  if (energy[i] > 0.5) { /* ... */ }
}
```

**Speedup**: 3-5× faster iteration in hot loops.

### 2. Double Buffering

**Problem**: In-place updates have read/write dependencies.

```typescript
// ❌ Order-dependent: Modifying array during iteration
for (let i = 0; i < gridSize; i++) {
  const left = state[i - 1];  // May be old or new value!
  state[i] = computeNext(left);
}
```

**Solution**: Read from one buffer, write to another.

```typescript
// ✅ Order-independent: Always reading old state
for (let i = 0; i < gridSize; i++) {
  const left = frontBuffer[i - 1];
  backBuffer[i] = computeNext(left);
}
[frontBuffer, backBuffer] = [backBuffer, frontBuffer]; // Swap pointers
```

**Benefit**: Deterministic, parallelizable, zero-copy swap.

### 3. Web Workers

**Problem**: Heavy simulation blocks UI rendering.

**Solution**: Offload simulation to dedicated worker.

```typescript
// Main thread: Just UI updates
requestAnimationFrame(() => {
  updateStatusBar();
  renderTooltip();
});

// SimulationWorker: Heavy computation
while (running) {
  runTick();
  Atomics.wait(sharedInt32, 0, 0, 16); // Sleep 16ms
}
```

**Result**: UI stays at 60fps even if simulation drops to 30fps.

### 4. SharedArrayBuffer

**Problem**: `postMessage` copies large arrays (slow).

```typescript
// ❌ Copies 16MB of data every frame
worker.postMessage({ gridData: new Uint8Array(gridSize) });
```

**Solution**: Workers share memory via `SharedArrayBuffer`.

```typescript
// ✅ Zero-copy: Just pass reference
const sab = new SharedArrayBuffer(16 * 1024 * 1024);
worker.postMessage({ buffer: sab }, [sab]);

// Worker reads directly (no copy)
const cellType = new Uint8Array(sab, 0, gridSize);
```

**Speedup**: ~50× faster than `postMessage` for large buffers.

### 5. Lookup Tables

**Problem**: Per-cell floating-point math is expensive.

```typescript
// ❌ Slow: 4 divisions + 4 bit shifts per cell
const spreadTier = (genome >> 0) & 0xF;
const spreadBonus = -0.30 + (spreadTier / 15.0) * 0.70;
```

**Solution**: Pre-compute all 16 values once.

```typescript
// ✅ Fast: O(1) array lookup
const spreadBonus = GENOME_LUT[TRAIT_SPREAD * 16 + spreadTier];
```

**Speedup**: ~10× faster in hot loop.

### 6. Dirty Rectangles (Future)

Currently entire grid is re-rendered every frame. Future optimization:

```typescript
const dirtyRegions: Rect[] = [];

// During tick, track changed regions
if (cellChanged(i)) {
  dirtyRegions.push(getRectAroundIndex(i));
}

// Render only dirty regions
for (const rect of dirtyRegions) {
  ctx.putImageData(imageData, rect.x, rect.y);
}
```

Expected speedup: 2-3× for sparse simulations.

---

## Contributing

### Branching Strategy

- `main`: Stable releases
- `develop`: Integration branch
- `feature/*`: New features
- `bugfix/*`: Bug fixes

### Pull Request Process

1. **Create feature branch**: `git checkout -b feature/my-feature`
2. **Make changes**: Follow code style guide
3. **Add tests**: Cover new functionality
4. **Run tests**: `npm test` must pass
5. **Build**: `npm run build` must succeed
6. **Commit**: Use conventional commits (e.g., `feat: add new obstacle type`)
7. **Push**: `git push origin feature/my-feature`
8. **Open PR**: Against `develop` branch with description

### Commit Convention

```
type(scope): subject

body

footer
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style (formatting, no logic change)
- `refactor`: Code restructuring
- `perf`: Performance improvement
- `test`: Adding/fixing tests
- `chore`: Build process, tooling

**Example**:
```
feat(genetics): add heat resistance trait

- Added heatResist to genome encoding
- Updated GENOME_LUT with heat tier values
- Implemented fire damage reduction based on trait

Closes #42
```

---

## License

Private project. All rights reserved.

---

## Acknowledgments

- **Inspiration**: Conway's Game of Life, Falling Sand games
- **Algorithms**: Structure-of-Arrays from game engine research
- **Visual Design**: Scientific visualization principles

---

## Roadmap

### Phase 1 ✅
- Basic cellular automaton with Life and obstacles
- Canvas 2D rendering
- UI controls (play/pause, sliders)

### Phase 2 ✅
- Advanced genetics system (16-bit genome)
- Mutation mechanics
- Variant visualization

### Phase 3 ✅
- Multiple environment backgrounds
- Phylogenetic tree
- Population charts

### Phase 4 ✅
- Web Worker architecture
- SharedArrayBuffer optimization
- OffscreenCanvas rendering

### Phase 5 (Current)
- WebGL renderer
- Advanced obstacle types
- Save/load system

### Phase 6 (Planned)
- Neural network trait (cells learn patterns)
- Multi-species competition
- 3D visualization mode
- Network multiplayer (shared simulations)

---

## FAQ

### Q: Why TypeScript instead of Rust/WASM?

**A**: TypeScript with TypedArrays and Workers is fast enough for this scale (262K cells at 60fps). WASM would add complexity without meaningful speedup. If we scale to 4K×4K grids (16M cells), WASM becomes worthwhile.

### Q: Can I run this offline?

**A**: Yes! After `npm run build`, the `dist/` folder is a self-contained static site. Serve it locally with any HTTP server.

### Q: Why SharedArrayBuffer instead of OffscreenCanvas.transferToImageBitmap?

**A**: `transferToImageBitmap` is great for rendering but doesn't help with simulation state sharing. We need both workers to access the same grid data without copying. SharedArrayBuffer is the only way to achieve true zero-copy communication.

### Q: How do I deploy this?

**A**: Host `dist/` on any static server (Netlify, Vercel, GitHub Pages). **Important**: Configure COOP/COEP headers for SharedArrayBuffer support:

```
# netlify.toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"
```

### Q: Why no React/Vue/Svelte?

**A**: The UI is simple (control panel + canvas). Modern frameworks add ~50KB+ bundle size and virtual DOM overhead for no benefit here. Vanilla Web Components keep it lean (<20KB minified).

---

## Contact

For questions or suggestions, open an issue on GitHub.

---

**Made with ❤️ and TypeScript**
