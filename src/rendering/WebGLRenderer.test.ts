/**
 * @fileoverview Unit tests for WebGLRenderer and the isWebGL2Available helper.
 *
 * ## Testing strategy
 *
 * Neither WebGL 2 nor Canvas 2D contexts are available in Vitest's jsdom
 * environment — calling `canvas.getContext(...)` returns null.  We use
 * `vi.spyOn` to stub `HTMLCanvasElement.prototype.getContext` so we can:
 *
 *   1. Test `isWebGL2Available()` returns `false` when WebGL 2 is absent.
 *   2. Test `WebGLRenderer` throws a descriptive error when WebGL 2 is absent.
 *   3. Test `Renderer` (Canvas 2D) public API — `cellSize`, `showGridLines`,
 *      `invalidate()`, `render()` — by providing a minimal mock context.
 *   4. Verify both classes satisfy the shared `render/invalidate/cellSize/
 *      showGridLines` union interface at the TypeScript type level.
 *
 * GPU-dependent pixel output is not tested here; the simulation engine and
 * the colour-mapping LUT have their own unit tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebGLRenderer, isWebGL2Available, FRAG_SRC } from './WebGLRenderer.js';
import { Renderer, type RendererOptions }              from './Renderer.js';
import { type GridBuffers }                            from '../simulation/GridState.js';

// ---------------------------------------------------------------------------
// Minimal Canvas 2D context mock
// ---------------------------------------------------------------------------

/**
 * Returns a minimal mock object that satisfies the `Canvas2DCtx` interface
 * used internally by `Renderer`.  All methods are no-ops or return sane zeros.
 */
function makeCtx2DMock() {
  const imageDataMock: ImageData = {
    data:             new Uint8ClampedArray(4),
    width:            1,
    height:           1,
    colorSpace:       'srgb',
  };

  return {
    imageSmoothingEnabled: true,
    strokeStyle:           '',
    lineWidth:             1,
    createImageData:       vi.fn((_w: number, _h: number): ImageData => ({
      data:         new Uint8ClampedArray(_w * _h * 4),
      width:        _w,
      height:       _h,
      colorSpace:   'srgb',
    })),
    putImageData:    vi.fn(),
    beginPath:       vi.fn(),
    moveTo:          vi.fn(),
    lineTo:          vi.fn(),
    stroke:          vi.fn(),
    // Keep a reference so tests can call getImageData.
    getImageData:    vi.fn((_x: number, _y: number, _w: number, _h: number) => ({
      ...imageDataMock,
      data:   new Uint8ClampedArray(_w * _h * 4),
      width:  _w,
      height: _h,
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal `GridBuffers` stub for use in render() calls.
 *
 * @param cells - Number of cells (width × height).
 * @returns Stub GridBuffers with zeroed arrays.
 */
function makeStubBuffers(cells: number): GridBuffers {
  return {
    // Round 1 buffers
    cellType:       new Uint8Array(cells),
    energy:         new Float32Array(cells),
    age:            new Uint16Array(cells),
    flags:          new Uint8Array(cells),
    // Round 2 genome buffers (required by GridBuffers interface)
    genome:         new Uint16Array(cells),
    variantId:      new Uint8Array(cells),
    generation:     new Uint16Array(cells),
    toxinResist:    new Float32Array(cells),
    nutrientAbs:    new Float32Array(cells),
    heatResist:     new Float32Array(cells),
    spreadBonus:    new Float32Array(cells),
    signalStrength: new Float32Array(cells),
    // Phase 19 motility buffers
    vx:             new Float32Array(cells),
    vy:             new Float32Array(cells),
    // Phase 20 chemical ecology buffers
    chemNutrient:   new Float32Array(cells),
    chemWaste:      new Float32Array(cells),
    chemPheromone:  new Float32Array(cells),
    chemAlarm:      new Float32Array(cells),
  };
}

/**
 * Stubs `HTMLCanvasElement.prototype.getContext` so that:
 *  - `'webgl2'` always returns `null` (unavailable).
 *  - `'2d'` returns the given mock context.
 *
 * @param ctx2d - Mock Canvas 2D context to return.
 * @returns The spy, so tests can restore it or assert calls.
 */
function stubGetContext(ctx2d: ReturnType<typeof makeCtx2DMock>) {
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (contextId: string) => {
      if (contextId === '2d') return ctx2d as unknown as RenderingContext;
      return null; // webgl, webgl2, bitmaprenderer — all unavailable
    },
  );
}

// ---------------------------------------------------------------------------
// isWebGL2Available
// ---------------------------------------------------------------------------

describe('isWebGL2Available', () => {
  it('returns false in jsdom (WebGL 2 context unavailable)', () => {
    // jsdom does not implement WebGL 2 — OffscreenCanvas.getContext('webgl2')
    // returns null.  The helper should detect this gracefully.
    expect(isWebGL2Available()).toBe(false);
  });

  it('returns a boolean (never throws)', () => {
    const result = isWebGL2Available();
    expect(typeof result).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// WebGLRenderer constructor — fallback behaviour in jsdom
// ---------------------------------------------------------------------------

describe('WebGLRenderer constructor', () => {
  it('throws with a descriptive message when WebGL 2 is unavailable', () => {
    const canvas = document.createElement('canvas');

    expect(() => new WebGLRenderer(canvas)).toThrow(
      /WebGL 2 is not available/i,
    );
  });

  it('throws an Error instance (not a string throw)', () => {
    const canvas = document.createElement('canvas');

    try {
      new WebGLRenderer(canvas);
      expect.fail('Expected constructor to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// Renderer (Canvas 2D) — public API
// ---------------------------------------------------------------------------

describe('Renderer / WebGLRenderer interface compatibility', () => {
  let ctx2d: ReturnType<typeof makeCtx2DMock>;
  let spy: ReturnType<typeof stubGetContext>;

  beforeEach(() => {
    ctx2d = makeCtx2DMock();
    spy   = stubGetContext(ctx2d);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('Renderer satisfies the shared render/invalidate/cellSize/showGridLines interface', () => {
    const canvas = document.createElement('canvas');

    // Typed as the union interface so TS enforces compatibility at compile time.
    const r: {
      render:        (b: GridBuffers, w: number, h: number) => void;
      invalidate:    () => void;
      cellSize:      number;
      showGridLines: boolean;
    } = new Renderer(canvas, { cellSize: 2 });

    expect(r.cellSize).toBe(2);
    expect(r.showGridLines).toBe(false);

    r.cellSize      = 4;
    r.showGridLines = true;
    expect(r.cellSize).toBe(4);
    expect(r.showGridLines).toBe(true);

    expect(() => r.invalidate()).not.toThrow();
    expect(() => r.render(makeStubBuffers(4), 2, 2)).not.toThrow();
  });

  it('RendererOptions with cellSize and showGridLines both applied', () => {
    const opts: RendererOptions = { cellSize: 3, showGridLines: true };
    const r = new Renderer(document.createElement('canvas'), opts);
    expect(r.cellSize).toBe(3);
    expect(r.showGridLines).toBe(true);
  });

  it('RendererOptions with only cellSize leaves showGridLines false', () => {
    const r = new Renderer(document.createElement('canvas'), { cellSize: 1 });
    expect(r.showGridLines).toBe(false);
  });

  it('defaults (no options) give cellSize=2, showGridLines=false', () => {
    const r = new Renderer(document.createElement('canvas'));
    expect(r.cellSize).toBe(2);
    expect(r.showGridLines).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Renderer.invalidate
// ---------------------------------------------------------------------------

describe('Renderer.invalidate', () => {
  let ctx2d: ReturnType<typeof makeCtx2DMock>;
  let spy: ReturnType<typeof stubGetContext>;

  beforeEach(() => {
    ctx2d = makeCtx2DMock();
    spy   = stubGetContext(ctx2d);
  });

  afterEach(() => { spy.mockRestore(); });

  it('can be called before any render without throwing', () => {
    const r = new Renderer(document.createElement('canvas'));
    // _prevColors is not yet allocated; the implementation must guard this.
    expect(() => r.invalidate()).not.toThrow();
  });

  it('can be called multiple times consecutively without throwing', () => {
    const r       = new Renderer(document.createElement('canvas'), { cellSize: 2 });
    const buffers = makeStubBuffers(4);

    r.render(buffers, 2, 2); // allocates _prevColors
    expect(() => {
      r.invalidate();
      r.invalidate();
      r.invalidate();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Renderer.render — resize and pixel behaviour
// ---------------------------------------------------------------------------

describe('Renderer.render', () => {
  let ctx2d: ReturnType<typeof makeCtx2DMock>;
  let spy: ReturnType<typeof stubGetContext>;

  beforeEach(() => {
    ctx2d = makeCtx2DMock();
    spy   = stubGetContext(ctx2d);
  });

  afterEach(() => { spy.mockRestore(); });

  it('resizes the canvas to width * cellSize × height * cellSize', () => {
    const canvas = document.createElement('canvas');
    const r      = new Renderer(canvas, { cellSize: 3 });
    r.render(makeStubBuffers(4), 2, 2);

    // 2 cells × 3 px/cell = 6 px each dimension.
    expect(canvas.width).toBe(6);
    expect(canvas.height).toBe(6);
  });

  it('handles a single-cell grid without throwing', () => {
    const r = new Renderer(document.createElement('canvas'), { cellSize: 2 });
    expect(() => r.render(makeStubBuffers(1), 1, 1)).not.toThrow();
  });

  it('re-renders after cellSize change without throwing', () => {
    const canvas  = document.createElement('canvas');
    const r       = new Renderer(canvas, { cellSize: 1 });
    const buffers = makeStubBuffers(16); // 4×4

    r.render(buffers, 4, 4);
    expect(canvas.width).toBe(4);

    r.cellSize = 2;
    r.render(buffers, 4, 4);
    expect(canvas.width).toBe(8);
  });

  it('calls putImageData on the context each frame', () => {
    const r = new Renderer(document.createElement('canvas'), { cellSize: 1 });
    r.render(makeStubBuffers(4), 2, 2);
    expect(ctx2d.putImageData).toHaveBeenCalledTimes(1);

    r.render(makeStubBuffers(4), 2, 2);
    expect(ctx2d.putImageData).toHaveBeenCalledTimes(2);
  });

  it('draws grid lines when showGridLines is true and cellSize >= 2', () => {
    const r = new Renderer(document.createElement('canvas'), {
      cellSize:      2,
      showGridLines: true,
    });
    r.render(makeStubBuffers(4), 2, 2);
    // Grid-line drawing calls stroke() at least once.
    expect(ctx2d.stroke).toHaveBeenCalled();
  });

  it('does not draw grid lines when showGridLines is false', () => {
    const r = new Renderer(document.createElement('canvas'), {
      cellSize:      2,
      showGridLines: false,
    });
    r.render(makeStubBuffers(4), 2, 2);
    expect(ctx2d.stroke).not.toHaveBeenCalled();
  });

  it('does not draw grid lines at cellSize=1 even when showGridLines is true', () => {
    const r = new Renderer(document.createElement('canvas'), {
      cellSize:      1,
      showGridLines: true,
    });
    r.render(makeStubBuffers(4), 2, 2);
    // At 1 px/cell grid lines would cover cells — they are suppressed.
    expect(ctx2d.stroke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WebGLRenderer.invalidate — documented no-op contract
// ---------------------------------------------------------------------------

describe('WebGLRenderer static contract', () => {
  it('invalidate method is defined on the prototype', () => {
    // We cannot construct a WebGLRenderer in jsdom, but the method must exist
    // on the prototype so the union type `Renderer | WebGLRenderer` compiles.
    expect(typeof WebGLRenderer.prototype.invalidate).toBe('function');
  });

  it('render method is defined on the prototype', () => {
    expect(typeof WebGLRenderer.prototype.render).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// FRAG_SRC — Phase 16a gamma correction (shader source assertions)
//
// WebGL rendering cannot be executed in jsdom, but we can assert that the
// shader source contains the required gamma functions so a regression
// (accidental deletion, merge conflict) fails the test suite immediately.
// ---------------------------------------------------------------------------

describe('FRAG_SRC gamma correction (Phase 16a)', () => {
  it('declares the srgbToLinear function', () => {
    expect(FRAG_SRC).toContain('float srgbToLinear(float c)');
  });

  it('declares the srgbToLinearVec function', () => {
    expect(FRAG_SRC).toContain('vec3 srgbToLinearVec(vec3 c)');
  });

  it('declares the linearToSrgb function', () => {
    expect(FRAG_SRC).toContain('float linearToSrgb(float c)');
  });

  it('declares the linearToSrgbVec function', () => {
    expect(FRAG_SRC).toContain('vec3 linearToSrgbVec(vec3 c)');
  });

  it('uses the IEC 61966-2-1 threshold 0.04045 in srgbToLinear', () => {
    // If the constant changes, the TypeScript and GLSL implementations diverge.
    expect(FRAG_SRC).toContain('0.04045');
  });

  it('uses the IEC 61966-2-1 threshold 0.0031308 in linearToSrgb', () => {
    expect(FRAG_SRC).toContain('0.0031308');
  });

  it('applies linearToSrgbVec to the final outColor output', () => {
    // The last colour write must encode to sRGB; without this the display
    // would receive linear light values and appear too dark.
    expect(FRAG_SRC).toContain('linearToSrgbVec(clamp(cellRGB');
  });

  it('linearises baseColor() result in the default render path', () => {
    // All six render modes must work in linear space before blending.
    expect(FRAG_SRC).toContain('srgbToLinearVec(baseColor(cellType))');
  });

  it('linearises the variant palette sample in render mode 2', () => {
    expect(FRAG_SRC).toContain('srgbToLinearVec(texelFetch(u_variantPalette');
  });

  it('linearises lifecycle base colours in render mode 1', () => {
    // Juvenile lime (#44ff88) and mature green (#00ff88) are the two main
    // hardcoded sRGB colours in the lifecycle branch.
    expect(FRAG_SRC).toContain('srgbToLinearVec(vec3(0.2667, 1.0, 0.5333))');
    expect(FRAG_SRC).toContain('srgbToLinearVec(vec3(0.0, 1.0, 0.5333))');
  });

  it('linearises the environment tint before mixing', () => {
    expect(FRAG_SRC).toContain('srgbToLinearVec(u_envTint.rgb)');
  });

  it('linearises the signal cyan glow colour in render mode 6', () => {
    expect(FRAG_SRC).toContain('srgbToLinearVec(vec3(0.0, 0.933, 1.0))');
  });

  it('uses srgbToLinear for the grid-line alpha value', () => {
    expect(FRAG_SRC).toContain('srgbToLinear(0.08)');
  });
});

// ---------------------------------------------------------------------------
// FRAG_SRC — Phase 16b OKLab perceptual colour space (shader source assertions)
// ---------------------------------------------------------------------------

describe('FRAG_SRC OKLab colour space (Phase 16b)', () => {
  it('declares the oklabToLinearRgb function', () => {
    expect(FRAG_SRC).toContain('vec3 oklabToLinearRgb(float L, float a, float b)');
  });

  it('uses the correct OKLab→LMS matrix coefficients', () => {
    // These constants must stay in sync with ColorMap.ts oklabToSrgb().
    expect(FRAG_SRC).toContain('0.3963377774');
    expect(FRAG_SRC).toContain('0.2158037573');
    expect(FRAG_SRC).toContain('4.0767416621');
  });

  it('genome render mode uses oklabToLinearRgb (not the old sRGB component lerp)', () => {
    expect(FRAG_SRC).toContain('cellRGB = oklabToLinearRgb(ok.x, ok.y, ok.z)');
  });

  it('genome render mode defines the three OKLab endpoint vectors', () => {
    // Blue, green, and red endpoints from PLAN3.md / genomeColorFor() TypeScript.
    expect(FRAG_SRC).toContain('vec3 blueOk');
    expect(FRAG_SRC).toContain('vec3 greenOk');
    expect(FRAG_SRC).toContain('vec3 redOk');
  });

  it('genome render mode scales the L channel for energy brightness', () => {
    // Perceptually correct brightness — L axis only, hue/chroma preserved.
    expect(FRAG_SRC).toContain('ok.x *= bright');
  });

  it('genome render mode no longer uses the old sRGB component lerp', () => {
    // The old formula used rC/gC/bC variables that are no longer present in mode 3.
    // We check the srgbToLinearVec call that wrapped those variables is gone.
    expect(FRAG_SRC).not.toContain('srgbToLinearVec(vec3(rC, gC, bC))');
  });
});

// ---------------------------------------------------------------------------
// FRAG_SRC — Phase 16c HDR bloom uniform + hdrBaseColor (shader assertions)
// ---------------------------------------------------------------------------

describe('FRAG_SRC HDR bloom (Phase 16c)', () => {
  it('declares the u_hdrOutput uniform', () => {
    expect(FRAG_SRC).toContain('uniform bool u_hdrOutput;');
  });

  it('declares the hdrBaseColor function', () => {
    expect(FRAG_SRC).toContain('vec3 hdrBaseColor(uint t)');
  });

  it('hdrBaseColor returns boosted Fire value (2.0, 0.08, 0.0)', () => {
    expect(FRAG_SRC).toContain('vec3(2.0,   0.08,  0.0)');
  });

  it('hdrBaseColor returns boosted Barrier value (1.8, 1.3, 0.04)', () => {
    expect(FRAG_SRC).toContain('vec3(1.8,   1.3,   0.04)');
  });

  it('hdrBaseColor returns boosted Colony value (1.2, 0.5, 0.006)', () => {
    expect(FRAG_SRC).toContain('vec3(1.2,   0.5,   0.006)');
  });

  it('default render mode selects hdrBaseColor when u_hdrOutput is true', () => {
    expect(FRAG_SRC).toContain('u_hdrOutput ? hdrBaseColor(cellType) : srgbToLinearVec(baseColor(cellType))');
  });

  it('final outColor is conditional on u_hdrOutput', () => {
    // HDR pass emits raw linear with alpha=0 for empty cells (Phase 16d);
    // direct pass gamma-encodes and is always opaque.
    expect(FRAG_SRC).toContain('outColor = u_hdrOutput');
    // Phase 16d: empty cells are transparent in HDR mode — alpha is dynamic.
    expect(FRAG_SRC).toContain('float alpha =');
    expect(FRAG_SRC).toContain('vec4(cellRGB, alpha)');
    expect(FRAG_SRC).toContain('vec4(linearToSrgbVec(clamp(cellRGB, 0.0, 1.0)), 1.0)');
  });
});

// ---------------------------------------------------------------------------
// PP shader sources — Phase 16c bloom pipeline constants
// ---------------------------------------------------------------------------

import {
  PP_VERT_SRC,
  BLOOM_EXTRACT_FRAG_SRC,
  BLOOM_BLUR_FRAG_SRC,
  COMPOSITE_FRAG_SRC,
} from './WebGLRenderer.js';

describe('PP shader sources (Phase 16c)', () => {
  it('PP_VERT_SRC outputs v_texCoord from a_position', () => {
    expect(PP_VERT_SRC).toContain('out vec2 v_texCoord');
    expect(PP_VERT_SRC).toContain('a_position * 0.5 + 0.5');
  });

  it('BLOOM_EXTRACT_FRAG_SRC samples u_scene and applies u_threshold', () => {
    expect(BLOOM_EXTRACT_FRAG_SRC).toContain('uniform sampler2D u_scene');
    expect(BLOOM_EXTRACT_FRAG_SRC).toContain('uniform float u_threshold');
    expect(BLOOM_EXTRACT_FRAG_SRC).toContain('max(0.0, luma - u_threshold)');
  });

  it('BLOOM_EXTRACT_FRAG_SRC uses BT.709 luminance coefficients', () => {
    expect(BLOOM_EXTRACT_FRAG_SRC).toContain('0.2126');
    expect(BLOOM_EXTRACT_FRAG_SRC).toContain('0.7152');
    expect(BLOOM_EXTRACT_FRAG_SRC).toContain('0.0722');
  });

  it('BLOOM_BLUR_FRAG_SRC declares the 9-tap Gaussian weights array', () => {
    expect(BLOOM_BLUR_FRAG_SRC).toContain('float[](0.227027, 0.194595, 0.121622, 0.054054, 0.016216)');
  });

  it('BLOOM_BLUR_FRAG_SRC uses u_horizontal to select blur direction', () => {
    expect(BLOOM_BLUR_FRAG_SRC).toContain('uniform bool u_horizontal');
    expect(BLOOM_BLUR_FRAG_SRC).toContain('u_horizontal');
  });

  it('COMPOSITE_FRAG_SRC declares reinhardExtended', () => {
    expect(COMPOSITE_FRAG_SRC).toContain('vec3 reinhardExtended(vec3 c)');
  });

  it('COMPOSITE_FRAG_SRC uses whitePoint = 4.0', () => {
    expect(COMPOSITE_FRAG_SRC).toContain('whitePoint = 4.0');
  });

  it('COMPOSITE_FRAG_SRC additively blends base + bloom * strength', () => {
    expect(COMPOSITE_FRAG_SRC).toContain('uniform float u_bloomStrength');
    // Phase 16d: scene is composited with background first → variable 'base';
    // bloom is then added to 'base' (not directly to 'scene').
    expect(COMPOSITE_FRAG_SRC).toContain('base + bloom');
  });

  it('COMPOSITE_FRAG_SRC has background uniforms (Phase 16d)', () => {
    expect(COMPOSITE_FRAG_SRC).toContain('uniform sampler2D u_background');
    expect(COMPOSITE_FRAG_SRC).toContain('uniform bool u_hasBackground');
    expect(COMPOSITE_FRAG_SRC).toContain('mix(bg, sceneRGBA.rgb, sceneRGBA.a)');
  });

  it('COMPOSITE_FRAG_SRC sRGB-encodes the final output', () => {
    expect(COMPOSITE_FRAG_SRC).toContain('linearToSrgbVec');
  });
});

// ---------------------------------------------------------------------------
// WebGLRenderer — Phase 16c public bloom API (prototype checks)
// ---------------------------------------------------------------------------

describe('WebGLRenderer bloom API (Phase 16c)', () => {
  it('prototype has bloomEnabled getter and setter', () => {
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'bloomEnabled',
    )?.get).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'bloomEnabled',
    )?.set).toBe('function');
  });

  it('prototype has bloomThreshold getter and setter', () => {
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'bloomThreshold',
    )?.get).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'bloomThreshold',
    )?.set).toBe('function');
  });

  it('prototype has bloomStrength getter and setter', () => {
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'bloomStrength',
    )?.get).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'bloomStrength',
    )?.set).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// FRAG_SRC — Phase 18 morphology uniforms + sub-cell anatomy
// ---------------------------------------------------------------------------

describe('FRAG_SRC Phase 18 morphology (shader assertions)', () => {
  it('declares u_time uniform for animation', () => {
    expect(FRAG_SRC).toContain('uniform int u_time;');
  });

  it('declares u_aliveDetail uniform for detail level', () => {
    expect(FRAG_SRC).toContain('uniform float u_aliveDetail;');
  });

  it('declares the lifeMorphology helper function', () => {
    expect(FRAG_SRC).toContain('vec4 lifeMorphology(');
  });

  it('lifeMorphology draws a membrane ring via smoothstep annulus', () => {
    // memMask is the annulus computed with two smoothstep calls.
    expect(FRAG_SRC).toContain('memMask');
    expect(FRAG_SRC).toContain('smoothstep(memOuter');
  });

  it('lifeMorphology handles division flash via JUST_DIVIDED flag (0x80 = 128)', () => {
    // JUST_DIVIDED = 0x80 = 128 — stored as decimal literal in GLSL.
    expect(FRAG_SRC).toContain('128u');
  });

  it('morphology block is gated on u_aliveDetail > 0.0 and u_cellSize >= 4.0', () => {
    expect(FRAG_SRC).toContain('u_aliveDetail > 0.0 && u_cellSize >= 4.0');
  });

  it('morphology blends flat colour into morph via mix + u_aliveDetail', () => {
    expect(FRAG_SRC).toContain('mix(cellRGB, morph.rgb / max(morph.a, 0.001), u_aliveDetail)');
  });

  it('render mode 7 uses the fixed cellular-green base colour', () => {
    // sRGB #00FF88 ≈ vec3(0.0, 1.0, 0.533) — the morphology mode base.
    expect(FRAG_SRC).toContain('u_renderMode == 7');
    expect(FRAG_SRC).toContain('0.533');
  });

  it('extracellular matrix block runs on empty cells in non-HDR mode', () => {
    expect(FRAG_SRC).toContain('cellType == 0u && !u_hdrOutput && u_aliveDetail > 0.5');
  });

  it('no duplicate float alpha declaration exists in main()', () => {
    // Count occurrences — must be exactly one declaration.
    const matches = (FRAG_SRC.match(/float alpha\s*=/g) ?? []).length;
    expect(matches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WebGLRenderer — Phase 18 aliveDetail API (prototype checks)
// ---------------------------------------------------------------------------

describe('WebGLRenderer aliveDetail API (Phase 18)', () => {
  it('prototype has aliveDetail getter', () => {
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'aliveDetail',
    )?.get).toBe('function');
  });

  it('prototype has aliveDetail setter', () => {
    expect(typeof Object.getOwnPropertyDescriptor(
      WebGLRenderer.prototype, 'aliveDetail',
    )?.set).toBe('function');
  });
});
