# What Simulator — Implementation Plan

## Table of Contents

1. [Technology Stack](#1-technology-stack)
2. [Simulation Design](#2-simulation-design)
3. [Obstacle System](#3-obstacle-system)
4. [Life Expansion Attributes](#4-life-expansion-attributes)
5. [Rendering Pipeline](#5-rendering-pipeline)
6. [UI/Controls Design](#6-uicontrols-design)
7. [Architecture](#7-architecture)
8. [Implementation Phases](#8-implementation-phases)
9. [Performance Considerations](#9-performance-considerations)
10. [Future Extensibility](#10-future-extensibility)

---

## 1. Technology Stack

**Recommendation: Browser-based SPA using TypeScript + Canvas 2D (with a WebGL upgrade path)**

### Primary Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | Strong typing for simulation state, excellent IDE support, catches grid-index bugs at compile time |
| Bundler | Vite | Near-instant HMR, zero-config TypeScript, first-class static asset handling |
| Rendering | Canvas 2D initially, OffscreenCanvas + ImageData for bulk pixel writes | Sufficient for grids up to ~512x512 at 60fps; no shader complexity until needed |
| UI Controls | Vanilla HTML + CSS with custom Web Components | No framework dependency; sliders and panels are simple enough that React/Vue adds overhead without value |
| State | Plain TypeScript module (no Redux/Zustand) | Simulation state is a flat typed object; pub/sub event emitter suffices |
| Workers | Web Workers (one dedicated simulation worker) | Keeps the update loop off the main thread entirely |
| Testing | Vitest | Same config as Vite; fast unit tests for simulation logic |

### Why Not Electron / Native

The simulation is purely computational and visual with no filesystem or OS-level requirements. A browser tab provides everything needed and allows instant sharing via URL. Electron adds packaging overhead with no benefit at this stage.

### Why Not WebGL Immediately

WebGL pays off when you need per-pixel shader math or particle counts in the millions. A cellular automata grid of 512x512 = 262,144 cells is comfortably handled by bulk `ImageData` writes on Canvas 2D (essentially a memcpy into a pixel buffer). WebGL is designed as the upgrade path in Phase 4.

### Why Not React/Vue

The UI is a control panel beside a canvas. There is no component tree that benefits from virtual DOM diffing. Custom Web Components for the slider panel and toolbar keep the bundle small and the update path direct.

---

## 2. Simulation Design

### Model Choice: Extended Cellular Automaton (CA)

The simulation uses a **discrete grid cellular automaton** — the same conceptual family as Conway's Game of Life but with a richer cell state. This is chosen over:

- **Particle systems**: Too expensive for dense spread; no natural "occupied territory" concept.
- **Agent-based**: Appropriate for sparse populations, not area-of-control expansion.
- **Fluid simulation**: Wrong metaphor; fluid conserves mass, life multiplies.

A CA gives us deterministic rules, cheap per-cell updates, and visually satisfying spreading behavior.

### Cell State

Each cell is a fixed-size record stored in parallel typed arrays (Structure of Arrays layout for cache efficiency):

```
enum CellType: uint8
  0 = Empty
  1 = Life
  2 = Wall          (static obstacle)
  3 = Toxin         (kills life on contact after N ticks)
  4 = Nutrient      (accelerates spread)
  5 = Drain         (slows spread, drains energy)
  6 = GravityWell   (directional bias toward center)
  7 = Barrier       (temporary — can decay)

energy: float32       // 0.0 – 1.0; life dies at 0
age:    uint16        // ticks since cell became Life
flags:  uint8         // bitmask: mutated, dormant, marked-for-death
```

Stored as parallel `TypedArray` buffers:

```
cellType:  Uint8Array   [width * height]
energy:    Float32Array [width * height]
age:       Uint16Array  [width * height]
flags:     Uint8Array   [width * height]
```

Total memory at 512x512: (1 + 4 + 2 + 1) bytes * 262144 = ~2.1 MB. Trivial.

### Double Buffering

The simulation maintains two sets of these arrays (front buffer / back buffer). Each tick reads from front, writes to back, then swaps pointers. This eliminates read/write ordering dependencies without copying data.

### Update Loop (per tick)

```
for each cell index i in [0, width*height):
  type = cellType_front[i]
  if type == Life:
    applyEnergyDecay(i)
    if energy[i] <= 0: markDead(i)
    else:
      trySpread(i, neighbors)
      tryMutate(i)
  else if type == Toxin:
    applyToxinDiffusion(i)
  else if type == Nutrient:
    applyNutrientDecay(i)
  // Walls never update
```

The inner loop is a plain integer index walk — no object allocation, no pointer chasing.

### Neighbor Sampling

Support both Moore neighborhood (8 neighbors) and Von Neumann (4 neighbors), switchable at runtime. Spread targets are selected probabilistically weighted by the `spreadRate` parameter and modified by obstacle adjacency bonuses/penalties.

### Tick Rate Decoupling

The simulation tick rate is decoupled from the render frame rate. The Web Worker runs its own `setInterval` at a configurable simulation Hz (1–60 Hz). The main thread renders at `requestAnimationFrame` speed (60fps) using the most recently committed buffer snapshot.

---

## 3. Obstacle System

### Obstacle Type Catalog

**Static / Permanent Obstacles**

| Type | Behavior | Visual |
|---|---|---|
| Wall | Impassable; life cannot enter or spread through | Dark gray solid |
| Mirror Wall | Impassable but reflects spread direction bias | Silver with sheen |

**Environmental Modifiers (passable)**

| Type | Behavior | Visual |
|---|---|---|
| Toxin | Life entering loses energy rapidly; if energy hits 0 life dies; toxin cell is consumed after N kills | Purple/red gradient |
| Nutrient | Life entering gains energy; increases local spread rate multiplier; depletes over time | Green pulse |
| Drain | Reduces energy of adjacent life cells each tick; slows spread rate locally | Dark blue sink |
| Scorched Ground | Life cannot spread into this cell for K ticks (cooldown after death); then becomes empty | Ash gray |

**Dynamic / Directional Obstacles**

| Type | Behavior | Visual |
|---|---|---|
| Gravity Well | Applies a directional spread bias pulling life toward the well center; does not block | Orange radial glow |
| Repulsion Field | Pushes spread probability away from center; life avoids the area | Blue radial glow |
| Current | Applies a fixed directional spread bias in a rectangle (like wind or water flow) | Arrow overlays, slight color tint |

**Temporal Obstacles**

| Type | Behavior | Visual |
|---|---|---|
| Barrier | Impassable wall that decays after N ticks, then becomes empty | Yellow fading to transparent |
| Fire | Destroys life on contact; spreads to adjacent life/nutrient cells; burns out after fuel consumed | Animated orange/red |
| Ice | Freezes life cells (dormant: no spread, no death) on contact for K ticks | Blue-white crystalline |

### Obstacle Interaction Matrix

| Life meets | Outcome |
|---|---|
| Wall | Blocked |
| Toxin | Energy -= toxinStrength each tick; toxin.killCount++ |
| Nutrient | Energy += nutrientBoost; spreadRate * nutrientMultiplier |
| Drain | Energy -= drainRate; spreadChance * 0.5 |
| Gravity Well | spreadWeight toward well += gravityStrength / distance^2 |
| Barrier | Blocked until barrier.ticksRemaining == 0 |
| Fire | Instant death; fire spreads |
| Ice | Cell becomes dormant; no updates until thaw |

### Obstacle Placement

Obstacles are drawn onto the grid via the drawing tool (see Section 6). They are stored in the same `cellType` array — no separate obstacle layer is needed. The simulation rules branch on `cellType`.

---

## 4. Life Expansion Attributes

All parameters live in a single `SimulationConfig` object that can be mutated at runtime (changes take effect on the next tick).

### Core Life Parameters

| Parameter | Type | Range | Effect |
|---|---|---|---|
| `spreadRate` | float | 0.0 – 1.0 | Probability per tick that a Life cell attempts to spread to each eligible neighbor |
| `energyDecayRate` | float | 0.0 – 1.0 | Energy lost per tick per Life cell (metabolic cost) |
| `reproductionThreshold` | float | 0.0 – 1.0 | Minimum energy required for a cell to attempt spreading |
| `initialEnergy` | float | 0.0 – 1.0 | Energy assigned to newly born cells |
| `mutationRate` | float | 0.0 – 0.1 | Probability per tick that a Life cell mutates into a Life variant |
| `neighborhoodMode` | enum | Moore / VonNeumann | Which neighbors are considered for spread |
| `overpopulationLimit` | int | 0 – 8 | Max live neighbors before a cell dies (Conway-style pressure) |
| `underpopulationLimit` | int | 0 – 8 | Min live neighbors required to survive |

### Environmental Sensitivity Parameters

| Parameter | Type | Effect |
|---|---|---|
| `toxinResistance` | float 0–1 | Multiplier reducing toxin damage |
| `nutrientAbsorption` | float 0–1 | Multiplier increasing nutrient energy gain |
| `gravityResponse` | float 0–1 | Sensitivity to gravity well directional bias |

### Life Variants

Mutation produces a second life type (`LifeVariant`) with an independent config. This enables co-evolution and competitive exclusion dynamics:

- Variant A: base life (green)
- Variant B: mutated life (yellow) — can have different spreadRate, energyDecayRate, etc.

The two variants compete for space. A Variant B cell spread into a Variant A cell kills the A cell (with configurable probability `competitionStrength`).

### Obstacle Parameters (runtime-tunable)

| Parameter | Controls |
|---|---|
| `toxinStrength` | Energy damage per tick from toxin cells |
| `toxinDurability` | Number of life kills before toxin cell is consumed |
| `nutrientBoost` | Energy gain per tick on nutrient cells |
| `nutrientDecayRate` | How fast nutrients deplete |
| `barrierLifetime` | Ticks before barriers crumble |
| `gravityStrength` | Pull force of gravity wells |
| `drainRate` | Energy loss per tick on drain cells |

---

## 5. Rendering Pipeline

### Canvas 2D with ImageData (Primary)

Rendering maps each grid cell to one or more screen pixels using a direct pixel buffer write:

```typescript
const imageData = ctx.createImageData(canvas.width, canvas.height);
const buf = imageData.data; // Uint8ClampedArray, RGBA

for each cell index i:
  color = colorMap[cellType[i], energy[i], age[i]]
  px = i * cellSize * 4  // simplified; actual 2D mapping required
  buf[px]   = color.r
  buf[px+1] = color.g
  buf[px+2] = color.b
  buf[px+3] = 255

ctx.putImageData(imageData, 0, 0);
```

This runs entirely on the CPU at ~60fps for grids up to 512x512 with 1px cells.

### Color Mapping

Each cell type has a base color. Life cells use energy as a luminosity modifier:

| Cell Type | Base Color | Modifier |
|---|---|---|
| Empty | #0a0a0a (near-black) | none |
| Life (A) | #00ff88 (green) | energy * brightness |
| Life (B) | #ffdd00 (yellow) | energy * brightness |
| Wall | #3a3a3a | none |
| Toxin | #cc00ff | pulse animation |
| Nutrient | #00cc44 | pulse animation |
| Drain | #0044cc | ripple animation |
| Gravity Well | #ff8800 | radial glow overlay |
| Barrier | #ffee00 | alpha fade |
| Fire | animated HSL rotation | — |
| Ice | #aaddff | shimmer |

Animated cells (toxin pulse, fire flicker) use a global `animFrame` counter modulated independently of the simulation tick.

### Cell Size and Zoom

The canvas uses a `cellSize` property (pixels per cell). Default is 2px (512x512 grid = 1024x1024 canvas). A zoom control scales cellSize from 1 to 8. Pan is handled by translating the canvas 2D context transform.

### OffscreenCanvas

The pixel buffer write is moved to an `OffscreenCanvas` in the render worker (separate from the simulation worker). The main thread receives the rendered frame via `transferControlToOffscreen`, eliminating the main-thread render cost.

### Overlay Layer

A second canvas (CSS-positioned on top) draws:
- Obstacle outlines when in edit mode
- Directional arrows for Currents and Gravity Wells
- Selection rectangle when drawing obstacles
- Cell info tooltip on hover

This overlay canvas uses standard 2D draw calls and is only repainted when the cursor moves or edit mode changes — never every frame.

---

## 6. UI/Controls Design

### Layout

```
+--------------------------------------------------+
|  Toolbar: [Play] [Pause] [Step] [Reset] [Speed]  |
+-------------------+------------------------------+
|                   |                              |
|  Control Panel    |      Simulation Canvas       |
|  (320px fixed)    |      (fills remaining)       |
|                   |                              |
|  [Life params]    |                              |
|  [Obstacle params]|                              |
|  [Drawing tools]  |                              |
|  [Viewport]       |                              |
+-------------------+------------------------------+
|  Status Bar: tick count | FPS | live cells count |
+--------------------------------------------------+
```

### Toolbar (top bar)

- Play / Pause button (spacebar shortcut)
- Step (advance one tick; only active when paused) — shortcut: right arrow
- Reset (clear grid, restart from configured seed)
- Speed slider: 1–60 simulation Hz, labeled "Ticks/sec"
- Snapshot button: saves canvas as PNG

### Control Panel (left sidebar)

**Life Parameters section** — each parameter is a labeled slider with a live numeric readout:
- Spread Rate
- Energy Decay
- Reproduction Threshold
- Initial Energy
- Mutation Rate
- Overpopulation Limit (integer stepper)
- Underpopulation Limit (integer stepper)
- Neighborhood: toggle Moore / Von Neumann

**Life Variant section** (collapsible, visible only when mutation has occurred):
- Same sliders for Variant B, shown when at least one variant cell exists

**Obstacle Parameters section** (collapsible):
- Toxin Strength / Durability
- Nutrient Boost / Decay Rate
- Barrier Lifetime
- Gravity Strength
- Drain Rate

**Drawing Tools section**:
- Brush selector: Life | Wall | Toxin | Nutrient | Drain | GravityWell | Barrier | Fire | Ice | Erase
- Brush size: 1–20 cells (circle or square)
- Shape tools: Line, Rectangle, Flood Fill
- "Clear Obstacles" button
- "Clear Life" button

**Viewport section**:
- Grid size selector: 64, 128, 256, 512 (changing resets simulation)
- Cell size / Zoom: 1–8px per cell
- Toggle grid lines (1px overlay, only useful at 4px+ cell size)

### Canvas Interactions

- **Left-click + drag**: Paint selected brush onto grid (live, during simulation)
- **Right-click + drag**: Erase
- **Middle-click + drag** or **Space + drag**: Pan
- **Scroll wheel**: Zoom in/out centered on cursor
- **Hover**: Show cell info tooltip (type, energy, age, coordinates)

### Real-Time Parameter Application

Parameter changes take effect immediately — the `SimulationConfig` object is a `SharedArrayBuffer` or message-passed update to the worker. The worker reads config at the start of each tick. No restart is needed.

---

## 7. Architecture

### Folder Structure

```
what-simulator/
  docs/
    feature.md
    PLAN.md
  src/
    main.ts                  # Entry point; bootstraps app
    app.ts                   # Top-level orchestrator

    simulation/
      SimulationWorker.ts    # Web Worker entry point (runs engine loop)
      SimulationEngine.ts    # Core tick logic; pure functions on TypedArrays
      GridState.ts           # Buffer definitions, allocation, swap logic
      rules/
        lifeRules.ts         # Life spread, death, mutation rules
        obstacleRules.ts     # Per-obstacle-type interaction handlers
        environmentRules.ts  # Toxin diffusion, nutrient decay, fire spread
      config/
        SimulationConfig.ts  # Typed config object + defaults
        presets.ts           # Named config presets (Classic GoL, Plague, etc.)

    rendering/
      RenderWorker.ts        # OffscreenCanvas worker entry
      Renderer.ts            # ImageData write loop, color mapping
      ColorMap.ts            # Cell type + energy → RGBA lookup tables
      OverlayRenderer.ts     # 2D overlay canvas draws (arrows, selection, tooltip)

    ui/
      App.ts                 # Mounts toolbar, panel, canvas, status bar
      Toolbar.ts             # Play/pause/step/reset/speed controls
      ControlPanel.ts        # Left sidebar Web Component
      sliders/
        ParameterSlider.ts   # Reusable labeled slider Web Component
        IntStepper.ts        # Integer stepper Web Component
      DrawingTools.ts        # Brush/shape tool state and canvas event handlers
      Tooltip.ts             # Hover tooltip component

    state/
      AppState.ts            # Observable state object (config, running, tool selection)
      EventBus.ts            # Simple pub/sub for cross-module communication

    workers/
      workerBridge.ts        # Typed message passing helpers (main <-> workers)
      sharedBuffers.ts       # SharedArrayBuffer allocation and layout constants

    utils/
      math.ts                # Index <-> (x,y) helpers, distance, clamp
      colorUtils.ts          # HSL/RGB utilities
      assert.ts              # Dev-mode assertions
      performance.ts         # FPS counter, tick counter utilities

  index.html
  vite.config.ts
  tsconfig.json
  package.json
```

### Module Responsibilities

**SimulationEngine.ts** — the heart of the application. Pure functions; takes typed array buffers and a config object, mutates the back buffer, returns nothing. Zero DOM dependencies. Fully unit-testable.

**SimulationWorker.ts** — owns the simulation tick loop (`setInterval`), receives config updates and grid edits via `postMessage`, posts the committed front buffer back to the main thread each tick.

**Renderer.ts** — receives a buffer snapshot (or `SharedArrayBuffer` view) and writes pixels into `ImageData`. Knows nothing about the UI.

**AppState.ts** — single source of truth for all non-simulation state (current tool, panel open/closed, zoom level, etc.). Components subscribe via `EventBus`.

**workerBridge.ts** — all `postMessage` calls are typed with a discriminated union `WorkerMessage` type. This prevents string-typed message protocols from becoming a maintenance burden.

### Data Flow

```
User Interaction
      |
  DrawingTools.ts  ──postMessage(EditCommand)──>  SimulationWorker
  Toolbar.ts       ──postMessage(SpeedChange)──>  SimulationWorker
  ControlPanel.ts  ──postMessage(ConfigUpdate)──> SimulationWorker
                                                        |
                                              SimulationEngine.tick()
                                                        |
                                         postMessage(BufferSnapshot) ──> RenderWorker
                                                                               |
                                                                      Renderer.render()
                                                                               |
                                                                     OffscreenCanvas frame
                                                                     (displayed in main thread)
```

---

## 8. Implementation Phases

### Phase 1 — MVP Core (Week 1–2)

Goal: A working simulation visible in the browser with no UI polish.

- Set up Vite + TypeScript project
- Implement `GridState.ts`: allocate double buffers, define cell types
- Implement `SimulationEngine.ts`: Life spread using simple neighbor check (no obstacles yet)
- Implement `Renderer.ts`: ImageData pixel write, Life = green, Empty = black
- Wire up `requestAnimationFrame` loop on main thread (no workers yet)
- Add Play/Pause button and Speed slider (basic HTML)
- Seed grid with random Life cells on load

Deliverable: Life cells spread across the grid. Play/pause/speed works.

### Phase 2 — Obstacles and Drawing (Week 3)

Goal: Users can draw on the canvas and obstacles affect life.

- Add Wall and Toxin cell types to the engine
- Implement canvas mouse event handlers for drawing (left-click paint, right-click erase)
- Add brush selector (Life, Wall, Toxin, Erase)
- Implement `obstacleRules.ts`: toxin energy damage, wall blocking
- Add Nutrient cell type with energy boost logic
- Color map all implemented types

Deliverable: Users can paint walls that block life and toxins that kill it.

### Phase 3 — Full Control Panel + All Parameters (Week 4)

Goal: All tunable sliders work and affect the simulation live.

- Build `ControlPanel.ts` with all life parameter sliders
- Implement `SimulationConfig.ts` with all parameters wired into engine rules
- Implement mutation and life variants (Variant B)
- Add overpopulation/underpopulation death rules
- Add neighborhood mode toggle (Moore vs Von Neumann)
- Add **Initial Density slider** (0–100%) — controls the fraction of cells seeded as Life on Reset; wired to the `seed(density, ...)` call in `App`
- Add Reset button
- Add Status Bar (tick count, FPS, live cell count)

Deliverable: All core parameters tunable; simulation behaves differently under different configs.

### Phase 4 — Web Worker Architecture (Week 5)

Goal: Simulation runs off the main thread; UI stays responsive at high tick rates.

- Move `SimulationEngine` into `SimulationWorker.ts`
- Implement `workerBridge.ts` typed message protocol
- Allocate `SharedArrayBuffer` for grid state (eliminates postMessage copy overhead)
- Move rendering to `RenderWorker.ts` with `OffscreenCanvas`
- Validate 60fps render + 60Hz simulation simultaneously without jank

Deliverable: No dropped frames at full speed.

### Phase 5 — Remaining Obstacle Types (Week 6)

Goal: Complete obstacle catalog from spec.

- Implement Drain, GravityWell, Repulsion Field, Current
- Implement Barrier (with decay timer)
- Implement Fire (spread + burnout)
- Implement Ice (dormancy)
- Add all new obstacle types to drawing tool selector
- Add obstacle parameter sliders to control panel
- Implement `OverlayRenderer.ts`: directional arrows for Current and GravityWell

Deliverable: Full obstacle catalog interactive.

### Phase 6 — Polish and UX (Week 7)

Goal: The application is pleasant and discoverable to use.

- Add zoom and pan (scroll wheel zoom, middle-drag pan)
- Add hover tooltip (cell info)
- Add grid line overlay toggle
- Add configuration presets (Classic GoL, Plague Mode, Ecosystem Balance)
- Add Snapshot (PNG export)
- Add keyboard shortcuts (Space = play/pause, R = reset, arrow keys in paused step)
- Responsive layout for different screen sizes

Deliverable: Polished, shareable application.

### Phase 7 — WebGL Renderer (Optional, Week 8+)

Goal: Support grids larger than 512x512 at full performance.

- Implement WebGL renderer as a drop-in replacement for the Canvas 2D renderer
- Use a texture per buffer (cellType, energy as separate textures)
- Fragment shader performs color mapping
- Enables 1024x1024+ grids at 60fps
- Grid size selector expanded to include 1024, 2048

Deliverable: Simulation scales to 4M+ cells.

---

## 9. Performance Considerations

### Core Loop Design

The simulation inner loop must allocate zero objects per tick. All cell state lives in pre-allocated `TypedArray` buffers. The update loop is a plain integer `for` loop walking the flat array index.

```typescript
// Target: zero allocations, no array methods, no closures in hot path
for (let i = 0; i < totalCells; i++) {
  // read from front buffer indices, write to back buffer indices
}
```

### SharedArrayBuffer Grid Transfer

Using `SharedArrayBuffer` for the grid state means the simulation worker writes the front buffer in-place and signals the render worker via an `Atomics`-based lock rather than copying the entire buffer each tick. At 512x512 with 8 bytes per cell, a naive `postMessage` copy costs ~2MB of serialization overhead per tick. `SharedArrayBuffer` eliminates this entirely.

### Dirty Region Rendering

Track a bounding box of cells changed in the last tick. Only redraw `ImageData` for the dirty rectangle rather than the entire canvas. At typical spread rates, the dirty region is much smaller than the full grid early in the simulation.

```typescript
let dirtyX0 = Infinity, dirtyY0 = Infinity, dirtyX1 = 0, dirtyY1 = 0;
// update dirty bounds during tick write phase
ctx.putImageData(imageData, dirtyX0, dirtyY0, 0, 0, dirtyWidth, dirtyHeight);
```

### Lookup Tables

The color mapping function is called once per cell per frame. Pre-compute a lookup table: a `Uint32Array[256 * 256]` indexed by `[cellType * 256 + energyQuantized]` storing the packed RGBA value. One array read per cell instead of a conditional chain.

### requestAnimationFrame Discipline

The render worker posts frames using `requestAnimationFrame` via the `OffscreenCanvas` context. The simulation worker runs on `setInterval` independently. If the simulation is running faster than 60Hz, the render worker simply renders the most recently committed buffer without blocking the simulation.

### Web Worker Thread Count

Two dedicated workers:
1. `SimulationWorker` — runs tick loop, responds to edit/config messages
2. `RenderWorker` — runs frame loop, reads shared buffer, writes canvas

The main thread handles only DOM events and message routing. This keeps the main thread's event loop free for UI responsiveness.

### WASM Consideration

If the simulation engine exceeds JavaScript performance limits (unlikely below 512x512), the inner loop of `SimulationEngine.ts` can be compiled to WebAssembly. The engine is already isolated from DOM and structured as pure typed-array functions — it is WASM-ready without architectural changes. This is a Phase 7+ consideration.

### Memory Budget (512x512 grid)

| Buffer | Size |
|---|---|
| cellType (Uint8) | 256 KB |
| energy x2 (Float32, double-buffered) | 2 MB |
| age (Uint16) | 512 KB |
| flags (Uint8) | 256 KB |
| ImageData pixel buffer | 1 MB (1024x1024 canvas at 2px cell) |
| Color LUT | 256 KB |
| **Total** | ~4.3 MB |

Well within browser memory constraints.

---

## 10. Future Extensibility

### Adding New Obstacle Types

The obstacle system is data-driven via the `CellType` enum and a rule dispatch table in `obstacleRules.ts`. Adding a new obstacle requires:

1. Add an entry to `CellType` enum
2. Add a case to `obstacleRules.ts` rule handler
3. Add an entry to `ColorMap.ts`
4. Add a button to the drawing tools UI
5. Optionally add config parameters to `SimulationConfig.ts`

No other files need modification. The core engine loop branches on `CellType` via a dispatch table, not a long switch statement.

### Adding New Life Variants

The mutation system already produces a second variant. The variant system generalizes: each variant is an index into a `VariantConfig[]` array. Adding a third variant is adding one config entry and one color map entry.

### Adding Visualization Modes

The renderer is fully decoupled from the simulation engine. Alternative renderers can be swapped in:

- **Heat map**: color by age instead of energy
- **Flow visualization**: render spread direction arrows as a vector field
- **Population graph**: overlay a live line chart of life count over time
- **3D Perspective**: a Three.js renderer reading the same `SharedArrayBuffer` grid

The `workerBridge.ts` protocol includes a `RenderMode` discriminant in the config message.

### Serialization and Sharing

`GridState` is fully serializable: two typed arrays and a config object. A "Save Scenario" feature serializes the current grid + config to a JSON blob. A URL-encoded preset can encode compact grid seeds. This requires no architectural change — just adding a `serialize()` / `deserialize()` function pair to `GridState.ts`.

### Multiplayer / Network Sync

The `SharedArrayBuffer` + typed message architecture is compatible with a future WebSocket sync layer. The simulation worker could optionally receive tick updates from a server instead of computing locally. The drawing tool commands are already structured as discrete `EditCommand` messages, which map directly to network events.

### Preset and Scenario System

`presets.ts` defines named `{ config, seed, obstacles }` tuples. New scenarios are pure data additions with no code changes. A scenario gallery UI can list and load presets without touching simulation logic.

---

## Summary: Concrete First Steps

1. `npm create vite@latest what-simulator -- --template vanilla-ts`
2. Create `src/simulation/GridState.ts` and `src/simulation/SimulationEngine.ts`
3. Create `src/rendering/Renderer.ts` with a simple ImageData loop
4. Wire main thread RAF loop in `src/main.ts`
5. Add a `<canvas>` and two `<button>` elements to `index.html`
6. Test: random life seed should spread visibly within minutes of starting

The architecture is designed so every phase produces a running, testable application. No phase requires the next phase to be useful.
