# Phase 18–22 — The "Alive" Update

---

## The Hook

Right now, you watch the What Simulator and you see *patterns*.

Blobs of colour grow, fragment, and die.  Genetic lineages radiate outward in
concentric rings.  Population charts climb and crash.  It's *interesting* — but
it doesn't make you lean forward.  It doesn't make you hold your breath.

What if it did?

What if you zoomed in and saw individual cells with *membranes*, *nuclei*,
*organelles* that vary by genome?  What if cells didn't just *spread* — they
*swam* toward food, *recoiled* from toxins, *huddled* together when afraid?
What if one lineage evolved into a pack of predators that *hunted* the others —
and the prey responded by *sporulating*, hiding in dormancy until the danger
passed, then blooming back to life?

That's what this update builds.

---

## Key Assumptions (Redirect Before Proceeding If Wrong)

1. We stay WebGL 2 — no WebGPU, no WASM
2. We stay on the existing SoA TypedArray architecture — no ECS migration
3. Visual fidelity > simulation accuracy — we favour things that *look* alive
4. Phase ordering is flexible — Phase 18 (visual) ships first because it's
   self-contained; later phases depend on it
5. Target 60fps at 512×512; graceful degradation at 1024×1024

---

## Table of Contents

1. [Aesthetic Design Direction](#1-aesthetic-design-direction)
2. [Performance Contract](#2-performance-contract)
3. [Psychological Engagement Model](#3-psychological-engagement-model)
4. [Phase 18 — Cell Morphology & Animation](#4-phase-18--cell-morphology--animation)
5. [Phase 19 — Motility & Chemotaxis](#5-phase-19--motility--chemotaxis)
6. [Phase 20 — Chemical Ecology](#6-phase-20--chemical-ecology)
7. [Phase 21 — Predator-Prey Dynamics](#7-phase-21--predator-prey-dynamics)
8. [Phase 22 — Particle Effects & Cinematic Polish](#8-phase-22--particle-effects--cinematic-polish)
9. [New Config Parameters](#9-new-config-parameters)
10. [New Cell Types](#10-new-cell-types)
11. [Buffer Architecture](#11-buffer-architecture)
12. [Render Mode Additions](#12-render-mode-additions)
13. [New Life & Environment Presets](#13-new-life--environment-presets)
14. [UI/UX Changes](#14-uiux-changes)
15. [Test Plan](#15-test-plan)
16. [Risk & Mitigation](#16-risk--mitigation)

---

## 1. Aesthetic Design Direction

**Design Stance: Wet Lab Brutalism**

The aesthetic is a fluorescence microscope slide — not a game, not a dashboard.
Think of a paper in *Nature Cell Biology*: clean dark background, vivid cell
bodies lit from within, chemical gradients glowing like bioluminescence.

**Design Feasibility & Impact Index (DFII):**

| Dimension | Score (1–5) | Rationale |
|---|---|---|
| Aesthetic Impact | 5 | Biomicroscopy has an immediately recognisable, non-generic look |
| Context Fit | 5 | It *is* a cell simulator — this is the natural aesthetic |
| Implementation Feasibility | 4 | GLSL sub-cell rendering is straightforward at cellSize ≥ 4 |
| Performance Safety | 3 | Sub-cell math adds ~0.5ms/frame; must stay optional on mobile |
| Consistency Risk | 2 | One aesthetic across all modes is easy to maintain |

**DFII = (5 + 5 + 4 + 3) − 2 = 15 — Execute Fully**

**Differentiation Anchor:**
> "If this were screenshotted with the logo removed, you would say
>  *'that's a fluorescence micrograph'* — not *'that's a JavaScript game'*."

**CSS Variables (new tokens for the UI skin):**
```css
:root {
  --c-substrate:   #0a0d0f;   /* near-black background — petri dish dark */
  --c-gel:         #111820;   /* panel background — wet-mount gel tone */
  --c-membrane:    #1e3040;   /* border/divider — frosted glass edge */
  --c-text:        #c8dde8;   /* primary text — cool clinical white */
  --c-accent-life: #00ff88;   /* life green — fluorescent dye green */
  --c-accent-warn: #ff6030;   /* alarm / predator orange-red */
  --c-accent-chem: #00eeff;   /* chemical field cyan — GFP bioluminescence */
}
```

**Typography (ControlPanel):**
- Display labels: `JetBrains Mono` (monospace — instrument readout aesthetic)
- Body copy: `system-ui` (neutral, readable)
- No serifs, no rounded sans-serifs — this is a lab instrument

---

## 2. Performance Contract

Simulation ticks run in a dedicated Web Worker — they own their own CPU time.
All render work runs in the Render Worker.  The main thread only routes events.

**Target: 60fps render @ 512×512, ≥ 30fps render @ 1024×1024**

| Render Worker Budget (per frame at 60fps = 16.67ms) | Budget |
|---|---|
| SAB read + seqlock validation | 0.5ms |
| Texture uploads (cellType, energy, genome × 8 channels) | 1.5ms |
| Background pass (WebGL procedural) | 1.0ms |
| Scene pass (fragment shader — cell rendering) | 3.0ms |
| Chemical diffusion pass (GPU ping-pong) | 2.0ms |
| Bloom extraction pass | 1.5ms |
| Gaussian blur passes × 2 | 2.0ms |
| Composite pass (AO + DoF + tonemap + particles) | 2.5ms |
| Particle transform-feedback update | 1.0ms |
| **Buffer total** | **1.17ms** |

**Simulation Worker Budget (per tick):**

| System | Budget |
|---|---|
| Core spread + energy decay | 4ms |
| Motility + chemotaxis velocity update | 2ms |
| Chemical secretion | 1ms |
| Predator/prey attack pass | 1ms |
| Spore state transitions | 0.5ms |
| SAB write (seqlock) | 0.5ms |
| **Total** | **9ms** |

Leaves headroom for variable tick rates (20–60 TPS).

**Object Pooling Rules:**
- Particle pool: fixed 65 536 entries allocated once at init — no GC
- Neighbour scratch buffers: pre-allocated in `SimulationEngine` constructor — unchanged
- Chemical gradient temp arrays: ping-pong reuse — no allocation per tick
- Do NOT create any object inside the tick loop or the render hot path

---

## 3. Psychological Engagement Model

*Why does this make the observer compulsively watch?*

Drawing from scarcity/urgency psychology and social proof mechanics, we can
identify the engagement hooks baked into each phase:

### 3.1 Loss Aversion (Phase 18 + 21)

Watching a cell's membrane *visually break apart* as it dies triggers loss aversion
— observers feel the loss, not just observe a colour change.  A predator *eating*
prey creates a visceral moment the viewer wants to prevent.

**Design rule:** Death should look like death.  Division should look like birth.
Do not soften or abstract these events.

### 3.2 Genuine Scarcity (Phase 21 — Spores)

When prey sporulate, there are only a *finite number* of dormant spores that can
revive.  Each spore has a timer (`sporeLifetime` ticks).  If alarm persists too
long, the spore dies permanently — that genome is gone forever.

This creates **real scarcity**: the evolutionary line is genuinely at risk of
permanent extinction.  The observer knows it.  They watch because the outcome is
uncertain and the loss would be real within the simulation.

**Design rule:** Show the spore timer as a very slow visual pulse decay.  No UI
number — just a colour that fades.  Let the observer infer the urgency.

### 3.3 Social Proof Through Population (Phase 20 + 21)

The population chart provides outcome-based social proof that the simulation is
*working*: predator curves chase prey curves in sinusoidal waves.  Diversity
metrics confirm evolution is happening.  These numbers mean something — they are
not decorative.

**Design rule:** Place population context next to major events.
When a new variant speciation event fires, briefly highlight it in the chart.
Let the data narrate what just happened.

### 3.4 Intrinsic Urgency — The Alarm Signal (Phase 20)

When a dying cell emits alarm pheromone, nearby cells face a real trade-off:
flee (motility cost + energy) or stay (risk predation/toxin).  The observer sees
this play out as a ripple of "panic" spreading through the colony.

This is **real urgency** inside the simulation world — not manufactured.  The
cells respond to a genuine threat.  The viewer becomes invested in the outcome
because the stakes are visible.

---

## 4. Phase 18 — Cell Morphology & Animation

**Vision:** Every cell looks like a biological cell.  From a distance, colonies
look like tissue samples.  Zoomed in, individual cells have membranes, nuclei,
and organelles that vary per genome.

**Done When:**
- [ ] Life cells render as circles with distinct membrane ring, not squares
- [ ] Each cell pulses at an energy-proportional rate
- [ ] Cells flash white briefly on division (JUST_DIVIDED flag)
- [ ] Dying cells (energy < 0.05) show a visibly breaking membrane
- [ ] Senescent cells have enlarged, fragmented-looking nucleus
- [ ] Organelle dot positions vary by genome value (siblings look similar; distant
      relatives look different)
- [ ] `u_aliveDetail` uniform at 0.0 renders flat squares (legacy compat)
- [ ] New `morphology` render mode (7) shows anatomy without energy tinting
- [ ] All changes are GLSL-only; zero new TypedArray buffers
- [ ] Existing 512 tests still pass; new tests: JUST_DIVIDED flag lifecycle

### 4.1 Sub-Cell Rendering Layers (GLSL)

The fragment shader already receives `gl_FragCoord`.  Divide by `u_cellSize` and
`fract()` to get sub-cell UV coordinates `uv ∈ [0, 1]²`:

```glsl
// Sub-cell coordinate: (0.5, 0.5) = cell centre
vec2 cellUV = fract(gl_FragCoord.xy / u_cellSize);
vec2 c      = cellUV - 0.5;  // centred on origin
float r     = length(c);
float angle = atan(c.y, c.x);

// --- Layer 1: Outer membrane ring ---
float membraneOuter = 0.46;
float membraneInner = 0.36;
float membraneMask  = smoothstep(membraneOuter, membraneOuter - 0.02, r)
                    * smoothstep(membraneInner, membraneInner + 0.02, r);

// --- Layer 2: Cell body ---
float bodyMask = smoothstep(0.48, 0.30, r);

// --- Layer 3: Nucleus (life cells only) ---
// Offset from centre slightly; position seeded from genome bits
vec2  nucleusPos  = vec2(
  float((genome >> 12u) & 0x7u) / 14.0 * 0.20 - 0.10,
  float((genome >>  9u) & 0x7u) / 14.0 * 0.20 - 0.10
);
float nucleusR    = length(c - nucleusPos);
float nucleusSz   = isSenescent ? 0.19 : 0.12;  // enlarged in senescence
float nucleusMask = smoothstep(nucleusSz, nucleusSz - 0.02, nucleusR);

// --- Layer 4: Organelle dots (3 dots, positions from genome) ---
for (int i = 0; i < 3; i++) {
  float ox = float((genome >> uint(i * 4))       & 0xFu) / 15.0 * 0.34 - 0.17;
  float oy = float((genome >> uint(i * 4 + 16))  & 0xFu) / 15.0 * 0.34 - 0.17;
  float or_ = length(c - vec2(ox, oy));
  organelleMask += smoothstep(0.05, 0.03, or_);
}

// --- Layer 5: Energy pulse scale ---
float cellPhase = float(cellIdx) * 0.37;  // golden-angle phase stagger
float pulseFreq = isJuvenile ? 2.0 : (isSenescent ? 0.4 : 1.0);
float pulse     = 0.5 + 0.5 * sin(float(u_time) * 0.08 * pulseFreq + cellPhase);
float bodyScale = 0.95 + 0.05 * pulse * energy;
bodyMask        = smoothstep(0.48, 0.30 / bodyScale, r);

// --- Layer 6: Division flash (JUST_DIVIDED flag bit 5) ---
float divFlash = isJustDivided ? 2.5 : 1.0;  // feeds bloom

// --- Layer 7: Death membrane breakdown ---
float breakNoise = fract(sin(angle * 7.3 + float(genome) * 0.001) * 43758.5);
float membraneFade = smoothstep(0.0, 0.3, energy) + 0.3 * breakNoise;
membraneMask *= mix(1.0, membraneFade, step(energy, 0.08));
```

### 4.2 Obstacle Reskinning

| Obstacle | New Visual Pattern |
|---|---|
| **Toxin** | Droplet shape: body + concentric poison rings (`sin(r × 25.0)` stripe) |
| **Nutrient** | Bright glowing pellet: solid circle with 2× radial intensity at centre |
| **Fire** | 8 radial spikes via `sin(angle × 8 + time × 3.0)` + animated inner ring |
| **Ice** | Hexagonal lattice: `cos(c.x × 12) + cos(c.y × 12) > 1.6` pattern |
| **Colony** | Honeycomb: hexagonal cell-wall grid inscribed in the cell |
| **RadioWaste** | Trefoil radiation symbol: 3 lobes via `cos(angle × 3)` mask |
| **Mutagen** | Two interlocking rings: `abs(length(c - p1) - 0.18)` + same for p2 |

### 4.3 Extracellular Matrix (Empty Cells)

Empty cells currently show the background.  We add a very faint fibrous texture:
```glsl
// Barely-visible fibrous matrix for empty cells
float matrix = 0.04 * fbm(cellUV * 6.0 + u_time * 0.0003);
if (cellType == EMPTY && u_aliveDetail > 0.5) {
  outColor = vec4(0.05, 0.07, 0.06, matrix);  // near-transparent green-grey
}
```

### 4.4 New Flag

`CellFlags.JUST_DIVIDED = 1 << 5` — set in `SimulationEngine.ts` on parent cell
after successful spread; cleared at the start of the next tick.

### 4.5 New Render Mode

Mode 7 — **morphology**: renders anatomy layers with flat base colours (no
energy modulation).  Best for inspecting sub-cell structure.

### 4.6 Implementation Tasks (ordered)

- [ ] Add `CellFlags.JUST_DIVIDED = 0x20` to `GridState.ts`
- [ ] Set/clear JUST_DIVIDED in `SimulationEngine.ts`
- [ ] Add `u_aliveDetail: float` + `u_time: int` uniforms to `WebGLRenderer.ts`
- [ ] Implement sub-cell GLSL layers in `FRAG_SRC`
- [ ] Implement obstacle reskin GLSL
- [ ] Add empty-cell matrix GLSL (gated on `u_aliveDetail > 0.5`)
- [ ] Add render mode 7 to `RenderMode` enum and shader
- [ ] Add `aliveDetail` slider to `ControlPanel.ts`
- [ ] Tests: JUST_DIVIDED flag set/cleared; shader compiles; visual regression

---

## 5. Phase 19 — Motility & Chemotaxis

**Vision:** Some cells *move*.  They swim toward food, recoil from danger, drift
with Brownian noise.  Watching a motile colony feels like watching real bacteria.

**Done When:**
- [ ] Cells with `spreadBonus > motilityThreshold` migrate to adjacent empty cells
- [ ] Velocity persists across ticks and damps by `motilityDamping`
- [ ] Chemotaxis biases velocity toward nutrient cells (positive)
- [ ] Chemotaxis biases velocity away from toxin cells (negative)
- [ ] Velocity reflected off impassable obstacle normals
- [ ] Migration cancelled (not duplicated) if target is occupied
- [ ] Motile cells render a small flagellum arc trailing behind them
- [ ] `vx`, `vy` Float32Arrays added to `GridBuffers` and `GridState`
- [ ] New config params wired to sliders in ControlPanel
- [ ] Tests: velocity damping correctness; migration → Empty; collision → cancel; reflect off wall

### 5.1 Velocity Buffers

Two new Float32Arrays in `GridBuffers`:
```typescript
vx: Float32Array;  // X velocity in grid-units/tick  (double-buffered)
vy: Float32Array;  // Y velocity in grid-units/tick  (double-buffered)
```

### 5.2 Migration Logic (SimulationEngine — after spread pass)

```
For each Life cell i:
  if phenotype.spreadBonus[i] < motilityThreshold → skip
  if random() > motilityRate → skip
  crowding = liveNeighbours[i] / 8.0
  if random() < crowding → skip  (too crowded to move)

  // Chemotaxis gradient from existing signalStrength + neighbour types
  dSx = signal[right] - signal[left]
  dSy = signal[up] - signal[down]
  // Nutrient attraction
  for each Nutrient within 3 cells: vx += nutrientAbs × dx / dist²
  // Toxin repulsion
  for each Toxin within 3 cells: vx -= toxinResist × dx / dist²

  vx[i] += chemotaxisWeight × dSx × chemotaxisMotilityFraction
  vy[i] += chemotaxisWeight × dSy × chemotaxisMotilityFraction

  // Damping
  vx[i] *= (1 - motilityDamping)
  vy[i] *= (1 - motilityDamping)

  // Clamp magnitude to 1 grid-unit/tick
  mag = sqrt(vx² + vy²)
  if mag > 1.0: vx /= mag; vy /= mag

  // Determine target cell from velocity direction
  targetIdx = i + round(vx) + round(vy) × width

  if cellType[targetIdx] == Empty:
    migrate: front[targetIdx] = front[i]; front[i] = Empty
  else if isImpassable(targetIdx):
    reflect velocity off obstacle normal
```

### 5.3 Smooth Motion Rendering

Upload `vx`, `vy` as R32F textures.  The render worker increments a sub-tick
fraction `f ∈ [0, 1]` between ticks (based on actual elapsed time).  Fragment
shader offsets the texture lookup by `(vx × f, vy × f)` so cells appear to
glide smoothly between positions.

### 5.4 Flagellum (GLSL)

```glsl
// Only rendered when velocity magnitude > 0.1 and aliveDetail > 0.5
float vMag = length(vec2(vx, vy));
if (cellType == LIFE && vMag > 0.1 && u_aliveDetail > 0.5) {
  vec2 flagDir = normalize(-vec2(vx, vy));  // opposite to motion
  float flagAngle = atan(flagDir.y, flagDir.x);
  float pointAngle = atan(c.y, c.x);
  float align = cos(pointAngle - flagAngle);
  float flagMask = smoothstep(0.8, 1.0, align) * smoothstep(0.50, 0.38, r);
  // Taper: thinner at tip
  float taper = (r - 0.38) / 0.12;
  flagMask *= (1.0 - taper * 0.7) * vMag;
  baseColour.rgb = mix(baseColour.rgb, vec3(0.9), flagMask * 0.6);
}
```

### 5.5 New Config Fields

```typescript
motilityRate: number;                   // default 0.0 (disabled)
motilityThreshold: number;              // default 0.3
motilityDamping: number;                // default 0.2
chemotaxisMotilityFraction: number;     // default 0.5
```

---

## 6. Phase 20 — Chemical Ecology

**Vision:** The grid is soaked in invisible chemistry.  Food gradients attract
swarms.  Waste zones form dead regions cells avoid.  Pheromones bind kin into
colonies.  Alarm pheromone triggers panicked flight.  Toggle a render mode and
watch the chemistry — it's beautiful.

**Done When:**
- [ ] 4 chemical channels (N, W, P, A) diffuse via GPU ping-pong pass
- [ ] Life cells secrete W (waste) and P (pheromone) each tick
- [ ] Nutrient cells emit into N channel; dying cells emit into A channel
- [ ] Multi-channel chemotaxis updates `vx`, `vy` each tick
- [ ] Quorum behaviour activates when local P > quorumThreshold
- [ ] Biofilm mode: quorum cells stop spreading, gain energy bonus
- [ ] Synchronized pulse: quorum cells pulse same phase
- [ ] 4 new render modes (8–11) show each chemical channel
- [ ] Chemical overlay toggle blends selected channel over cell view
- [ ] Tests: diffusion conserves mass (within decay tolerance); secretion fires; quorum activates

### 6.1 Chemical Channels

| Channel | Buffer Name | Semantic | Primary Emitter |
|---|---|---|---|
| N — Nutrient | `chemNutrient` | Food signal | Nutrient cells |
| W — Waste | `chemWaste` | Metabolic exhaust | Life cells (proportional to energy consumed) |
| P — Pheromone | `chemPheromone` | Kin signal | Life cells (proportional to energy × variantId weight) |
| A — Alarm | `chemAlarm` | Danger signal | Dying cells (energy < 0.1) + Toxin neighbours |

### 6.2 Diffusion GPU Pass

Ping-pong framebuffer in `RenderWorker.ts`:
```glsl
// diffusion.frag — run once per simulation tick for each channel
uniform sampler2D u_chem;        // current chemical field
uniform float u_diffRate;        // e.g. 0.08
uniform float u_decay;           // e.g. 0.03

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float C    = texture(u_chem, uv).r;
  float up   = texture(u_chem, uv + vec2(0, 1)/u_resolution).r;
  float down = texture(u_chem, uv + vec2(0,-1)/u_resolution).r;
  float left = texture(u_chem, uv + vec2(-1,0)/u_resolution).r;
  float rgt  = texture(u_chem, uv + vec2( 1,0)/u_resolution).r;
  float laplacian = up + down + left + rgt - 4.0 * C;
  outColor = vec4(clamp(C + u_diffRate * laplacian - u_decay * C, 0.0, 1.0));
}
```

### 6.3 Chemotaxis Update (SimulationEngine)

```typescript
// Multi-channel gradient following — runs after chemical secretion pass
const dNx = chemNutrient[right] - chemNutrient[left];
const dWx = chemWaste[right]    - chemWaste[left];
const dPx = chemPheromone[right] - chemPheromone[left];
const dAx = chemAlarm[right]    - chemAlarm[left];

vx[i] += nutrientChemotaxis * dNx
       + pheromoneChemotaxis * dPx
       - wasteAvoidance      * dWx
       - alarmFlight         * dAx;
// Same for Y axis
```

### 6.4 Quorum Sensing

```typescript
// For each Life cell, sum pheromone in 5×5 neighbourhood
const localP = sampleChemical(chemPheromone, i, 2);  // 5×5 sample
const quorumActive = localP > quorumThreshold;

if (quorumActive) {
  // Biofilm: suppress spreading
  effectiveSpreadRate *= 0.1;
  // Shared energy: gain quorumActivationEnergy × dt from colony
  energy[i] += quorumActivationEnergy * 0.01;
  // Phase-lock: override pulse phase to be synchronised in shader
  flags[i] |= CellFlags.QUORUM_ACTIVE;  // new flag bit 6
}
```

### 6.5 New Config Fields

```typescript
wasteSecretionRate: number;         // default 0.01
pheromoneSecretionRate: number;     // default 0.05
nutrientChemotaxis: number;         // default 0.3
pheromoneChemotaxis: number;        // default 0.2
wasteAvoidance: number;             // default 0.15
alarmFlight: number;                // default 0.4
chemicalDiffusionRate: number;      // default 0.08
chemicalDecayRate: number;          // default 0.03
quorumActivationEnergy: number;     // default 1.5
```

---

## 7. Phase 21 — Predator-Prey Dynamics

**Vision:** Some variants evolve the ability to *hunt* others.  Prey panic and
flee.  Some sporulate.  Population charts show sinusoidal predator-prey waves.
It's the most dramatic thing you can watch in a cell simulator.

**Done When:**
- [ ] Life cells with genome ≥ `predatorGenomeThreshold` are classified as predators
- [ ] Predators can spread INTO adjacent prey cells (consuming them, gaining energy)
- [ ] Predator attack probability scales with predator genome vs prey toxinResist
- [ ] Predators secrete A (alarm) pheromone continuously
- [ ] Prey with high `alarmFlight` bias velocity away from predators
- [ ] `CellType.Spore = 16` added to GridState
- [ ] Sporulation: Life cell at energy < 0.03 AND local alarm > 0.2 → becomes Spore
- [ ] Spores: zero energy decay, impassable to predators, survive `sporeLifetime` ticks
- [ ] Spore revival: alarm = 0 AND neighbour life energy ≥ 0.3 → Life restores
- [ ] Predators rendered with spiky membrane and deep red tint
- [ ] Spores rendered as brown thick-walled circles with fading pulse
- [ ] Render mode 12 (predprey) shows predator/prey/spore classification
- [ ] PopulationChart gains predator/prey split time-series
- [ ] Tests: attack probability; spore production; spore no-decay; revival; starvation death

### 7.1 Predator Classification

Predator phenotype is derived from the genome — it is not a separate cell type:
```typescript
const isPredator = genome[i] >= config.predatorGenomeThreshold;
```

This means cells can evolve *into* and *out of* predator phenotype through mutation,
creating the arms-race dynamics.

### 7.2 Attack Logic (SimulationEngine — Behavior Tree)

The predator decision tree each tick:
```
PREDATOR TICK
  ├── SEQUENCE: Can I hunt right now?
  │     ├── Is my energy > reproductionThreshold?  (not starving)
  │     └── Do I have adjacent prey?
  │           └── SUCCESS → ATTACK
  │                 probability = predatorAttackStrength × (1 - prey.toxinResist)
  │                 on HIT: prey → Empty; predator gains predatorFeedEnergy
  │                         spread predator into vacated cell
  │                 on MISS: nothing
  │
  ├── SELECTOR: Can I move toward prey?
  │     ├── Follow alarm gradient toward source (alarm = prey panic signal)
  │     └── Follow pheromone gradient away from same-variant signal
  │
  └── FALLBACK: Normal metabolic tick
        └── Decay × predatorEnergyDecayMultiplier  (hungry predators die fast)
```

### 7.3 Spore Type

```typescript
export const enum CellType {
  // ... existing 0-15 ...
  Spore = 16,
}
```

Spore state in `GridState`:
- `cellType[i] = Spore`
- `energy[i]` = frozen at entry value (no decay)
- `flags[i]` = original Life flags preserved
- `genome[i]` = preserved (critical: genome must survive dormancy)
- `age[i]` continues counting → spore dies at `age - sporulationAge > sporeLifetime`

### 7.4 Visual Differentiation (GLSL)

**Predator cells:**
```glsl
// Spiky membrane: modulate radius by fast angular oscillation
float spikes = 0.04 * sin(angle * 8.0 + float(u_time) * 0.15);
float predatorRadius = 0.42 + spikes * isPredator;
// Deep red tint: shift hue toward red proportional to genome
baseColour = mix(baseColour, vec3(1.0, 0.12, 0.05), predatorTint * 0.6);
```

**Spore cells:**
```glsl
// Thick walled circle: triple membrane width
float sporeMembrane = smoothstep(0.48, 0.44, r) * smoothstep(0.28, 0.34, r);
// Brown fill
vec3 sporeColour = vec3(0.40, 0.25, 0.10);
// Fading slow pulse = time-to-death visual (cannot easily quantify life remaining)
float sporePulse = 0.85 + 0.15 * sin(float(u_time) * 0.02 + float(cellIdx) * 0.37);
sporeColour *= sporePulse;
```

### 7.5 Population Chart Extension

`PopulationChart.ts` gains a `mode: 'standard' | 'predprey'` toggle.  In
predprey mode, it plots two time-series on the same chart:
- Predator population: vivid red line
- Prey population: teal line
- Axis: time (ticks); Y: cell count

The Lotka-Volterra sinusoidal phase relationship should be visually obvious
in a healthy predator-prey simulation.

### 7.6 New Config Fields

```typescript
predatorGenomeThreshold: number;          // default 0 (disabled)
predatorFeedEnergy: number;               // default 0.4
predatorAttackStrength: number;           // default 0.3
predatorSpreadRate: number;               // default 0.6
predatorEnergyDecayMultiplier: number;    // default 1.8
sporeLifetime: number;                    // default 500 ticks
```

---

## 8. Phase 22 — Particle Effects & Cinematic Polish

**Vision:** The canvas feels like a living world.  Nutrient sparks drift from food
sources.  Cells burst into white light when they divide.  Predator strikes scatter
red fragments.  Spores crack open with brown debris.  Depth of field makes clusters
feel three-dimensional.  This phase is pure "game juice" — it changes nothing in
the simulation, but changes *everything* about how it feels.

**Done When:**
- [ ] GPU particle pool (65 536 particles) implemented via transform-feedback
- [ ] 7 particle types emitting at correct trigger events
- [ ] Particles feed into HDR framebuffer (bloom-amplified bright particles)
- [ ] Slime trail texture: motile cells leave a variant-coloured wake that decays
- [ ] Ambient occlusion pass: interior cells of clusters are visibly darker
- [ ] Depth of field: blur radius increases with distance from canvas centre
- [ ] Chromatic aberration: RGB channel offset at canvas edges
- [ ] Vignette: radial darkening at canvas perimeter
- [ ] All polish effects toggleable individually in ControlPanel
- [ ] Particles auto-disabled on hardware with `navigator.hardwareConcurrency < 4`
- [ ] Tests: particle pool never overflows; emitters fire at correct events; AO darkens interior cells

### 8.1 Particle System (Transform Feedback)

```typescript
// 9 floats per particle: [x, y, vx, vy, life, type, r, g, b]
const PARTICLE_STRIDE = 9;
const PARTICLE_COUNT  = 65_536;

// Two VBOs: pingBuffer ↔ pongBuffer (swap each frame)
// Transform feedback reads from ping, writes to pong
```

Update shader (transform feedback):
```glsl
// Particle update — runs as vertex shader writing to transform feedback buffer
life -= 0.016;
x += vx + 0.3 * hash1(vec2(x + float(u_time), y)) - 0.15;  // Brownian
y += vy;
vy -= 0.0002;   // gentle gravity
vx *= 0.96;
vy *= 0.96;
```

**7 Particle Types:**

| Type | Trigger | Behaviour | Visual |
|---|---|---|---|
| 0 — **Nutrient drift** | Nutrient cell each frame | Float slowly upward | Tiny teal spark |
| 1 — **Division flash** | JUST_DIVIDED flag | Radial burst, fast decay | White sparks |
| 2 — **Death exhaust** | Cell death | Rise slowly, fade | Dark grey wisps |
| 3 — **Pheromone trail** | Motile cells (behind) | Follow wake, slow fade | Faint variant-colour |
| 4 — **Signal pulse** | Colony cell tick | Expand radially | Cyan ring particles |
| 5 — **Predator strike** | Successful predation | Splatter pattern | Red burst fragments |
| 6 — **Spore crack** | Spore revival | Shell-break radial | Brown fragments |

### 8.2 Slime Trails

A separate `R8G8B8A8` trail texture (same size as grid canvas) is maintained:
```typescript
// When a motile cell vacates position (x, y):
trailTex[x][y] = variantColour(variantId) × 0.8;
// Each render frame: trail *= 0.92 (decay pass)
```

Trail texture composited under the cell layer, additive blend.

### 8.3 Ambient Occlusion (GLSL — Fragment Shader)

```glsl
// Count live neighbours from cellType texture
int liveNeighbours = 0;
for each 8 Moore neighbours:
  if cellType[neighbour] == LIFE || cellType[neighbour] == SPORE: liveNeighbours++;

float occupancy = float(liveNeighbours) / 8.0;
float edgeness  = 1.0 - occupancy;  // edge cells have few live neighbours
float ao        = 1.0 - 0.35 * occupancy * (1.0 - smoothstep(0.0, 0.3, edgeness));
baseColour.rgb *= ao;
```

### 8.4 Cinematic Effects (Composite Pass)

**Depth of Field:**
```glsl
vec2 fromCentre = abs(uv - 0.5);
float blurRadius = max(0.0, dot(fromCentre, fromCentre) * 12.0 - 0.5);
// Hexagonal 9-tap sample with blurRadius offset
```

**Chromatic Aberration:**
```glsl
vec2 ab = (uv - 0.5) * 0.003;
float r = texture(u_hdr, uv + ab).r;
float g = texture(u_hdr, uv).g;
float b = texture(u_hdr, uv - ab).b;
```

**Vignette:**
```glsl
float vignette = 1.0 - 0.45 * smoothstep(0.45, 1.0, length(uv - 0.5));
outRgb *= vignette;
```

### 8.5 UI Toggles

New "Cinematic" section in `ControlPanel.ts` (collapsible):
- **Cell Detail** slider (0–100%) — `u_aliveDetail`
- **Particles** checkbox — enables particle VBO draw calls
- **Trails** checkbox — enables slime trail texture
- **Ambient Occlusion** checkbox — enables AO in fragment shader
- **Depth of Field** checkbox — enables DoF in composite pass
- **Chromatic Aberration** checkbox — enables CA in composite pass
- **Vignette** checkbox — enables vignette in composite pass

All default on; auto-off on low-end hardware detection.

---

## 9. New Config Parameters

Complete list of new `SimulationConfig` fields across all phases:

| Field | Phase | Default | Range |
|---|---|---|---|
| `aliveDetail` | 18 | 1.0 | [0, 1] |
| `motilityRate` | 19 | 0.0 | [0, 1] |
| `motilityThreshold` | 19 | 0.3 | [0, 1] |
| `motilityDamping` | 19 | 0.2 | [0, 1] |
| `chemotaxisMotilityFraction` | 19 | 0.5 | [0, 1] |
| `wasteSecretionRate` | 20 | 0.01 | [0, 0.1] |
| `pheromoneSecretionRate` | 20 | 0.05 | [0, 0.2] |
| `nutrientChemotaxis` | 20 | 0.3 | [0, 2] |
| `pheromoneChemotaxis` | 20 | 0.2 | [0, 2] |
| `wasteAvoidance` | 20 | 0.15 | [0, 2] |
| `alarmFlight` | 20 | 0.4 | [0, 2] |
| `chemicalDiffusionRate` | 20 | 0.08 | [0, 0.25] |
| `chemicalDecayRate` | 20 | 0.03 | [0, 0.2] |
| `quorumActivationEnergy` | 20 | 1.5 | [1, 4] |
| `predatorGenomeThreshold` | 21 | 0 | [0, 65535] |
| `predatorFeedEnergy` | 21 | 0.4 | [0, 1] |
| `predatorAttackStrength` | 21 | 0.3 | [0, 1] |
| `predatorSpreadRate` | 21 | 0.6 | [0, 1] |
| `predatorEnergyDecayMultiplier` | 21 | 1.8 | [1, 5] |
| `sporeLifetime` | 21 | 500 | [50, 2000] |

**Total new: 20 fields — new total SimulationConfig fields: ~61**

---

## 10. New Cell Types

| ID | Name | Phase | Description |
|---|---|---|---|
| 16 | `Spore` | 21 | Dormant Life cell — zero decay, impassable to predators, genome preserved, revives when safe |

---

## 11. Buffer Architecture

### New Simulation Buffers

| Buffer | Type | Size @ 512×512 | Double-buffered? |
|---|---|---|---|
| `vx` | Float32Array | 1 048 576 B | Yes |
| `vy` | Float32Array | 1 048 576 B | Yes |
| `chemNutrient` | Float32Array | 1 048 576 B | Yes (ping-pong on GPU) |
| `chemWaste` | Float32Array | 1 048 576 B | Yes |
| `chemPheromone` | Float32Array | 1 048 576 B | Yes |
| `chemAlarm` | Float32Array | 1 048 576 B | Yes |

The 4 chemical channels are diffused on the GPU (ping-pong FBO) but their
*secretion values* are written by the simulation worker and transferred via SAB.

**Total addition:** ~12.6 MB (SAB must be resized accordingly)
**New total:** ~29 MB at 512×512 — well within browser constraints

---

## 12. Render Mode Additions

| Mode | Name | Phase | What It Shows |
|---|---|---|---|
| 7 | `morphology` | 18 | Sub-cell anatomy: membrane, nucleus, organelles (no energy tint) |
| 8 | `nutrient-field` | 20 | Nutrient (N) channel: blue → green heat map |
| 9 | `waste-field` | 20 | Waste (W) channel: yellow → red heat map |
| 10 | `pheromone-field` | 20 | Pheromone (P) channel: purple gradient, variant-tinted |
| 11 | `alarm-field` | 20 | Alarm (A) channel: orange urgent glow |
| 12 | `predprey` | 21 | Predators red / prey teal / spores brown |

**Total render modes after update: 13**

---

## 13. New Life & Environment Presets

### Life Presets

| Name | Theme | Key Distinguishing Values |
|---|---|---|
| `swimmingBacteria` | Fast motile cells chasing nutrients | motilityRate: 0.6, nutrientChemotaxis: 0.8 |
| `biofilmColony` | Quorum-triggered biofilm formation | quorumThreshold: 0.4, quorumActivationEnergy: 2.0 |
| `predatorPack` | High-genome predator lineage | predatorGenomeThreshold: 48000, predatorEnergyDecayMultiplier: 2.5 |
| `evasivePrey` | Alarm-reactive prey with spore dormancy | alarmFlight: 0.8, sporeLifetime: 800 |
| `armsRaceArena` | Mixed predator/prey co-evolution | predatorGenomeThreshold: 32000, pointMutationRate: 0.008 |
| `chemicalGarden` | Dense multi-channel chemistry | all chem rates × 2.5; chemical overlay default on |
| `swarmIntelligence` | Coordinated kin swarms via pheromone | pheromoneChemotaxis: 0.7, quorumThreshold: 0.2 |
| `sporeWasteland` | Hostile environment; dormancy survival | high alarm baseline, sporeLifetime: 1200 |

### Environment Presets

| Name | Theme | Obstacle Pattern | Paired Life |
|---|---|---|---|
| `huntingGrounds` | Open plains, predator-prey | Scattered nutrients, few obstacles | `armsRaceArena` |
| `chemicalBog` | Nutrient-rich swamp | Dense nutrients + waste zones | `chemicalGarden` |
| `predatorCorridor` | Channelled hunting terrain | River-of-walls corridors | `predatorPack` |
| `dormancyDesert` | Hostile; periodic nutrient blooms | Scattered toxins, isolated nutrient clusters | `sporeWasteland` |

---

## 14. UI/UX Changes

### 14.1 Render Mode Selector

Extend the existing mode `<select>` to group modes:
```html
<optgroup label="Cell View">
  <option value="0">Default</option>
  <option value="1">Lifecycle</option>
  <option value="2">Variant ID</option>
  <option value="7">Morphology</option>
  <option value="12">Predator/Prey</option>
</optgroup>
<optgroup label="Genetics">
  <option value="3">Genome</option>
  <option value="4">Generation</option>
  <option value="5">Fitness</option>
</optgroup>
<optgroup label="Chemical Fields">
  <option value="6">Signal</option>
  <option value="8">Nutrient Field</option>
  <option value="9">Waste Field</option>
  <option value="10">Pheromone Field</option>
  <option value="11">Alarm Field</option>
</optgroup>
```

### 14.2 New "Cinematic" Panel Section

Collapsible section in `ControlPanel.ts`:
```
[Cinematic ▼]
  Cell Detail: ════════════████ 80%
  [✓] Particles
  [✓] Motion Trails
  [✓] Ambient Occlusion
  [ ] Depth of Field
  [ ] Chromatic Aberration
  [✓] Vignette
```

Uses the established CSS custom properties for consistent "Wet Lab Brutalism"
aesthetic.  No rounded corners, no gradients — sharp dividers, monospace labels.

### 14.3 Predator-Prey Section

Appears in "Behaviour" panel when `predatorGenomeThreshold > 0`:
```
[Predator-Prey ▼]
  Predator Threshold: ██████████ 48000
  Attack Strength:    █████░░░░░ 0.30
  Feed Energy:        ████░░░░░░ 0.40
  Spore Lifetime:     ████████░░ 500 ticks
```

### 14.4 Population Chart Predator Mode

Toggle button on `PopulationChart` panel header:
`[Standard ▶]` / `[Predator/Prey ▶]`

When in predprey mode, renders two coloured lines on same axes:
- Red: predator count
- Teal: prey count
- The sinusoidal phase relationship becomes the chart's visual signature

---

## 15. Test Plan

### Phase 18 (Morphology)
- [ ] `CellFlags.JUST_DIVIDED` set on parent cell after spread event
- [ ] `JUST_DIVIDED` cleared exactly 1 tick later on same cell
- [ ] Fragment shader GLSL compiles without error at `u_aliveDetail = 1.0`
- [ ] `u_aliveDetail = 0.0` produces visually identical output to pre-Phase-18 (snapshot)
- [ ] Senescent cell: nucleus radius > 0.15 in shader output

### Phase 19 (Motility)
- [ ] Velocity damps by `(1 - motilityDamping)` per tick (tolerance ± 1e-4)
- [ ] Cell migrates to empty target cell on successful roll
- [ ] No duplication: source cell becomes Empty after migration
- [ ] Migration cancelled (source stays) when target is occupied
- [ ] Velocity reflects correctly off impassable wall (normal reflection formula)
- [ ] `chemotaxisMotilityFraction = 0` applies zero velocity bias from chemotaxis

### Phase 20 (Chemical Ecology)
- [ ] Diffusion conserves `∑(C) - decay × ∑(C) × dt` within 0.1% per tick
- [ ] Nutrient channel value increases adjacent to Nutrient cells
- [ ] Waste channel increases adjacent to Life cells
- [ ] Alarm channel spikes when cell energy < 0.1
- [ ] Quorum flag set when local pheromone > quorumThreshold
- [ ] Quorum energy bonus `quorumActivationEnergy × 0.01` applied per tick to quorum cells

### Phase 21 (Predator-Prey)
- [ ] Cell with genome ≥ threshold classified as predator (isPredator = true)
- [ ] Attack hit probability matches theoretical: 1000 trials within 95% CI
- [ ] Predator gains exactly `predatorFeedEnergy` on successful attack
- [ ] Prey cell becomes Empty on successful predation (no energy ghost)
- [ ] Spore produced when `energy < 0.03` AND `localAlarm > 0.2`
- [ ] Spore does not decay energy across 1000 ticks
- [ ] Spore revives (becomes Life) when `alarm = 0` AND `neighbourEnergy ≥ 0.3`
- [ ] Spore converts to Empty after `sporeLifetime` ticks without revival
- [ ] Predator energy decays at `× predatorEnergyDecayMultiplier` vs normal cell

### Phase 22 (Particles)
- [ ] Particle pool never exceeds 65 536 live entries
- [ ] Dead particles (life ≤ 0) are overwritten (FIFO eviction or ring buffer)
- [ ] Division flash particles emitted exactly once per JUST_DIVIDED event
- [ ] Trail texture decays by factor 0.92 per render frame (sample + measure)
- [ ] AO: interior cell (8 live neighbours) is ≥ 25% darker than isolated cell

---

## 16. Risk & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SAB resize breaks existing buffer layout | High | High | Update `sharedBuffers.ts` size constant; validate with test that reads all buffers correctly after resize |
| Motility creates duplication (two cells → same target) | High | Medium | Process migration in deterministic scan order; first-writer-wins semantics |
| Chemical diffusion GPU pass not supported (mobile WebGL 2 with no float FBO) | Medium | Medium | Detect `EXT_color_buffer_float`; fall back to CPU diffusion if absent |
| Performance regression from chemical channels (4 texture uploads/tick) | Medium | Medium | Gate all 4 on `chemicalDiffusionRate > 0`; combine into RGBA texture |
| Predator genome threshold → instant prey extinction | Medium | Low | Add `predatorStarvationRate` multiplier: predator decay × 2 when prey < 5% of total |
| GPU transform feedback not available | Low | Medium | Detect `MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS > 0`; fall back to CPU particle update |
| Phase 18 GLSL makes cellSize < 4 look noisy | High | Low | Gate nucleus + organelles behind `u_cellSize ≥ 4.0` LOD check in shader |
| Existing 512 tests break from buffer layout changes | High | High | Run tests after every buffer addition; never proceed if tests fail |

---

## Summary

Five phases, one goal: make the simulation *feel* alive.

| Phase | Complexity | Visual Impact | Sim Impact | Ships Independently? |
|---|---|---|---|---|
| 18 — Morphology | Low | ★★★★★ | None | Yes |
| 19 — Motility | Medium | ★★★★☆ | ★★★☆☆ | Yes |
| 20 — Chemistry | High | ★★★★☆ | ★★★★★ | Needs Phase 19 buffers |
| 21 — Predator-Prey | High | ★★★★★ | ★★★★★ | Needs Phase 20 |
| 22 — Polish | Medium | ★★★★★ | None | Yes (run in parallel with any phase) |

**Start with Phase 18** — it is purely visual, purely GLSL, zero new buffers, and
delivers an immediate "wow" moment.  The cells will look biological on the first
render after merge.  Everything else builds from that foundation.
