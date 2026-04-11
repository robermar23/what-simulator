/**
 * @fileoverview Lightweight performance counters for the What Simulator.
 *
 * Provides an FPS counter for the render loop and a tick counter for the
 * simulation loop.  Neither counter allocates on the hot path.
 */

// ---------------------------------------------------------------------------
// FPS Counter
// ---------------------------------------------------------------------------

/**
 * Rolling-window FPS counter.  Call {@link FpsCounter.frame} once per
 * rendered frame; read {@link FpsCounter.fps} to get the smoothed value.
 *
 * The window size controls smoothing: larger = smoother but slower to react.
 */
export class FpsCounter {
  /** Circular buffer of recent frame timestamps (milliseconds). */
  private readonly _timestamps: Float64Array;
  /** Current write position in the circular buffer. */
  private _head = 0;
  /** How many timestamps have been recorded so far. */
  private _count = 0;

  /**
   * @param windowSize - Number of frames to average over (default 60).
   */
  constructor(private readonly windowSize = 60) {
    this._timestamps = new Float64Array(windowSize);
  }

  /**
   * Records a new frame at the given timestamp.
   * Call this at the top of each `requestAnimationFrame` callback.
   *
   * @param now - Current time in milliseconds (e.g. from `performance.now()`).
   */
  frame(now: number): void {
    this._timestamps[this._head] = now;
    this._head = (this._head + 1) % this.windowSize;
    if (this._count < this.windowSize) this._count++;
  }

  /**
   * Returns the smoothed frames-per-second value based on the rolling window.
   * Returns 0 if fewer than 2 frames have been recorded.
   *
   * @returns Current FPS estimate.
   */
  get fps(): number {
    if (this._count < 2) return 0;

    // The oldest recorded timestamp is at (head) in the circular buffer.
    const oldest =
      this._timestamps[(this._head - this._count + this.windowSize) % this.windowSize];
    const newest =
      this._timestamps[(this._head - 1 + this.windowSize) % this.windowSize];

    const elapsed = newest - oldest;
    if (elapsed <= 0) return 0;

    return ((this._count - 1) / elapsed) * 1000;
  }
}

// ---------------------------------------------------------------------------
// Tick Counter
// ---------------------------------------------------------------------------

/**
 * Simple monotonically increasing simulation tick counter.
 * Owns the tick number so other modules never mutate it directly.
 */
export class TickCounter {
  private _tick = 0;

  /**
   * Advances the counter by one and returns the new tick number.
   *
   * @returns New tick number.
   */
  advance(): number {
    return ++this._tick;
  }

  /**
   * Returns the current tick number without advancing it.
   *
   * @returns Current tick number.
   */
  get current(): number {
    return this._tick;
  }

  /**
   * Resets the counter to zero.
   */
  reset(): void {
    this._tick = 0;
  }
}
