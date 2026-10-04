// @ts-check
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {Object} Config
 * @property {string} host
 * @property {number} port
 * @property {string} dbPath
 * @property {'geckoterminal'|'simulated'} provider
 * @property {number} pollIntervalSec
 * @property {number} trendingPages        Trending pages fetched per poll (20 pools per page).
 * @property {'5m'|'1h'|'6h'|'24h'} trendingDuration
 * @property {number} maxCallsPerMinute     Our own ceiling, kept under GeckoTerminal's 30.
 * @property {number} startingBankrollUsd   Per strategy.
 * @property {{minLiquidityUsd: number, minSellsM5: number}} universe  Filter applied to signal and random picks alike.
 *   minSellsM5 guards against coins you can buy but not sell.
 * @property {import('./types.js').TradeRules} trade
 * @property {Record<string, Record<string, number>>} signalParams  Per-signal overrides, keyed by signal id.
 * @property {{enabled: boolean, model: string, effort: 'low'|'medium'|'high'}} ai
 */

/** @type {Config} */
export const DEFAULTS = {
  host: '127.0.0.1',
  port: 4317,
  dbPath: path.join(ROOT, 'data', 'paper.sqlite'),
  provider: 'geckoterminal',
  pollIntervalSec: 60,
  trendingPages: 1,
  trendingDuration: '1h',
  maxCallsPerMinute: 25,
  startingBankrollUsd: 1000,
  // Matches the live trading rules: only coins you could really trade.
  universe: { minLiquidityUsd: 100_000, minSellsM5: 1 },
  trade: {
    sizeUsd: 50,
    feeRate: 0.003,
    slippageRate: 0.015,
    maxChasePct: 0.05,
    collapseLiquidityRatio: 0.2,
    stopLossPct: 0.2,
    takeProfitPct: 0.4,
    timeLimitMin: 60,
    reentryCooldownMin: 30,
    staleAfterMin: 5,
  },
  signalParams: {},
  ai: { enabled: false, model: 'claude-opus-5-5', effort: 'low' },
};

/**
 * @param {any} base
 * @param {any} over
 * @returns {any}
 */
function deepMerge(base, over) {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  /** @type {any} */
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = deepMerge(base[k], v);
  return out;
}

/**
 * Defaults, then config.local.json (if present), then a few CLI flags.
 * @param {string[]} [argv]
 * @returns {Config}
 */
export function loadConfig(argv = process.argv.slice(2)) {
  /** @type {Config} */
  let cfg = DEFAULTS;
  const localPath = path.join(ROOT, 'config.local.json');
  if (existsSync(localPath)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(localPath, 'utf8')));
  }
  if (argv.includes('--demo')) {
    // Simulated data goes to its own database so it can never mix with real research data.
    cfg = deepMerge(cfg, {
      provider: 'simulated',
      dbPath: path.join(ROOT, 'data', 'demo.sqlite'),
      pollIntervalSec: 5,
      // Shorter clocks so trades open and close within a few minutes of watching.
      trade: { timeLimitMin: 3, reentryCooldownMin: 1, staleAfterMin: 1 },
    });
  }
  const portArg = argv.find((a) => a.startsWith('--port='));
  if (portArg) cfg = deepMerge(cfg, { port: Number(portArg.split('=')[1]) });
  return cfg;
}
