/**
 * @fileoverview Unit tests for PhylogeneticTree layout helpers.
 *
 * Tests cover:
 *   - buildTreeLayout — pixel coordinate assignment for variant lineage trees
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { buildTreeLayout } from './PhylogeneticTree.js';
import { type VariantRecord } from '../simulation/genetics/VariantRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand for creating a VariantRecord fixture. */
function makeRecord(
  id: number,
  parentVariantId: number,
  firstSeenTick = 0,
  extinctionTick: number | null = null,
): VariantRecord {
  return {
    id,
    firstSeenTick,
    peakPopulation: 100,
    extinctionTick,
    parentVariantId,
    genomeSample: 0x7777,
  };
}

const DEPTH_STEP  = 60;
const NODE_HEIGHT = 20;
const MARGIN_L    = 10;
const MARGIN_T    = 10;

// ---------------------------------------------------------------------------
// buildTreeLayout — basic structure
// ---------------------------------------------------------------------------

describe('buildTreeLayout', () => {
  it('returns empty array for empty input', () => {
    expect(buildTreeLayout([], DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T)).toEqual([]);
  });

  it('returns a single root node for a lone variant', () => {
    const records = [makeRecord(0, 0)]; // self-parent = root
    const nodes   = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);

    expect(nodes.length).toBe(1);
    expect(nodes[0].record.id).toBe(0);
    expect(nodes[0].isRoot).toBe(true);
  });

  it('places root at marginLeft, first leaf at marginTop + half node height', () => {
    const records = [makeRecord(0, 0)];
    const nodes   = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);

    expect(nodes[0].x).toBe(MARGIN_L);
    expect(nodes[0].y).toBe(MARGIN_T + NODE_HEIGHT / 2);
  });

  it('places a child one depth step to the right of the root', () => {
    const records = [makeRecord(0, 0), makeRecord(1, 0)];
    const nodes   = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);

    const root  = nodes.find(n => n.record.id === 0)!;
    const child = nodes.find(n => n.record.id === 1)!;

    expect(child.x).toBe(root.x + DEPTH_STEP);
    expect(child.isRoot).toBe(false);
  });

  it('marks the root node with isRoot = true', () => {
    const records = [makeRecord(0, 0), makeRecord(1, 0), makeRecord(2, 1)];
    const nodes   = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);

    const rootNodes = nodes.filter(n => n.isRoot);
    expect(rootNodes.length).toBe(1);
    expect(rootNodes[0].record.id).toBe(0);
  });

  it('centres an interior node between its first and last child', () => {
    // Tree: 0 → [1, 2]  (root has two leaf children)
    const records = [makeRecord(0, 0), makeRecord(1, 0), makeRecord(2, 0)];
    const nodes   = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);

    const child1 = nodes.find(n => n.record.id === 1)!;
    const child2 = nodes.find(n => n.record.id === 2)!;
    const root   = nodes.find(n => n.record.id === 0)!;

    // Root Y should be midpoint of the two children.
    const expectedRootY = (child1.y + child2.y) / 2;
    expect(root.y).toBeCloseTo(expectedRootY, 5);
  });

  it('assigns consecutive leaf Y values spaced by nodeHeight', () => {
    // Linear chain: 0 → 1 → 2 → 3  (all leaves except 0 and 1 are leaves)
    const records = [
      makeRecord(0, 0),
      makeRecord(1, 0),
      makeRecord(2, 0),
      makeRecord(3, 0),
    ];
    const nodes = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);
    const leaves = nodes.filter(n => n.record.id !== 0).sort((a, b) => a.y - b.y);

    for (let i = 1; i < leaves.length; i++) {
      expect(leaves[i].y - leaves[i - 1].y).toBeCloseTo(NODE_HEIGHT, 5);
    }
  });

  it('handles a grandchild (depth 2) at correct X', () => {
    // 0 → 1 → 2
    const records = [makeRecord(0, 0), makeRecord(1, 0), makeRecord(2, 1)];
    const nodes   = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);

    const grandchild = nodes.find(n => n.record.id === 2)!;
    expect(grandchild.x).toBe(MARGIN_L + 2 * DEPTH_STEP);
  });

  it('includes extinct variant records in the layout', () => {
    const records = [
      makeRecord(0, 0),
      makeRecord(1, 0, 10, 50), // extinct at tick 50
    ];
    const nodes = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);
    const extinctNode = nodes.find(n => n.record.id === 1)!;

    expect(extinctNode).toBeDefined();
    expect(extinctNode.record.extinctionTick).toBe(50);
  });

  it('produces a node count equal to the number of input records', () => {
    const records = [
      makeRecord(0, 0),
      makeRecord(1, 0),
      makeRecord(2, 0),
      makeRecord(3, 1),
      makeRecord(4, 1),
      makeRecord(5, 2),
    ];
    const nodes = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);
    expect(nodes.length).toBe(records.length);
  });

  it('sorts children by firstSeenTick so layout is deterministic', () => {
    // Children registered in reverse tick order — layout should order by tick.
    const records = [
      makeRecord(0, 0, 0),
      makeRecord(2, 0, 30), // second child (higher tick → lower in tree)
      makeRecord(1, 0, 10), // first child (lower tick → higher in tree)
    ];
    const nodes  = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_L, MARGIN_T);
    const child1 = nodes.find(n => n.record.id === 1)!;
    const child2 = nodes.find(n => n.record.id === 2)!;

    // child1 (tick 10) should be above child2 (tick 30) in the tree.
    expect(child1.y).toBeLessThan(child2.y);
  });
});
