/**
 * @fileoverview Canvas-rendered phylogenetic tree showing the full variant
 * lineage history tracked by {@link VariantRegistry}.
 *
 * On each 'variantCensus' EventBus event the tree reads the current
 * {@link VariantRecord} list from the singleton {@link variantRegistry} and
 * re-renders a left-to-right tree:
 *
 * ```
 * V0 ──── V1 ──── V5
 *    \──── V2
 *    \──── V3 ──── V7
 * ```
 *
 * ## Layout algorithm
 *
 * The layout is a simplified Reingold-Tilford approach:
 * 1. Build an adjacency list (parent → children), sorted by firstSeenTick.
 * 2. DFS pre-order assigns a "leaf counter" that increments every time a
 *    leaf node is visited.  Interior nodes are centred vertically between
 *    their first and last child.
 * 3. Depth determines the X coordinate; leaf counter determines Y.
 *
 * Each node is drawn as a coloured circle (from {@link VARIANT_PALETTE}).
 * Extinct variants are drawn in a greyed-out style with a dashed edge.
 * The canvas height adapts to the number of leaves so the tree is never
 * clipped — the wrapping panel scrolls if needed.
 *
 * ## Thread safety
 *
 * All reads from {@link variantRegistry} happen synchronously on the main
 * thread inside the EventBus callback, so no locking is needed.
 */

import { bus } from '../state/EventBus.js';
import { variantRegistry, type VariantRecord } from '../simulation/genetics/VariantRegistry.js';
import { VARIANT_PALETTE } from './ColorMap.js';

// ---------------------------------------------------------------------------
// Tree layout types and pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * A laid-out node ready for rendering.
 *
 * All coordinates are in canvas pixels relative to the canvas top-left.
 */
export interface TreeNode {
  /** The underlying variant data. */
  record: VariantRecord;
  /** X pixel coordinate of the node centre. */
  x: number;
  /** Y pixel coordinate of the node centre. */
  y: number;
  /** Pixel X of the parent node (used to draw the connecting edge). */
  parentX: number;
  /** Pixel Y of the parent node. */
  parentY: number;
  /** True if this is the root node (no parent edge to draw). */
  isRoot: boolean;
}

/** Horizontal pixels per depth level. */
const DEPTH_STEP = 56;
/** Vertical pixels per leaf node. */
const NODE_HEIGHT = 22;
/** Radius of the circle drawn for each node. */
const NODE_RADIUS = 6;
/** Canvas width in pixels (matches panel inner width). */
const CANVAS_W = 268;
/** Left margin before the root node. */
const MARGIN_LEFT = 10;
/** Top / bottom margin. */
const MARGIN_V = 12;

/**
 * Builds the pixel-coordinate layout for all nodes in the variant tree.
 *
 * Returns nodes in DFS pre-order (parent before children), which is the
 * natural draw order for edges (parent location known before child).
 *
 * @param records   - All variant records from VariantRegistry (any order).
 * @param depthStep - Horizontal pixels between depth levels.
 * @param nodeH     - Vertical pixels allocated per leaf node.
 * @param marginLeft - Left offset of the root node.
 * @param marginTop  - Top offset of the first leaf.
 * @returns Array of laid-out tree nodes sorted in DFS pre-order.
 */
export function buildTreeLayout(
  records: readonly VariantRecord[],
  depthStep: number,
  nodeH: number,
  marginLeft: number,
  marginTop: number,
): TreeNode[] {
  if (records.length === 0) return [];

  // Build id → record lookup.
  const byId = new Map<number, VariantRecord>();
  for (const r of records) byId.set(r.id, r);

  // Build parent → children adjacency (sorted by firstSeenTick ascending).
  const childrenOf = new Map<number, number[]>();
  for (const r of records) {
    if (r.id === r.parentVariantId) continue; // root is self-parent
    if (!byId.has(r.parentVariantId)) continue; // orphan (parent evicted)
    const list = childrenOf.get(r.parentVariantId) ?? [];
    list.push(r.id);
    childrenOf.set(r.parentVariantId, list);
  }
  // Sort each child list by firstSeenTick so tree is deterministic.
  for (const [, kids] of childrenOf) {
    kids.sort((a, b) => (byId.get(a)?.firstSeenTick ?? 0) - (byId.get(b)?.firstSeenTick ?? 0));
  }

  // DFS to assign Y coordinates via a leaf counter.
  let leafCount = 0;

  /**
   * Recursive DFS.
   * @param id - Variant ID of the node to process.
   * @param depth - Tree depth (0 = root).
   * @param parentX - Parent's pixel X (used to draw the edge).
   * @param parentY - Parent's pixel Y.
   * @returns Tuple of [assigned Y pixel, all descendant TreeNodes].
   */
  function dfs(
    id: number,
    depth: number,
    parentX: number,
    parentY: number,
  ): [y: number, nodes: TreeNode[]] {
    const record = byId.get(id);
    if (!record) return [0, []];

    const x = marginLeft + depth * depthStep;
    const kids = childrenOf.get(id) ?? [];
    const isRoot = (id === record.parentVariantId);

    if (kids.length === 0) {
      // Leaf node: claim one Y slot.
      const y = marginTop + leafCount * nodeH + nodeH / 2;
      leafCount++;
      const node: TreeNode = { record, x, y, parentX, parentY, isRoot };
      return [y, [node]];
    }

    // Interior node: recurse into children first, then centre self.
    const childNodes: TreeNode[] = [];
    const childYs: number[] = [];

    for (const kidId of kids) {
      const [childY, kidNodes] = dfs(kidId, depth + 1, x, 0 /* placeholder */);
      childYs.push(childY);
      childNodes.push(...kidNodes);
    }

    // Centre the parent between its first and last child.
    const y = (childYs[0] + childYs[childYs.length - 1]) / 2;

    // Back-fill the parentY on each direct child node (they stored placeholder 0).
    for (const cn of childNodes) {
      // Only direct children (those whose parentX matches our x) need updating.
      if (cn.parentX === x) cn.parentY = y;
    }

    const node: TreeNode = { record, x, y, parentX, parentY, isRoot };
    return [y, [node, ...childNodes]];
  }

  // Find root (variant 0 is always the seed; fall back to smallest ID).
  const rootId = byId.has(0) ? 0 : Math.min(...byId.keys());
  const [, nodes] = dfs(rootId, 0, 0, 0);
  return nodes;
}

// ---------------------------------------------------------------------------
// PhylogeneticTree class
// ---------------------------------------------------------------------------

/**
 * Phylogenetic tree component.
 *
 * Visualises the complete variant lineage history from {@link variantRegistry}
 * as a left-to-right tree on a Canvas 2D surface.
 *
 * Usage:
 * ```ts
 * const tree = new PhylogeneticTree();
 * tree.mount(containerElement);
 * ```
 */
export class PhylogeneticTree {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** Canvas element managed by this component. Null before mount. */
  private _canvas: HTMLCanvasElement | null = null;

  /** 2D rendering context. Null before mount. */
  private _ctx: CanvasRenderingContext2D | null = null;

  /** Unsubscribe function for the 'variantCensus' event. Null before mount. */
  private _unsub: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Creates the tree canvas and subscribes to census events.
   *
   * @param container - Element to append the canvas into.
   */
  mount(container: HTMLElement): void {
    const canvas     = document.createElement('canvas');
    canvas.width     = CANVAS_W;
    canvas.height    = MARGIN_V * 2 + NODE_HEIGHT; // initial single-node height
    canvas.className = 'evo-chart-canvas';
    canvas.setAttribute('aria-label', 'Phylogenetic tree — variant lineage history');
    container.append(canvas);
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');

    this._drawPlaceholder();

    this._unsub = bus.on('variantCensus', () => this._onCensus());
  }

  /**
   * Removes the canvas and unsubscribes from EventBus.
   */
  unmount(): void {
    this._unsub?.();
    this._canvas?.remove();
    this._canvas = null;
    this._ctx    = null;
    this._unsub  = null;
  }

  // -------------------------------------------------------------------------
  // Census handler
  // -------------------------------------------------------------------------

  /**
   * Reads the current VariantRegistry state and redraws the tree.
   * Called on each 'variantCensus' EventBus event.
   */
  private _onCensus(): void {
    const records = variantRegistry.getAllVariants();
    const nodes   = buildTreeLayout(records, DEPTH_STEP, NODE_HEIGHT, MARGIN_LEFT, MARGIN_V);
    this._resizeCanvas(nodes);
    this._render(nodes);
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  /** Draws a placeholder before any variant data is available. */
  private _drawPlaceholder(): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, CANVAS_W, this._canvas.height);
    ctx.fillStyle = '#3a3a5a';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting variant data…', CANVAS_W / 2, this._canvas.height / 2);
  }

  /**
   * Adjusts the canvas height to fit the current tree content.
   * Caps at 600 px to prevent extremely tall canvases.
   *
   * @param nodes - All laid-out tree nodes.
   */
  private _resizeCanvas(nodes: readonly TreeNode[]): void {
    if (!this._canvas) return;
    if (nodes.length === 0) {
      this._canvas.height = MARGIN_V * 2 + NODE_HEIGHT;
      return;
    }
    const maxY = Math.max(...nodes.map(n => n.y));
    const needed = Math.ceil(maxY + MARGIN_V);
    this._canvas.height = Math.min(600, Math.max(MARGIN_V * 2 + NODE_HEIGHT, needed));
  }

  /**
   * Draws edges then nodes on the canvas.
   *
   * Edges are drawn first (underneath nodes) as cubic bezier curves.
   * Extinct variant nodes are drawn with reduced opacity and grey colour.
   *
   * @param nodes - All laid-out tree nodes in DFS pre-order.
   */
  private _render(nodes: readonly TreeNode[]): void {
    const ctx = this._ctx;
    if (!ctx || !this._canvas) return;

    const W = CANVAS_W;
    const H = this._canvas.height;

    // Clear.
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, W, H);

    if (nodes.length === 0) {
      this._drawPlaceholder();
      return;
    }

    // --- Draw edges (parent → child bezier curves) -------------------------
    ctx.lineWidth = 1.5;
    for (const node of nodes) {
      if (node.isRoot) continue;
      const extinct = node.record.extinctionTick !== null;
      ctx.strokeStyle = extinct ? '#2a2a3e' : '#3a3a5e';
      ctx.setLineDash(extinct ? [3, 3] : []);
      ctx.beginPath();
      // Cubic bezier: horizontal control points at mid-X between parent and child.
      const cpX = (node.parentX + node.x) / 2;
      ctx.moveTo(node.parentX, node.parentY);
      ctx.bezierCurveTo(cpX, node.parentY, cpX, node.y, node.x, node.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // --- Draw nodes --------------------------------------------------------
    for (const node of nodes) {
      const v       = node.record.id;
      const extinct = node.record.extinctionTick !== null;

      // Pick colour: living → VARIANT_PALETTE; extinct → muted grey.
      let nodeColor: string;
      if (extinct) {
        nodeColor = '#444466';
      } else {
        const rgba  = VARIANT_PALETTE[v & 0xFF];
        const r     =  rgba        & 0xFF;
        const g     = (rgba >>  8) & 0xFF;
        const b     = (rgba >> 16) & 0xFF;
        nodeColor   = `rgb(${r},${g},${b})`;
      }

      // Filled circle.
      ctx.beginPath();
      ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor;
      ctx.fill();

      // Stroke ring for living variants to make them stand out.
      if (!extinct) {
        ctx.strokeStyle = '#ffffff40';
        ctx.lineWidth   = 1;
        ctx.stroke();
      }

      // Variant ID label to the right of the node (or left if too close to edge).
      const labelX  = node.x + NODE_RADIUS + 3;
      const labelTxt = `V${v}`;
      ctx.font      = '8px monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = extinct ? '#4a4a6a' : '#9090b0';

      if (labelX + 20 <= W) {
        ctx.fillText(labelTxt, labelX, node.y + 3);
      }
    }

    // Border.
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
}
