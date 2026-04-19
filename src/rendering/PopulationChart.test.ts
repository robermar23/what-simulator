/**
 * @fileoverview Unit tests for PopulationChart pure helper functions.
 *
 * Tests cover:
 *   - computeTotal  — sum of all counts in a census snapshot
 *   - getActiveVariants — stable-sorted list of variants with any population
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { computeTotal, getActiveVariants } from './PopulationChart.js';

// ---------------------------------------------------------------------------
// computeTotal
// ---------------------------------------------------------------------------

describe('computeTotal', () => {
  it('returns 0 for an all-zero snapshot', () => {
    expect(computeTotal(new Uint32Array(256))).toBe(0);
  });

  it('sums a single populated variant', () => {
    const snap = new Uint32Array(256);
    snap[0] = 1000;
    expect(computeTotal(snap)).toBe(1000);
  });

  it('sums multiple populated variants', () => {
    const snap = new Uint32Array(256);
    snap[0]   = 500;
    snap[7]   = 300;
    snap[255] = 200;
    expect(computeTotal(snap)).toBe(1000);
  });

  it('handles a snapshot with every slot set to 1', () => {
    const snap = new Uint32Array(256).fill(1);
    expect(computeTotal(snap)).toBe(256);
  });

  it('handles a single-element array', () => {
    const snap = new Uint32Array([42]);
    expect(computeTotal(snap)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// getActiveVariants
// ---------------------------------------------------------------------------

describe('getActiveVariants', () => {
  it('returns empty array for no snapshots', () => {
    expect(getActiveVariants([])).toEqual([]);
  });

  it('returns empty array when all counts are zero', () => {
    const snap = new Uint32Array(256); // all zeros
    expect(getActiveVariants([snap])).toEqual([]);
  });

  it('returns variant IDs that have non-zero count in any snapshot', () => {
    const snap1 = new Uint32Array(256);
    const snap2 = new Uint32Array(256);
    snap1[3]  = 10;
    snap2[7]  = 5;
    snap2[3]  = 0; // variant 3 extinct in snap2 but was alive in snap1

    const result = getActiveVariants([snap1, snap2]);
    expect(result).toContain(3);
    expect(result).toContain(7);
    expect(result.length).toBe(2);
  });

  it('returns IDs sorted ascending regardless of insertion order', () => {
    const snap = new Uint32Array(256);
    snap[10] = 1;
    snap[2]  = 1;
    snap[55] = 1;
    snap[0]  = 1;

    const result = getActiveVariants([snap]);
    expect(result).toEqual([0, 2, 10, 55]);
  });

  it('deduplicates variants that appear in multiple snapshots', () => {
    const snap1 = new Uint32Array(256);
    const snap2 = new Uint32Array(256);
    snap1[4] = 100;
    snap2[4] = 50;

    const result = getActiveVariants([snap1, snap2]);
    expect(result).toEqual([4]);
  });

  it('unions variants across all snapshots', () => {
    const snap1 = new Uint32Array(256);
    const snap2 = new Uint32Array(256);
    const snap3 = new Uint32Array(256);
    snap1[1] = 10;
    snap2[2] = 10;
    snap3[3] = 10;

    const result = getActiveVariants([snap1, snap2, snap3]);
    expect(result).toEqual([1, 2, 3]);
  });
});
