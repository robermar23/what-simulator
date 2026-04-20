/**
 * @fileoverview Background rendering interface, type definitions, and factory
 * for the What Simulator Phase 14 environment system.
 *
 * A Background is a procedurally-drawn Canvas 2D visual that renders behind
 * the simulation grid.  When a background is active the simulation renderer
 * draws empty cells as fully transparent (alpha = 0) so the background shows
 * through the grid.
 *
 * Architecture:
 *   - A dedicated `<canvas id="bg-canvas">` sits behind `#sim-canvas` in the
 *     canvas container.
 *   - {@link BackgroundManager} owns the animation RAF loop and calls
 *     `background.render()` each frame.
 *   - Each concrete background class lives in `src/rendering/backgrounds/`.
 *
 * Adding a new background:
 *   1. Add its key to {@link BackgroundType}.
 *   2. Implement the {@link Background} interface.
 *   3. Add a case to {@link createBackground}.
 *   4. Add a label to {@link BACKGROUND_LABELS}.
 */

// ---------------------------------------------------------------------------
// BackgroundType discriminated union
// ---------------------------------------------------------------------------

/**
 * Identifies which background environment is currently active.
 *
 * `'none'` means no background — the sim canvas shows its normal dark
 * `Empty` cell colour (opaque near-black).  All other values select a
 * procedural background and cause empty cells to be rendered as transparent.
 */
export type BackgroundType =
  | 'none'
  | 'petri'
  | 'water'
  | 'leaf'
  | 'soil'
  | 'space'
  | 'deepsea';

// ---------------------------------------------------------------------------
// Background interface
// ---------------------------------------------------------------------------

/**
 * Contract every concrete background must satisfy.
 *
 * Implementations should draw entirely within the `[0, width] × [0, height]`
 * rectangle and must be idempotent with respect to `ctx` state — i.e. save /
 * restore any transforms or compositing settings they change.
 */
export interface Background {
  /**
   * Render one animation frame of this background.
   *
   * @param ctx    - Canvas 2D rendering context to draw into.
   * @param width  - Canvas width in pixels.
   * @param height - Canvas height in pixels.
   * @param frame  - Monotonically increasing frame counter (starts at 0).
   *                 Use this for time-based animation (e.g. `Math.sin(frame * speed)`).
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frame: number,
  ): void;
}

// ---------------------------------------------------------------------------
// WebGL background interface
// ---------------------------------------------------------------------------

/**
 * Contract every WebGL background must satisfy.
 *
 * Implementations compile their own GLSL programme on first render (lazy init)
 * and draw a fullscreen quad into the currently-bound framebuffer.
 *
 * The renderer calls `render()` once per frame between the bloom blur passes
 * and the final composite pass so the background lands behind the simulation.
 */
export interface WebGLBackground {
  /**
   * Render one animation frame of this background into the current GL state.
   *
   * @param gl     - The WebGL2 context.
   * @param width  - Viewport width in pixels.
   * @param height - Viewport height in pixels.
   * @param frame  - Monotonically increasing frame counter (starts at 0).
   */
  render(gl: WebGL2RenderingContext, width: number, height: number, frame: number): void;

  /**
   * OKLab tint applied to living cells so they visually belong to the
   * environment.  `null` means no GPU-side tint override.
   *
   * Format: `[L, a, b]` in OKLab colour space.
   */
  readonly envTintOklab: readonly [number, number, number] | null;
}

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

/**
 * Per-environment cell colour tint — blended into Life cell colours so that
 * living cells visually belong to the background environment regardless of
 * grid saturation level.
 *
 * Format: `[r, g, b, alpha]` where r/g/b ∈ [0, 255] and alpha ∈ [0, 1].
 * Alpha controls blend strength; 0 = no tint, 1 = fully tinted.
 *
 * Applied by both the Canvas 2D Renderer and the WebGL Renderer when a
 * background is active, ensuring the environment is always felt even when
 * the grid is 100% covered by life cells.
 */
export const ENVIRONMENT_TINTS: Readonly<Record<BackgroundType, readonly [number, number, number, number]>> = {
  none:    [  0,   0,   0, 0.00], // no tint
  petri:   [200, 168, 107, 0.14], // warm amber — agar gel colour
  water:   [ 20,  90, 190, 0.18], // ocean blue — refracted light
  leaf:    [ 30, 110,  40, 0.15], // chloroplast green — leaf interior
  soil:    [110,  65,  25, 0.18], // humus brown — organic matter
  space:   [ 45,  20,  90, 0.20], // deep purple-void — cosmic dark
  deepsea: [  0,  50, 140, 0.22], // abyssal blue — pressure and darkness
};

/**
 * Maps each {@link BackgroundType} to the label shown in the UI selector.
 */
export const BACKGROUND_LABELS: Readonly<Record<BackgroundType, string>> = {
  none:    'None',
  petri:   'Petri Dish',
  water:   'Aquatic',
  leaf:    'Leaf Surface',
  soil:    'Soil',
  space:   'Deep Space',
  deepsea: 'Deep Sea',
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Dynamically imports and instantiates the concrete background implementation
 * for the given type.
 *
 * Returns `null` for `'none'` — the BackgroundManager treats null as "clear
 * the background canvas and do nothing each frame".
 *
 * @param type - The background to create.
 * @returns A `Background` instance, or `null` for `'none'`.
 */
export async function createBackground(type: BackgroundType): Promise<Background | null> {
  switch (type) {
    case 'none':
      return null;
    case 'petri': {
      const { PetriDishBackground } = await import('./backgrounds/PetriDishBackground.js');
      return new PetriDishBackground();
    }
    case 'water': {
      const { WaterBackground } = await import('./backgrounds/WaterBackground.js');
      return new WaterBackground();
    }
    case 'leaf': {
      const { LeafBackground } = await import('./backgrounds/LeafBackground.js');
      return new LeafBackground();
    }
    case 'soil': {
      const { SoilBackground } = await import('./backgrounds/SoilBackground.js');
      return new SoilBackground();
    }
    case 'space': {
      const { SpaceBackground } = await import('./backgrounds/SpaceBackground.js');
      return new SpaceBackground();
    }
    case 'deepsea': {
      const { DeepSeaBackground } = await import('./backgrounds/DeepSeaBackground.js');
      return new DeepSeaBackground();
    }
  }
}


/**
 * Synchronous factory for testing and non-lazy contexts.
 *
 * In production the async `createBackground` is preferred (tree-shakeable
 * dynamic imports).  This version is used in unit tests so we can import
 * backgrounds without top-level await.
 *
 * @param type - The background to create.
 * @returns A `Background` instance, or `null` for `'none'`.
 */
export function createBackgroundSync(
  type: Exclude<BackgroundType, 'none'>,
): Background {
  // Resolved synchronously — each class is imported at the top of the test.
  // Tests import the concrete classes directly and pass them here.
  void type; // suppress unused-var lint; implementations supplied by tests
  throw new Error(
    `createBackgroundSync: use createBackground() (async) in production, ` +
    `or import the concrete class directly in tests.`,
  );
}
