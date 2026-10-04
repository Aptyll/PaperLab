// @ts-check
import { RANDOM_STRATEGY } from './signal-loader.js';

/** @typedef {import('../types.js').StrategyDef} StrategyDef */
/** @typedef {import('../types.js').Strategy} Strategy */
/** @typedef {import('../types.js').SignalModule} SignalModule */

/** Exit settings a strategy may set for itself. Everything else in TradeRules is shared. */
export const EXIT_KEYS = /** @type {const} */ (['sizeUsd', 'stopLossPct', 'takeProfitPct', 'timeLimitMin']);

/**
 * Turn strategy definitions into ready-to-trade strategies. A rule file with
 * no strategy listed still trades, under its own id and name, so adding a rule
 * is still just adding a file.
 *
 * @param {StrategyDef[]} defs
 * @param {SignalModule[]} signals   Loaded rules, with config overrides already applied.
 * @param {import('../types.js').TradeRules} defaults
 * @returns {Strategy[]}
 */
export function resolveStrategies(defs, signals, defaults) {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const seen = new Set();
  /** @type {Strategy[]} */
  const out = [];
  for (const d of defs) {
    const signal = byId.get(d.signal);
    if (!signal) throw new Error(`Strategy ${d.codeName} uses unknown rule "${d.signal}"`);
    if (!/^[a-z0-9-]+$/.test(d.id) || d.id === RANDOM_STRATEGY) throw new Error(`Bad strategy id "${d.id}"`);
    if (seen.has(d.id)) throw new Error(`Duplicate strategy id "${d.id}"`);
    seen.add(d.id);
    out.push({
      id: d.id,
      codeName: d.codeName,
      signal,
      params: { ...signal.params, ...(d.params ?? {}) },
      trade: { ...defaults, ...(d.exits ?? {}) },
      retired: d.retired ?? false,
    });
  }
  for (const s of signals) {
    if (out.some((x) => x.signal.id === s.id)) continue;
    if (seen.has(s.id)) throw new Error(`Rule id "${s.id}" clashes with a strategy id`);
    out.push({ id: s.id, codeName: s.name, signal: s, params: s.params, trade: { ...defaults }, retired: false });
  }
  return out;
}

/** Plain description of a strategy's exits, e.g. "−20% / +40% / 60 min". @param {import('../types.js').TradeRules} t */
export function exitsText(t) {
  const p = (/** @type {number} */ x) => `${+(x * 100).toFixed(2)}%`;
  return `−${p(t.stopLossPct)} / +${p(t.takeProfitPct)} / ${t.timeLimitMin} min`;
}
