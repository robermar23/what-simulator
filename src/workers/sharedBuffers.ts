/**
 * @fileoverview SharedArrayBuffer layout, allocation, and TypedArray view
 * helpers for the What Simulator's Web Worker architecture.
 *
 * ## Memory Layout
 *
 * The SAB is divided into:
 *
 * ```
 * [  Control section  ][  Buffer set 0  ][  Buffer set 1  ]
 *   (4 × Int32 = 16 B)    (N bytes)         (N bytes)
 * ```
 *
 * ### Control section (Int32Array, indices 0–3)
 *
 * | Index          | Name          | Description |
 * |----------------|---------------|-------------|
 * | CTRL_SEQ       | Sequence lock | Even = idle, odd = sim is writing. |
 * | CTRL_FRONT_IDX | Front pointer | Which buffer set (0 or 1) the render reads. |
 * | CTRL_TICK_COUNT| Tick counter  | Monotonically incremented after each tick. |
 * | CTRL_RESERVED  | —             | Reserved for future use. |
 *
 * ### Buffer sets
 *
 * Each set holds 12 parallel TypedArrays for all grid cells (Round 1 + Round 2):
 *
 * Round 1 (unchanged):
 *   cellType      (Uint8),    energy   (Float32), age     (Uint16), flags (Uint8)
 *
 * Round 2 genome buffers (NEW):
 *   genome        (Uint16),   variantId (Uint8),  generation (Uint16),
 *   toxinResist   (Float32),  nutrientAbs (Float32), heatResist (Float32),
 *   spreadBonus   (Float32),  signalStrength (Float32)
 *
 * TypedArray alignment requirements are satisfied by padding each field to
 * its natural alignment boundary within the set.
 *
 * ## Concurrency Protocol (seqlock)
 *
 * The simulation worker writes to the **back** buffer set (1 − frontIdx),
 * using a seqlock to prevent the render worker from observing a torn write:
 *
 * ```
 * // Sim write:
 * Atomics.add(ctrl, CTRL_SEQ, 1);       // seq → odd  (write in progress)
 * ...copy local front → sab[backIdx]...
 * Atomics.add(ctrl, CTRL_SEQ, 1);       // seq → even (write complete)
 * Atomics.store(ctrl, CTRL_FRONT_IDX, backIdx); // swap pointer
 * Atomics.add(ctrl, CTRL_TICK_COUNT, 1);
 *
 * // Render read (non-blocking, in requestAnimationFrame):
 * const frontIdx = Atomics.load(ctrl, CTRL_FRONT_IDX);
 * const seq1     = Atomics.load(ctrl, CTRL_SEQ);
 * if (seq1 % 2 !== 0) return;           // write in progress — skip this frame
 * ...read from sab[frontIdx]...
 * const seq2     = Atomics.load(ctrl, CTRL_SEQ);
 * if (seq1 !== seq2) return;            // torn read (very rare) — skip
 * // data is consistent, render it
 * ```
 */

import { type GridBuffers } from '../simulation/GridState.js';

// ---------------------------------------------------------------------------
// Control-array indices
// ---------------------------------------------------------------------------

/**
 * Index into the control Int32Array.
 * Sequence lock: even = idle, odd = sim is writing.
 */
export const CTRL_SEQ = 0;

/**
 * Index into the control Int32Array.
 * Which buffer set (0 or 1) is the current authoritative display front.
 */
export const CTRL_FRONT_IDX = 1;

/**
 * Index into the control Int32Array.
 * Monotonic tick counter — incremented by the sim worker after each tick.
 */
export const CTRL_TICK_COUNT = 2;

/** Number of Int32 entries in the control section. */
const CTRL_COUNT = 4; // 4th entry reserved

/** Total byte size of the control section. */
export const CTRL_BYTES = CTRL_COUNT * Int32Array.BYTES_PER_ELEMENT; // 16 bytes

// ---------------------------------------------------------------------------
// Buffer-set layout
// ---------------------------------------------------------------------------

/**
 * Byte offsets within a single buffer set (relative to that set's start byte).
 * All offsets satisfy the alignment requirement of their TypedArray type.
 *
 * Round 1 fields:
 *   cellTypeOffset, energyOffset, ageOffset, flagsOffset
 *
 * Round 2 genome fields (NEW):
 *   genomeOffset, variantIdOffset, generationOffset,
 *   toxinResistOffset, nutrientAbsOffset, heatResistOffset,
 *   spreadBonusOffset, signalStrengthOffset
 */
export interface BufferSetLayout {
  // --- Round 1 (unchanged) -------------------------------------------------
  /** Byte offset for `cellType` (Uint8Array, `totalCells` bytes). */
  cellTypeOffset: number;
  /** Byte offset for `energy` (Float32Array, `totalCells * 4` bytes). */
  energyOffset: number;
  /** Byte offset for `age` (Uint16Array, `totalCells * 2` bytes). */
  ageOffset: number;
  /** Byte offset for `flags` (Uint8Array, `totalCells` bytes). */
  flagsOffset: number;

  // --- Round 2 genome fields (NEW) -----------------------------------------
  /** Byte offset for `genome` (Uint16Array, `totalCells * 2` bytes). */
  genomeOffset: number;
  /** Byte offset for `variantId` (Uint8Array, `totalCells` bytes). */
  variantIdOffset: number;
  /** Byte offset for `generation` (Uint16Array, `totalCells * 2` bytes). */
  generationOffset: number;
  /** Byte offset for `toxinResist` (Float32Array, `totalCells * 4` bytes). */
  toxinResistOffset: number;
  /** Byte offset for `nutrientAbs` (Float32Array, `totalCells * 4` bytes). */
  nutrientAbsOffset: number;
  /** Byte offset for `heatResist` (Float32Array, `totalCells * 4` bytes). */
  heatResistOffset: number;
  /** Byte offset for `spreadBonus` (Float32Array, `totalCells * 4` bytes). */
  spreadBonusOffset: number;
  /** Byte offset for `signalStrength` (Float32Array, `totalCells * 4` bytes). */
  signalStrengthOffset: number;

  /** Total byte size of one buffer set (padded to 8-byte boundary). */
  byteSize: number;
}

/**
 * Advances a byte cursor to the next multiple of `alignment`.
 *
 * @param cursor    - Current byte position.
 * @param alignment - Required alignment (must be power of 2).
 * @returns Aligned cursor value ≥ `cursor`.
 */
function alignTo(cursor: number, alignment: number): number {
  return Math.ceil(cursor / alignment) * alignment;
}

/**
 * Computes the byte layout for one buffer set given `totalCells`.
 *
 * Alignment rules applied per TypedArray element size:
 *   - Uint8  (1 byte): always satisfied — no padding needed.
 *   - Uint16 (2 bytes): padded to 2-byte boundary.
 *   - Float32 (4 bytes): padded to 4-byte boundary.
 *
 * The entire set is padded to an 8-byte boundary so two sets can be stacked
 * inside the SAB without violating alignment for either.
 *
 * @param totalCells - Grid cell count (`width * height`).
 * @returns Byte layout descriptor for all 12 buffers.
 */
export function computeBufferSetLayout(totalCells: number): BufferSetLayout {
  let cursor = 0;

  // --- Round 1 buffers ---------------------------------------------------

  // cellType: 1 byte per cell.
  const cellTypeOffset = cursor;
  cursor += totalCells * Uint8Array.BYTES_PER_ELEMENT;

  // energy: 4 bytes per cell; requires 4-byte alignment.
  cursor = alignTo(cursor, Float32Array.BYTES_PER_ELEMENT);
  const energyOffset = cursor;
  cursor += totalCells * Float32Array.BYTES_PER_ELEMENT;

  // age: 2 bytes per cell; requires 2-byte alignment.
  cursor = alignTo(cursor, Uint16Array.BYTES_PER_ELEMENT);
  const ageOffset = cursor;
  cursor += totalCells * Uint16Array.BYTES_PER_ELEMENT;

  // flags: 1 byte per cell.
  const flagsOffset = cursor;
  cursor += totalCells * Uint8Array.BYTES_PER_ELEMENT;

  // --- Round 2 genome buffers (NEW) --------------------------------------

  // genome: 2 bytes per cell; requires 2-byte alignment.
  cursor = alignTo(cursor, Uint16Array.BYTES_PER_ELEMENT);
  const genomeOffset = cursor;
  cursor += totalCells * Uint16Array.BYTES_PER_ELEMENT;

  // variantId: 1 byte per cell.
  const variantIdOffset = cursor;
  cursor += totalCells * Uint8Array.BYTES_PER_ELEMENT;

  // generation: 2 bytes per cell; requires 2-byte alignment.
  cursor = alignTo(cursor, Uint16Array.BYTES_PER_ELEMENT);
  const generationOffset = cursor;
  cursor += totalCells * Uint16Array.BYTES_PER_ELEMENT;

  // toxinResist: 4 bytes per cell; requires 4-byte alignment.
  cursor = alignTo(cursor, Float32Array.BYTES_PER_ELEMENT);
  const toxinResistOffset = cursor;
  cursor += totalCells * Float32Array.BYTES_PER_ELEMENT;

  // nutrientAbs: 4 bytes per cell.
  const nutrientAbsOffset = cursor;
  cursor += totalCells * Float32Array.BYTES_PER_ELEMENT;

  // heatResist: 4 bytes per cell.
  const heatResistOffset = cursor;
  cursor += totalCells * Float32Array.BYTES_PER_ELEMENT;

  // spreadBonus: 4 bytes per cell.
  const spreadBonusOffset = cursor;
  cursor += totalCells * Float32Array.BYTES_PER_ELEMENT;

  // signalStrength: 4 bytes per cell.
  const signalStrengthOffset = cursor;
  cursor += totalCells * Float32Array.BYTES_PER_ELEMENT;

  // Pad the whole set to an 8-byte boundary so two sets can be stacked.
  const byteSize = alignTo(cursor, 8);

  return {
    cellTypeOffset,
    energyOffset,
    ageOffset,
    flagsOffset,
    genomeOffset,
    variantIdOffset,
    generationOffset,
    toxinResistOffset,
    nutrientAbsOffset,
    heatResistOffset,
    spreadBonusOffset,
    signalStrengthOffset,
    byteSize,
  };
}

/**
 * Computes the total byte size of the SharedArrayBuffer for the given grid.
 *
 * Formula: `CTRL_BYTES + 2 × bufferSetSize`
 *
 * @param totalCells - Grid cell count.
 * @returns Total SAB bytes required.
 */
export function totalSabBytes(totalCells: number): number {
  const layout = computeBufferSetLayout(totalCells);
  return CTRL_BYTES + 2 * layout.byteSize;
}

/**
 * Allocates a new `SharedArrayBuffer` sized for the given grid dimensions.
 *
 * The SAB is always zero-initialised by the platform, which means all cells
 * start as `CellType.Empty` (= 0) before the simulation worker populates it.
 *
 * Requires the page to have `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` headers (configured in
 * `vite.config.ts`).
 *
 * @param width  - Grid width in cells.
 * @param height - Grid height in cells.
 * @returns Newly allocated SharedArrayBuffer.
 */
export function allocateSharedGrid(width: number, height: number): SharedArrayBuffer {
  const bytes = totalSabBytes(width * height);
  return new SharedArrayBuffer(bytes);
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

/**
 * Returns an `Int32Array` view over the control section at the start of `sab`.
 *
 * Use `Atomics.load` / `Atomics.store` / `Atomics.add` on this array to
 * coordinate access between the simulation and render workers.
 *
 * @param sab - The SharedArrayBuffer.
 * @returns Control Int32Array (4 entries).
 */
export function makeControlView(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab, 0, CTRL_COUNT);
}

/**
 * Creates `GridBuffers` TypedArray views into one buffer set of the SAB.
 *
 * Both the simulation worker and render worker call this to get typed views
 * into the same underlying memory.  The arrays are writable — the simulation
 * worker writes them; the render worker reads them.
 *
 * All 12 buffers (Round 1 + Round 2) are included in the returned views.
 *
 * @param sab        - The SharedArrayBuffer.
 * @param totalCells - Grid cell count (`width * height`).
 * @param setIdx     - Which buffer set to view (0 or 1).
 * @returns `GridBuffers` backed by the SAB.
 */
export function makeBufferViews(
  sab: SharedArrayBuffer,
  totalCells: number,
  setIdx: 0 | 1,
): GridBuffers {
  const layout = computeBufferSetLayout(totalCells);
  // Base byte offset: past the control section + skip completed sets.
  const base   = CTRL_BYTES + setIdx * layout.byteSize;

  return {
    // Round 1 buffers
    cellType:       new Uint8Array  (sab, base + layout.cellTypeOffset,       totalCells),
    energy:         new Float32Array(sab, base + layout.energyOffset,         totalCells),
    age:            new Uint16Array (sab, base + layout.ageOffset,            totalCells),
    flags:          new Uint8Array  (sab, base + layout.flagsOffset,          totalCells),
    // Round 2 genome buffers
    genome:         new Uint16Array (sab, base + layout.genomeOffset,         totalCells),
    variantId:      new Uint8Array  (sab, base + layout.variantIdOffset,      totalCells),
    generation:     new Uint16Array (sab, base + layout.generationOffset,     totalCells),
    toxinResist:    new Float32Array(sab, base + layout.toxinResistOffset,    totalCells),
    nutrientAbs:    new Float32Array(sab, base + layout.nutrientAbsOffset,    totalCells),
    heatResist:     new Float32Array(sab, base + layout.heatResistOffset,     totalCells),
    spreadBonus:    new Float32Array(sab, base + layout.spreadBonusOffset,    totalCells),
    signalStrength: new Float32Array(sab, base + layout.signalStrengthOffset, totalCells),
  };
}
