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
import { WebGLRenderer, isWebGL2Available } from './WebGLRenderer.js';
import { Renderer, type RendererOptions }   from './Renderer.js';
import { type GridBuffers }                 from '../simulation/GridState.js';

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
