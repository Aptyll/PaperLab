// @ts-check
// Fake market for `npm run demo`: lets you see the dashboard work without any
// network access. Its numbers mean nothing and it writes to a separate database.

/** @typedef {import('../types.js').Snapshot} Snapshot */

/**
 * Small seeded PRNG so a demo run is repeatable.
 * @param {number} seed
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {Object} SimPool
 * @property {string} pool
 * @property {string} token
 * @property {string} symbol
 * @property {number} price
 * @property {number} supply
 * @property {number} liquidity
 * @property {number} hype      0..1, drives volume and buy pressure.
 * @property {number} createdAt
 * @property {number[]} volHist  Per-tick volume, newest last.
 * @property {{buys: number, sells: number}[]} txHist
 */

/**
 * @param {{seed?: number, pools?: number, tickMs?: number, now?: () => number}} [opts]
 * @returns {import('./provider.js').MarketProvider}
 */
export function createSimulated(opts = {}) {
  const rand = mulberry32(opts.seed ?? 42);
  const now = opts.now ?? Date.now;
  // Each fetch counts as this much market time, so trades resolve quickly in a demo.
  const tickMs = opts.tickMs ?? 60_000;
  let counter = 0;
  /** @type {SimPool[]} */
  let pools = [];

  const hex = () => Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0');

  function spawn() {
    counter++;
    return {
      pool: `SIMPOOL${counter}${hex()}`,
      token: `SIMTOKEN${counter}${hex()}`,
      symbol: `SIM${counter}`,
      price: 0.00001 * (1 + rand() * 50),
      supply: 1e9,
      liquidity: 60_000 + rand() * 900_000,
      hype: rand(),
      createdAt: now() - Math.floor(rand() * 6 * 3600_000),
      volHist: [],
      txHist: [],
    };
  }

  for (let i = 0; i < (opts.pools ?? 25); i++) pools.push(spawn());

  /** @param {SimPool} p */
  function step(p) {
    p.hype = Math.min(1, Math.max(0, p.hype + (rand() - 0.5) * 0.25));
    const drift = (p.hype - 0.5) * 0.04;
    let ret = drift + (rand() - 0.5) * 0.12;
    const rug = rand() < 0.01; // occasional rug
    if (rug) ret = -0.7;
    if (rand() < 0.02) ret += 0.5; // occasional pump
    p.price = Math.max(1e-12, p.price * (1 + ret));
    p.liquidity = Math.max(500, p.liquidity * (1 + ret * 0.5));
    if (rug) p.liquidity *= 0.1; // a rug drains the pool
    const vol = p.liquidity * (0.05 + p.hype * 0.6) * (rand() < 0.05 ? 6 : 1);
    const txs = Math.round(vol / 150);
    const buyShare = Math.min(0.95, Math.max(0.05, 0.5 + (p.hype - 0.5) * 0.6 + (rand() - 0.5) * 0.2));
    p.volHist.push(vol);
    p.txHist.push({ buys: Math.round(txs * buyShare), sells: Math.round(txs * (1 - buyShare)) });
    if (p.volHist.length > 1440) (p.volHist.shift(), p.txHist.shift());
  }

  /**
   * Sum of the last `ticks` entries, scaled so one tick represents tickMs of market time.
   * @param {number[]} arr
   * @param {number} minutes
   */
  const sumLast = (arr, minutes) => {
    const ticks = Math.max(1, Math.round((minutes * 60_000) / tickMs));
    return arr.slice(-ticks).reduce((a, b) => a + b, 0);
  };

  /**
   * @param {SimPool} p
   * @param {number|null} rank
   * @param {number} ts
   * @returns {Snapshot}
   */
  function toSnapshot(p, rank, ts) {
    const txm = (/** @type {number} */ min) => {
      const ticks = Math.max(1, Math.round((min * 60_000) / tickMs));
      const s = p.txHist.slice(-ticks);
      return { buys: s.reduce((a, b) => a + b.buys, 0), sells: s.reduce((a, b) => a + b.sells, 0) };
    };
    const m5 = txm(5);
    const h1 = txm(60);
    const h24 = txm(1440);
    const mcap = p.price * p.supply;
    return {
      ts,
      source: 'simulated',
      poolAddress: p.pool,
      tokenAddress: p.token,
      symbol: p.symbol,
      name: `Simulated ${p.symbol}`,
      dex: 'sim',
      trendingRank: rank,
      priceUsd: p.price,
      marketCapUsd: rand() < 0.3 ? null : mcap,
      fdvUsd: mcap,
      liquidityUsd: p.liquidity,
      volM5: sumLast(p.volHist, 5),
      volH1: sumLast(p.volHist, 60),
      volH6: sumLast(p.volHist, 360),
      volH24: sumLast(p.volHist, 1440),
      buysM5: m5.buys,
      sellsM5: m5.sells,
      buyersM5: Math.round(m5.buys * 0.7),
      sellersM5: Math.round(m5.sells * 0.7),
      buysH1: h1.buys,
      sellsH1: h1.sells,
      buyersH1: Math.round(h1.buys * 0.6),
      sellersH1: Math.round(h1.sells * 0.6),
      buysH24: h24.buys,
      sellsH24: h24.sells,
      priceChangeM5: null,
      priceChangeH1: null,
      poolCreatedAt: p.createdAt,
    };
  }

  /** @type {Map<string, SimPool>} */
  const retired = new Map();

  return {
    id: 'simulated',
    callsInLastMinute: () => 0,
    totalCalls: () => 0,

    async fetchTrending() {
      for (const p of pools) step(p);
      for (const p of retired.values()) step(p);
      // Churn: the least hyped pool sometimes drops off and a new one appears.
      if (rand() < 0.15) {
        pools.sort((a, b) => a.hype - b.hype);
        const gone = /** @type {SimPool} */ (pools.shift());
        retired.set(gone.pool, gone);
        pools.push(spawn());
      }
      const ts = now();
      return [...pools].sort((a, b) => b.hype - a.hype).map((p, i) => toSnapshot(p, i + 1, ts));
    },

    async fetchPools(addresses) {
      const ts = now();
      return addresses
        .map((a) => retired.get(a))
        .filter((p) => p !== undefined)
        .map((p) => toSnapshot(/** @type {SimPool} */ (p), null, ts));
    },
  };
}
