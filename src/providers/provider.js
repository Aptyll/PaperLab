// @ts-check

/**
 * A market data source. Adding another source (DexScreener, Codex, ...) means
 * writing one file that returns this shape and registering it in main.js.
 *
 * @typedef {Object} MarketProvider
 * @property {string} id
 * @property {() => Promise<import('../types.js').Snapshot[]>} fetchTrending
 *   Current trending pools, with trendingRank set.
 * @property {(poolAddresses: string[]) => Promise<import('../types.js').Snapshot[]>} fetchPools
 *   Fresh snapshots for specific pools (used for pools with open trades that left the trending list).
 * @property {() => number} callsInLastMinute
 * @property {() => number} totalCalls   Calls made since start.
 */

/**
 * Sliding-window limiter: at most `max` calls in any 60 second window.
 * Waits instead of failing, so callers never exceed the provider's limit.
 */
export class RateLimiter {
  /**
   * @param {number} max
   * @param {() => number} [now]
   * @param {(ms: number) => Promise<void>} [sleep]
   */
  constructor(max, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.max = max;
    this.now = now;
    this.sleep = sleep;
    /** @type {number[]} */
    this.calls = [];
    this.total = 0;
  }

  prune() {
    const cutoff = this.now() - 60_000;
    while (this.calls.length && this.calls[0] <= cutoff) this.calls.shift();
  }

  count() {
    this.prune();
    return this.calls.length;
  }

  async take() {
    for (;;) {
      this.prune();
      if (this.calls.length < this.max) {
        this.calls.push(this.now());
        this.total++;
        return;
      }
      await this.sleep(this.calls[0] + 60_000 - this.now() + 50);
    }
  }
}

/**
 * Parse a numeric API value that may be a string, number, null or missing.
 * @param {unknown} v
 * @returns {number|null}
 */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
