// @ts-check
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
 * @typedef {Object} RunSettings
 * @property {number} engine
 * @property {number|null} startingBankrollUsd
 * @property {Partial<import('../types.js').TradeRules>} trade
 * @property {Partial<{minLiquidityUsd: number, minSellsM5: number}>|null} universe  Null when not recorded (older versions).
 * @property {Record<string, Record<string, number>>} signals  Params per signal id.
 */

/**
 * The settings that decide a run's results.
 * @param {import('../config.js').Config} config
 * @param {import('../types.js').SignalModule[]} signals
 * @returns {RunSettings}
 */
export function runSettings(config, signals) {
  return {
    engine: ENGINE_VERSION,
    startingBankrollUsd: config.startingBankrollUsd,
    trade: { ...config.trade },
    universe: { ...config.universe },
    signals: Object.fromEntries(signals.map((s) => [s.id, { ...s.params }])),
  };
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
 * Whether new settings can continue an existing run. Adding or removing a
 * signal file does not start a new run (each signal has its own books), but
 * changing any shared rule, or a kept signal's parameters, does.
 * @param {RunSettings} prev
 * @param {RunSettings} next
 */
export function canContinue(prev, next) {
  if (prev.engine !== next.engine) return false;
  if (prev.startingBankrollUsd !== next.startingBankrollUsd) return false;
  if (!same(prev.trade, next.trade) || !same(prev.universe, next.universe)) return false;
  for (const id of Object.keys(next.signals)) {
    if (id in prev.signals && !same(prev.signals[id], next.signals[id])) return false;
  }
  return true;
}
