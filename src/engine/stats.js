// @ts-check
import { liquidationValue } from './paper.js';
import { RANDOM_STRATEGY } from './signal-loader.js';

/** @typedef {import('../types.js').PaperTrade} PaperTrade */

/**
 * Wilson score interval for a proportion (95% by default). Honest error bars
 * for win rates computed from few trades.
 * @param {number} wins
 * @param {number} n
 * @param {number} [z]
 * @returns {[number, number]|null}
 */
export function wilson(wins, n, z = 1.96) {
  if (n === 0) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * @typedef {Object} TradeSummary
 * @property {number} closed
 * @property {number} wins
 * @property {number|null} winRate
 * @property {[number, number]|null} winRateCi
 * @property {number} pnlUsd
 * @property {number|null} avgPnlPct
 * @property {number|null} medianPnlPct
 */

/**
 * @param {PaperTrade[]} trades  Closed trades only.
 * @returns {TradeSummary}
 */
export function summarize(trades) {
  const pnls = trades.map((t) => t.pnlPct ?? 0).sort((a, b) => a - b);
  const wins = trades.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  const n = trades.length;
  const mid = Math.floor(n / 2);
  return {
    closed: n,
    wins,
    winRate: n ? wins / n : null,
    winRateCi: wilson(wins, n),
    pnlUsd: trades.reduce((a, t) => a + (t.pnlUsd ?? 0), 0),
    avgPnlPct: n ? pnls.reduce((a, b) => a + b, 0) / n : null,
    medianPnlPct: n ? (n % 2 ? pnls[mid] : (pnls[mid - 1] + pnls[mid]) / 2) : null,
  };
}

/**
 * @typedef {Object} BookResult
 * @property {number} open
 * @property {number} pending
 * @property {number} cancelled
 * @property {number} cashUsd
 * @property {number} equityUsd         Cash plus open positions marked to their latest price, after exit costs.
 * @property {number} unrealizedPnlUsd
 * @property {TradeSummary} all
 * @property {Record<string, number>} exitReasons
 * @property {{t: number, equity: number}[]} equityCurve  Realized only, by close time.
 */

/**
 * @typedef {BookResult & {strategy: string, twin: BookResult|null}} StrategyResult
 *   `twin` is the signal's random control book (null for the random row itself).
 *   For the random row, money fields are averages across all twins.
 */

/**
 * @param {PaperTrade[]} mine
 * @param {number} startingBankroll
 * @param {(poolAddress: string) => {price: number, liquidityUsd: number|null}|null} latestPrice
 * @returns {BookResult}
 */
function bookResult(mine, startingBankroll, latestPrice) {
  const closed = mine.filter((t) => t.status === 'closed');
  const open = mine.filter((t) => t.status === 'open');
  const pending = mine.filter((t) => t.status === 'pending');
  let unrealized = 0;
  for (const t of open) {
    const m = latestPrice(t.poolAddress);
    if (m !== null) unrealized += liquidationValue(t, m.price, m.liquidityUsd).proceedsUsd - t.sizeUsd;
  }
  const realized = closed.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
  const locked = [...open, ...pending].reduce((a, t) => a + t.sizeUsd, 0);
  /** @type {Record<string, number>} */
  const exitReasons = {};
  for (const t of closed) exitReasons[t.exitReason ?? 'unknown'] = (exitReasons[t.exitReason ?? 'unknown'] ?? 0) + 1;
  let eq = startingBankroll;
  const equityCurve = [...closed]
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
    .map((t) => ({ t: t.closedAt ?? 0, equity: (eq += t.pnlUsd ?? 0) }));
  return {
    open: open.length,
    pending: pending.length,
    cancelled: mine.filter((t) => t.status === 'cancelled').length,
    cashUsd: startingBankroll + realized - locked,
    equityUsd: startingBankroll + realized + unrealized,
    unrealizedPnlUsd: unrealized,
    all: summarize(closed),
    exitReasons,
    equityCurve,
  };
}

/**
 * @param {Object} a
 * @param {PaperTrade[]} a.trades          All trades.
 * @param {string[]} a.strategies          Signal ids, in display order (random is added last).
 * @param {number} a.startingBankroll      Per book.
 * @param {(poolAddress: string) => {price: number, liquidityUsd: number|null}|null} a.latestPrice
 * @returns {StrategyResult[]}
 */
export function strategyResults({ trades, strategies, startingBankroll, latestPrice }) {
  const rows = strategies.map((strategy) => ({
    strategy,
    ...bookResult(
      trades.filter((t) => t.book === strategy),
      startingBankroll,
      latestPrice,
    ),
    twin: bookResult(
      trades.filter((t) => t.book === `${RANDOM_STRATEGY}:${strategy}`),
      startingBankroll,
      latestPrice,
    ),
  }));
  const randomAll = bookResult(
    trades.filter((t) => t.strategy === RANDOM_STRATEGY),
    startingBankroll,
    latestPrice,
  );
  const twins = rows.map((r) => /** @type {BookResult} */ (r.twin));
  const avg = (/** @type {(b: BookResult) => number} */ f) =>
    twins.length ? twins.reduce((a, b) => a + f(b), 0) / twins.length : startingBankroll;
  /** @type {StrategyResult} */
  const randomRow = {
    strategy: RANDOM_STRATEGY,
    ...randomAll,
    cashUsd: avg((b) => b.cashUsd),
    equityUsd: avg((b) => b.equityUsd),
    unrealizedPnlUsd: avg((b) => b.unrealizedPnlUsd),
    equityCurve: [],
    twin: null,
  };
  return [...rows, randomRow];
}

/**
 * Calibration of AI probability estimates against outcomes (win = closed in profit).
 * @param {PaperTrade[]} trades
 */
export function calibration(trades) {
  const scored = trades.filter((t) => t.status === 'closed' && t.aiProbability !== null);
  if (!scored.length) return { n: 0, brier: null, baselineBrier: null, buckets: [] };
  const outcome = (/** @type {PaperTrade} */ t) => ((t.pnlUsd ?? 0) > 0 ? 1 : 0);
  const brier = scored.reduce((a, t) => a + ((t.aiProbability ?? 0) - outcome(t)) ** 2, 0) / scored.length;
  // Baseline: always predicting the observed base rate. A useful model beats this.
  const base = scored.reduce((a, t) => a + outcome(t), 0) / scored.length;
  const baselineBrier = scored.reduce((a, t) => a + (base - outcome(t)) ** 2, 0) / scored.length;
  const buckets = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const inB = scored.filter((t) => {
      const p = t.aiProbability ?? 0;
      return p >= lo && (i === 9 ? p <= hi : p < hi);
    });
    if (!inB.length) continue;
    buckets.push({
      range: [lo, hi],
      n: inB.length,
      avgPredicted: inB.reduce((a, t) => a + (t.aiProbability ?? 0), 0) / inB.length,
      actualWinRate: inB.reduce((a, t) => a + outcome(t), 0) / inB.length,
    });
  }
  return { n: scored.length, brier, baselineBrier, buckets };
}
