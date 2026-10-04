// @ts-check
import { EXIT_KEYS } from './strategies.js';
// A "run" is one stretch of paper trading under one set of rules. Results
// from different rules shouldn't be added together, but they shouldn't be
// thrown away either: every run stays in the database and can be viewed later.

/**
 * Bump when the paper-trading math changes in a way that makes old results
 * not comparable (fills, costs, exits). Starts a new run on the next start.
 * 1: instant fills at the signal price, flat costs.
 * 2: next-poll fills, chase cancel, price impact, collapse exits, liquidity floor.
 */
export const ENGINE_VERSION = 2;

/**
 * @typedef {Object} StrategySettings
 * @property {string} signal
 * @property {Record<string, number>} params
 * @property {Record<string, number>} exits   sizeUsd, stopLossPct, takeProfitPct, timeLimitMin.
 * @property {boolean} [skipCopycats]  Skips copycat tickers; absent when off.
 */

/**
 * @typedef {Object} RunSettings
 * @property {number} engine
 * @property {number|null} startingBankrollUsd
 * @property {Partial<import('../types.js').TradeRules>} trade   Defaults; costs here are shared by every strategy.
 * @property {Partial<{minLiquidityUsd: number, minSellsM5: number}>|null} universe  Null when not recorded (older versions).
 * @property {Record<string, Record<string, number>>} signals  Rule settings per strategy id (kept for older runs).
 * @property {Record<string, StrategySettings>} [strategies]   Missing in runs recorded before strategies existed.
 */

/** @param {import('../types.js').TradeRules|Partial<import('../types.js').TradeRules>} t */
const exitsOf = (t) => Object.fromEntries(EXIT_KEYS.filter((k) => t[k] !== undefined).map((k) => [k, /** @type {number} */ (t[k])]));

/** @param {Partial<import('../types.js').TradeRules>} t */
const sharedOf = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !(/** @type {readonly string[]} */ (EXIT_KEYS)).includes(k)));

/**
 * The settings that decide a run's results.
 * @param {import('../config.js').Config} config
 * @param {import('../types.js').Strategy[]} strategies
 * @returns {RunSettings}
 */
export function runSettings(config, strategies) {
  return {
    engine: ENGINE_VERSION,
    startingBankrollUsd: config.startingBankrollUsd,
    trade: { ...config.trade },
    universe: { ...config.universe },
    signals: Object.fromEntries(strategies.map((s) => [s.id, { ...s.params }])),
    strategies: Object.fromEntries(
      // skipCopycats is only recorded when set, so strategies without it keep the settings their runs were recorded with.
      strategies.map((s) => [s.id, { signal: s.signal.id, params: { ...s.params }, exits: exitsOf(s.trade), ...(s.skipCopycats ? { skipCopycats: true } : {}) }]),
    ),
  };
}

/**
 * Per-strategy settings, also for runs recorded before strategies existed:
 * then every strategy was one rule, under the rule's id, with the run's exits.
 * @param {RunSettings} r
 * @returns {Record<string, StrategySettings>}
 */
export function strategiesOf(r) {
  if (r.strategies) return r.strategies;
  return Object.fromEntries(Object.entries(r.signals ?? {}).map(([id, params]) => [id, { signal: id, params, exits: exitsOf(r.trade ?? {}) }]));
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/** @param {any} v @returns {any} */
function sortKeys(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}

/**
 * Whether new settings can continue an existing run. Strategies may be added
 * or retired freely (each has its own books); a strategy that exists in both
 * must keep its rule, rule settings and exits. Shared settings (costs, coin
 * filter, bankroll, trade simulation) must not change.
 * @param {RunSettings} prev
 * @param {RunSettings} next
 */
export function canContinue(prev, next) {
  if (prev.engine !== next.engine) return false;
  if (prev.startingBankrollUsd !== next.startingBankrollUsd) return false;
  if (!same(sharedOf(prev.trade ?? {}), sharedOf(next.trade ?? {})) || !same(prev.universe, next.universe)) return false;
  const a = strategiesOf(prev);
  const b = strategiesOf(next);
  for (const id of Object.keys(b)) {
    if (id in a && !same(a[id], b[id])) return false;
  }
  return true;
}
