// @ts-check
// GeckoTerminal public API (free, keyless, about 30 calls/min).
// Docs: https://apiguide.geckoterminal.com/
// The free API asks for attribution; the UI footer credits GeckoTerminal.
import { RateLimiter, num } from './provider.js';

/** @typedef {import('../types.js').Snapshot} Snapshot */

const BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const MULTI_MAX = 30; // the multi-pool endpoint takes up to 30 addresses

/** @param {number|null} x */
const positive = (x) => (x !== null && x > 0 ? x : null);

/**
 * Turn one JSON:API pool object into a Snapshot. Defensive about missing
 * fields because the API is labeled beta and new pools often lack data.
 *
 * @param {any} pool         An item of `data`.
 * @param {Map<string, any>} tokens  `included` token objects by id.
 * @param {number} ts
 * @param {number|null} trendingRank
 * @returns {Snapshot|null}  null when there is no usable price.
 */
export function normalizePool(pool, tokens, ts, trendingRank) {
  const a = pool?.attributes ?? {};
  const price = num(a.base_token_price_usd);
  if (price === null || price <= 0) return null;

  const baseRef = pool?.relationships?.base_token?.data?.id ?? '';
  const token = tokens.get(baseRef)?.attributes ?? {};
  const tokenAddress = token.address ?? String(baseRef).replace(/^solana_/, '');
  const pairName = String(a.name ?? '');
  const symbol = token.symbol ?? (pairName.split(' / ')[0] || '?');

  const tx = a.transactions ?? {};
  const vol = a.volume_usd ?? {};
  const chg = a.price_change_percentage ?? {};
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;

  return {
    ts,
    source: 'geckoterminal',
    poolAddress: String(a.address ?? String(pool.id ?? '').replace(/^solana_/, '')),
    tokenAddress: String(tokenAddress),
    symbol: String(symbol),
    name: String(token.name ?? pairName),
    dex: pool?.relationships?.dex?.data?.id ?? null,
    trendingRank,
    priceUsd: price,
    // The API sends 0 or nothing when it has no figure; 0 is never a real market cap.
    marketCapUsd: positive(num(a.market_cap_usd)),
    fdvUsd: positive(num(a.fdv_usd)),
    liquidityUsd: num(a.reserve_in_usd),
    volM5: num(vol.m5),
    volH1: num(vol.h1),
    volH6: num(vol.h6),
    volH24: num(vol.h24),
    buysM5: num(tx.m5?.buys),
    sellsM5: num(tx.m5?.sells),
    buyersM5: num(tx.m5?.buyers),
    sellersM5: num(tx.m5?.sellers),
    buysH1: num(tx.h1?.buys),
    sellsH1: num(tx.h1?.sells),
    buyersH1: num(tx.h1?.buyers),
    sellersH1: num(tx.h1?.sellers),
    buysH24: num(tx.h24?.buys),
    sellsH24: num(tx.h24?.sells),
    priceChangeM5: num(chg.m5),
    priceChangeH1: num(chg.h1),
    poolCreatedAt: Number.isFinite(created) ? created : null,
  };
}

/**
 * @param {any} body  Parsed JSON response.
 * @param {number} ts
 * @param {number|null} rankOffset  Rank of the first item minus one (for paging), or null to leave ranks unset.
 * @returns {Snapshot[]}
 */
export function normalizeResponse(body, ts, rankOffset) {
  const tokens = new Map();
  for (const inc of body?.included ?? []) if (inc?.type === 'token') tokens.set(inc.id, inc);
  /** @type {Snapshot[]} */
  const out = [];
  (body?.data ?? []).forEach((/** @type {any} */ pool, /** @type {number} */ i) => {
    const s = normalizePool(pool, tokens, ts, rankOffset === null ? null : rankOffset + i + 1);
    if (s) out.push(s);
  });
  return out;
}

/**
 * @param {{maxCallsPerMinute: number, trendingPages: number, trendingDuration: string,
 *          fetchImpl?: typeof fetch, now?: () => number}} opts
 * @returns {import('./provider.js').MarketProvider}
 */
export function createGeckoTerminal(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const limiter = new RateLimiter(opts.maxCallsPerMinute, now);

  /** @param {string} pathAndQuery */
  async function get(pathAndQuery) {
    for (let attempt = 0; ; attempt++) {
      await limiter.take();
      const res = await fetchImpl(BASE + pathAndQuery, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 && attempt < 2) {
        const retryAfter = num(res.headers.get('retry-after')) ?? 30;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`GeckoTerminal ${res.status} on ${pathAndQuery}`);
      return res.json();
    }
  }

  return {
    id: 'geckoterminal',
    callsInLastMinute: () => limiter.count(),
    totalCalls: () => limiter.total,

    async fetchTrending() {
      /** @type {Snapshot[]} */
      const all = [];
      for (let page = 1; page <= opts.trendingPages; page++) {
        const ts = now();
        const body = await get(
          `/networks/${NETWORK}/trending_pools?include=base_token&page=${page}&duration=${encodeURIComponent(opts.trendingDuration)}`,
        );
        all.push(...normalizeResponse(body, ts, all.length));
      }
      return all;
    },

    async fetchPools(poolAddresses) {
      /** @type {Snapshot[]} */
      const all = [];
      for (let i = 0; i < poolAddresses.length; i += MULTI_MAX) {
        const chunk = poolAddresses.slice(i, i + MULTI_MAX);
        const ts = now();
        const body = await get(`/networks/${NETWORK}/pools/multi/${chunk.map(encodeURIComponent).join(',')}?include=base_token`);
        all.push(...normalizeResponse(body, ts, null));
      }
      return all;
    },
  };
}
