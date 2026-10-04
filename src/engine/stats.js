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

/** Closed trades needed before a verdict means anything. Matches go-live rule 1. */
export const MIN_TRADES_FOR_VERDICT = 30;

/**
 * @typedef {'too_early'|'no_edge'|'leaning'|'clear'} VerdictLabel
 * @typedef {Object} Verdict
 * @property {VerdictLabel} label
 * @property {string} detail   Plain-words explanation for the UI.
 * @property {number|null} edgePct  Rule's average P&L per trade minus its twin's.
 * @property {number|null} tStat    Welch t statistic of that difference.
 */

/** @param {number[]} xs */
function meanVar(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance };
}

/**
 * Is a rule really beating its random twin, or could it be luck?
 * Compares average P&L per closed trade with a Welch t test:
 * under 30 closed trades -> too early; not ahead -> no edge;
 * ahead by less than about 2 standard errors -> leaning; more -> clear.
 *
 * @param {PaperTrade[]} rule  Closed trades of the rule.
 * @param {PaperTrade[]} twin  Closed trades of its random twin.
 * @returns {Verdict}
 */
export function verdict(rule, twin) {
  const a = rule.map((t) => t.pnlPct ?? 0);
  const b = twin.map((t) => t.pnlPct ?? 0);
  if (a.length < MIN_TRADES_FOR_VERDICT) {
    return { label: 'too_early', detail: `${a.length} of ${MIN_TRADES_FOR_VERDICT} closed trades needed`, edgePct: null, tStat: null };
  }
  if (b.length < 2) {
    return { label: 'too_early', detail: 'random twin has too few closed trades to compare', edgePct: null, tStat: null };
  }
  const x = meanVar(a);
  const y = meanVar(b);
  const edge = x.mean - y.mean;
  const se = Math.sqrt(x.variance / x.n + y.variance / y.n);
  const t = se > 0 ? edge / se : edge > 0 ? Infinity : 0;
  if (edge <= 0) return { label: 'no_edge', detail: 'not ahead of its random twin', edgePct: edge, tStat: t };
  if (t < 2) return { label: 'leaning', detail: 'ahead of random, but luck could explain it', edgePct: edge, tStat: t };
  return { label: 'clear', detail: 'ahead of random by more than luck usually explains', edgePct: edge, tStat: t };
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
 * @typedef {Object} GoLiveCheck
 * @property {string} id
 * @property {string} label   Short plain-words rule, shown on hover.
 * @property {boolean} pass
 * @property {string} detail  Where the rule stands now.
 */

/** Thresholds from the go-live rules (go-live-rules.md, part 2). */
export const GO_LIVE = { minTrades: MIN_TRADES_FOR_VERDICT, minAvgPct: 0.05, paperRunMs: 3 * 3600_000, maxGapMs: 5 * 60_000 };

/**
 * The six go-live checks for one rule, over its closed trades.
 * "Both halves" splits the run's active window at its midpoint in time.
 *
 * @param {PaperTrade[]} rule   Closed trades of the rule.
 * @param {PaperTrade[]} twin   Closed trades of its random twin.
 * @param {{start: number, end: number}} window
 * @returns {GoLiveCheck[]}
 */
export function goLiveChecks(rule, twin, window) {
  const sum = (/** @type {PaperTrade[]} */ ts) => ts.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
  const money = (/** @type {number} */ x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
  const n = rule.length;
  const pnl = sum(rule);
  const twinPnl = sum(twin);
  const avg = n ? rule.reduce((a, t) => a + (t.pnlPct ?? 0), 0) / n : null;
  const best = n ? Math.max(...rule.map((t) => t.pnlUsd ?? 0)) : 0;
  const mid = window.start + (window.end - window.start) / 2;
  const first = sum(rule.filter((t) => (t.closedAt ?? 0) < mid));
  const second = sum(rule.filter((t) => (t.closedAt ?? 0) >= mid));
  return [
    { id: 'trades', label: `At least ${GO_LIVE.minTrades} closed trades`, pass: n >= GO_LIVE.minTrades, detail: `${n} closed` },
    { id: 'profit', label: 'Total profit is positive', pass: n > 0 && pnl > 0, detail: money(pnl) },
    { id: 'random', label: 'Made more than its random twin', pass: n > 0 && pnl > twinPnl, detail: `${money(pnl)} vs ${money(twinPnl)}` },
    {
      id: 'average',
      label: `Average trade +${GO_LIVE.minAvgPct * 100}% or better`,
      pass: avg !== null && avg >= GO_LIVE.minAvgPct,
      detail: avg === null ? 'no trades yet' : `${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)}%`,
    },
    { id: 'best', label: 'Still positive without its best trade', pass: n > 1 && pnl - best > 0, detail: money(pnl - best) },
    { id: 'halves', label: 'Positive in both halves of the run', pass: n > 0 && first > 0 && second > 0, detail: `${money(first)} then ${money(second)}` },
  ];
}

/**
 * @typedef {BookResult & {strategy: string, twin: BookResult|null, verdict: Verdict|null, checks: GoLiveCheck[]|null}} StrategyResult
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
 * @param {{start: number, end: number}} [a.window]  The run's time span, for the "both halves" check.
 * @returns {StrategyResult[]}
 */
export function strategyResults({ trades, strategies, startingBankroll, latestPrice, window }) {
  const closedIn = (/** @type {string} */ book) => trades.filter((t) => t.book === book && t.status === 'closed');
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
    verdict: verdict(closedIn(strategy), closedIn(`${RANDOM_STRATEGY}:${strategy}`)),
    checks: goLiveChecks(closedIn(strategy), closedIn(`${RANDOM_STRATEGY}:${strategy}`), window ?? spanOf(trades)),
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
    verdict: null,
    checks: null,
  };
  return [...rows, randomRow];
}

/** @param {PaperTrade[]} trades */
function spanOf(trades) {
  const ts = trades.flatMap((t) => [t.signalAt, t.closedAt ?? t.signalAt]);
  return ts.length ? { start: Math.min(...ts), end: Math.max(...ts) } : { start: 0, end: 0 };
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
