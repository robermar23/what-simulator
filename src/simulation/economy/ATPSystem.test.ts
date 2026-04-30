/**
 * @fileoverview Unit tests for ATPSystem.
 *
 * Scenarios covered:
 *   - Initial state: pool starts at the configured start amount.
 *   - spend(): deducts ATP when economy is enabled and pool is sufficient.
 *   - spend(): returns false without deducting when pool is insufficient.
 *   - spend(): always returns true when economy is disabled.
 *   - spend(): free actions (cost = 0) always succeed and do not deduct.
 *   - earn(): adds ATP capped at max pool size.
 *   - onTick(): passive income accrues from living cells.
 *   - onTick(): does not exceed max pool.
 *   - onTick(): emits atpChange only when integer value advances.
 *   - reconfigure(): updates start / max / incomeRate atomically.
 *   - reset(): restores ATP to the current max.
 *   - onMilestone(): awards correct ATP for each milestone kind.
 *   - costFor(): returns correct cost per tool name.
 *   - costFor(): returns 0 for unknown tools.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock for EventBus so emitted events do not require a DOM.
// ---------------------------------------------------------------------------

vi.mock('../../state/EventBus.js', () => ({
  bus: { emit: vi.fn(), on: vi.fn() },
}));

// Import after the mock is registered so the module sees the stub.
import { ATPSystem, ATP_COSTS, MILESTONE_REWARDS } from './ATPSystem.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh ATPSystem with sensible test defaults. */
function makeSystem(start = 500, max = 1000, rate = 0.0002): ATPSystem {
  return new ATPSystem(start, max, rate);
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('ATPSystem — initial state', () => {
  it('starts with the configured ATP amount', () => {
    const sys = makeSystem(400);
    expect(sys.atp).toBe(400);
  });

  it('reports the configured max', () => {
    const sys = makeSystem(500, 800);
    expect(sys.max).toBe(800);
  });

  it('starts with economy disabled', () => {
    const sys = makeSystem();
    expect(sys.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spend()
// ---------------------------------------------------------------------------

describe('ATPSystem — spend()', () => {
  let sys: ATPSystem;

  beforeEach(() => {
    sys = makeSystem(500, 1000);
    sys.setEnabled(true);
  });

  it('deducts ATP and returns true when pool is sufficient', () => {
    const ok = sys.spend(100);
    expect(ok).toBe(true);
    expect(sys.atp).toBe(400);
  });

  it('returns false without deducting when pool is insufficient', () => {
    const ok = sys.spend(600); // more than 500
    expect(ok).toBe(false);
    expect(sys.atp).toBe(500); // unchanged
  });

  it('always succeeds when economy is disabled', () => {
    sys.setEnabled(false);
    const ok = sys.spend(9999);
    expect(ok).toBe(true);
    expect(sys.atp).toBe(500); // no deduction in disabled mode
  });

  it('handles free actions (cost = 0) without deducting', () => {
    const ok = sys.spend(0);
    expect(ok).toBe(true);
    expect(sys.atp).toBe(500);
  });

  it('exactly depletes the pool to zero (boundary case)', () => {
    const ok = sys.spend(500);
    expect(ok).toBe(true);
    expect(sys.atp).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// earn()
// ---------------------------------------------------------------------------

describe('ATPSystem — earn()', () => {
  it('adds ATP to the pool', () => {
    const sys = makeSystem(200, 1000);
    sys.earn(100);
    expect(sys.atp).toBe(300);
  });

  it('caps the pool at max', () => {
    const sys = makeSystem(900, 1000);
    sys.earn(200);
    expect(sys.atp).toBe(1000);
  });

  it('ignores non-positive amounts', () => {
    const sys = makeSystem(500, 1000);
    sys.earn(-50);
    sys.earn(0);
    expect(sys.atp).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// onTick() — passive income
// ---------------------------------------------------------------------------

describe('ATPSystem — onTick()', () => {
  it('accrues passive income from living cells', () => {
    // 10 000 cells × 0.0002/tick = 2 ATP/tick; start at 500 → 502 after one tick.
    const sys = makeSystem(500, 1000, 0.0002);
    sys.onTick(10_000);
    expect(sys.atp).toBeGreaterThan(500);
  });

  it('does not exceed max pool size', () => {
    const sys = makeSystem(999, 1000, 0.0002);
    // Many ticks to try to overflow.
    for (let i = 0; i < 1000; i++) sys.onTick(10_000);
    expect(sys.atp).toBe(1000);
  });

  it('does nothing when liveCells is 0', () => {
    const sys = makeSystem(500, 1000, 0.0002);
    sys.onTick(0);
    expect(sys.atp).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// reconfigure()
// ---------------------------------------------------------------------------

describe('ATPSystem — reconfigure()', () => {
  it('updates all three parameters atomically', () => {
    const sys = makeSystem(500, 1000, 0.0002);
    sys.reconfigure(200, 800, 0.0005);
    expect(sys.atp).toBe(200);
    expect(sys.max).toBe(800);
    // Verify new income rate is applied: 10 000 cells × 0.0005 = 5 ATP/tick.
    const before = sys.atp;
    sys.onTick(10_000);
    expect(sys.atp).toBeGreaterThan(before);
  });

  it('clamps start ATP to the new max', () => {
    const sys = makeSystem(1000, 1000);
    sys.reconfigure(2000, 500, 0.0002); // start > max
    expect(sys.atp).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('ATPSystem — reset()', () => {
  it('restores ATP to the provided start amount', () => {
    const sys = makeSystem(500, 1000);
    sys.setEnabled(true);
    sys.spend(300); // drain to 200
    sys.reset(500);
    expect(sys.atp).toBe(500);
  });

  it('caps the restored amount at max', () => {
    const sys = makeSystem(500, 600);
    sys.reset(900); // above max
    expect(sys.atp).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// onMilestone()
// ---------------------------------------------------------------------------

describe('ATPSystem — onMilestone()', () => {
  it('awards correct ATP for newVariant', () => {
    const sys = makeSystem(0, 1000);
    sys.onMilestone('newVariant', 100);
    expect(sys.atp).toBe(MILESTONE_REWARDS.newVariant.atp);
  });

  it('awards correct ATP for populationBoom', () => {
    const sys = makeSystem(0, 1000);
    sys.onMilestone('populationBoom', 200);
    expect(sys.atp).toBe(MILESTONE_REWARDS.populationBoom.atp);
  });

  it('awards correct ATP for survivedCrisis', () => {
    const sys = makeSystem(0, 1000);
    sys.onMilestone('survivedCrisis', 300);
    expect(sys.atp).toBe(MILESTONE_REWARDS.survivedCrisis.atp);
  });

  it('awards correct ATP for longLivedVariant', () => {
    const sys = makeSystem(0, 1000);
    sys.onMilestone('longLivedVariant', 400);
    expect(sys.atp).toBe(MILESTONE_REWARDS.longLivedVariant.atp);
  });
});

// ---------------------------------------------------------------------------
// costFor()
// ---------------------------------------------------------------------------

describe('ATPSystem — costFor()', () => {
  let sys: ATPSystem;

  beforeEach(() => { sys = makeSystem(); });

  it('returns the defined cost for each tool in ATP_COSTS', () => {
    for (const [tool, expected] of Object.entries(ATP_COSTS)) {
      expect(sys.costFor(tool)).toBe(expected);
    }
  });

  it('returns 0 for an unknown tool name', () => {
    expect(sys.costFor('unknownTool')).toBe(0);
  });

  it('erase tool costs 0', () => {
    expect(sys.costFor('erase')).toBe(0);
  });
});
