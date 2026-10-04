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
/** Below this the luck test can't say anything useful. Only the luck test uses it; nothing waits on a trade count. */
export const MIN_TRADES_FOR_VERDICT = 10;

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

/** Upper tail of the standard normal, P(Z > z). Abramowitz-Stegun 7.1.26, error under 1e-7. @param {number} z */
function normalTail(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/**
 * How many standard errors ahead a strategy must be before "could be luck"
 * goes away. One strategy: 2 (about a 2% chance by luck). Testing more
 * strategies gives luck more tries, so the bar rises to keep the chance that
 * any of them clears it by luck about the same (Bonferroni):
 * about 2.4 for three strategies, 2.7 for six.
 * @param {number} tested  Strategies tested in the run, retired ones included.
 */
export function luckBar(tested) {
  const target = normalTail(2) / Math.max(1, tested);
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalTail(mid) > target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Is a rule really beating its random twin, or could it be luck?
 * Compares average P&L per closed trade with a Welch t test:
 * under 30 closed trades -> too early; not ahead -> no edge;
 * ahead by less than luckBar(tested) standard errors -> leaning; more -> clear.
 *
 * @param {PaperTrade[]} rule  Closed trades of the rule.
 * @param {PaperTrade[]} twin  Closed trades of its random twin.
 * @param {number} [tested]    Strategies tested side by side in the run.
 * @returns {Verdict}
 */
export function verdict(rule, twin, tested = 1) {
  const a = rule.map((t) => t.pnlPct ?? 0);
  const b = twin.map((t) => t.pnlPct ?? 0);
  if (a.length < MIN_TRADES_FOR_VERDICT) {
    return { label: 'too_early', detail: `${a.length} of ${MIN_TRADES_FOR_VERDICT} closed trades needed`, edgePct: null, tStat: null };
  }
  if (b.length < 2) {
    return { label: 'too_early', detail: 'its random picker has too few closed trades to compare', edgePct: null, tStat: null };
  }
  const x = meanVar(a);
  const y = meanVar(b);
  const edge = x.mean - y.mean;
  const se = Math.sqrt(x.variance / x.n + y.variance / y.n);
  const t = se > 0 ? edge / se : edge > 0 ? Infinity : 0;
  if (edge <= 0) return { label: 'no_edge', detail: 'not ahead of its random picker', edgePct: edge, tStat: t };
  if (t < luckBar(tested)) return { label: 'leaning', detail: 'ahead of random, but luck could explain it', edgePct: edge, tStat: t };
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
 * @property {{t: number, equity: number}[]} valueCurve   Balance at each timeline moment, open trades as if sold then. Empty without a timeline.
 */

/**
 * @typedef {Object} Timeline
 * @property {number[]} times  Moments to value the books at, oldest first.
 * @property {(poolAddress: string, t: number) => {price: number, liquidityUsd: number|null}|null} priceAt  Latest saved price at or before t.
 */

/**
 * Price lookup over saved snapshots: the latest price at or before a moment.
 * @param {{poolAddress: string, ts: number, priceUsd: number, liquidityUsd: number|null}[]} rows  Oldest first.
 * @returns {Timeline['priceAt']}
 */
export function priceHistory(rows) {
  /** @type {Map<string, {ts: number[], price: number[], liq: (number|null)[]}>} */
  const byPool = new Map();
  for (const r of rows) {
    let h = byPool.get(r.poolAddress);
    if (!h) byPool.set(r.poolAddress, (h = { ts: [], price: [], liq: [] }));
    h.ts.push(r.ts);
    h.price.push(r.priceUsd);
    h.liq.push(r.liquidityUsd);
  }
  return (pool, t) => {
    const h = byPool.get(pool);
    if (!h || h.ts[0] > t) return null;
    let lo = 0;
    let hi = h.ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (h.ts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return { price: h.price[lo], liquidityUsd: h.liq[lo] };
  };
}

/**
 * A book's balance at each moment: finished trades' profit plus open trades as
 * if sold at that moment's saved price, after costs. The same sum as equityUsd,
 * taken back in time. An open trade with no saved price yet counts at cost.
 * @param {PaperTrade[]} mine
 * @param {number} startingBankroll
 * @param {Timeline} timeline
 */
function valueCurve(mine, startingBankroll, { times, priceAt }) {
  const filled = mine.filter((t) => (t.status === 'open' || t.status === 'closed') && t.openedAt !== null);
  const closes = filled.filter((t) => t.status === 'closed').sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const opens = [...filled].sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
  let realized = 0;
  let ci = 0;
  let oi = 0;
  /** @type {Set<PaperTrade>} */
  const held = new Set();
  return times.map((at) => {
    while (oi < opens.length && (opens[oi].openedAt ?? 0) <= at) held.add(opens[oi++]);
    while (ci < closes.length && (closes[ci].closedAt ?? 0) <= at) {
      realized += closes[ci].pnlUsd ?? 0;
      held.delete(closes[ci++]);
    }
    let unrealized = 0;
    for (const t of held) {
      const m = priceAt(t.poolAddress, at);
      if (m !== null) unrealized += liquidationValue(t, m.price, m.liquidityUsd).proceedsUsd - t.sizeUsd;
    }
    return { t: at, equity: startingBankroll + realized + unrealized };
  });
}

/**
 * @typedef {Object} GoLiveCheck
 * @property {string} id
 * @property {string} label   Short plain-words rule, shown on hover.
 * @property {boolean} pass
 * @property {string} detail  Where the rule stands now.
 */

/** Thresholds from the go-live rules (go-live-rules.md, part 2). */
export const GO_LIVE = { minAvgPct: 0.05, paperRunMs: 3 * 3600_000, maxGapMs: 5 * 60_000 };

/**
 * The five go-live checks for one rule (Noah dropped the 30-trade minimum: he decides when it's enough), over its closed trades.
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
    { id: 'profit', label: 'Total profit is positive', pass: n > 0 && pnl > 0, detail: money(pnl) },
    { id: 'random', label: 'Made more than its random picker', pass: n > 0 && pnl > twinPnl, detail: `${money(pnl)} vs ${money(twinPnl)}` },
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
 * @param {Timeline} [timeline]
 * @returns {BookResult}
 */
function bookResult(mine, startingBankroll, latestPrice, timeline) {
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
    valueCurve: timeline ? valueCurve(mine, startingBankroll, timeline) : [],
  };
}

/**
 * @param {Object} a
 * @param {PaperTrade[]} a.trades          All trades.
 * @param {string[]} a.strategies          Signal ids, in display order (random is added last).
 * @param {number} a.startingBankroll      Per book.
 * @param {(poolAddress: string) => {price: number, liquidityUsd: number|null}|null} a.latestPrice
 * @param {{start: number, end: number}} [a.window]  The run's time span, for the "both halves" check.
 * @param {number} [a.tested]  Strategies tested side by side (sets the luck bar).
 * @param {Timeline} [a.timeline]  Moments and saved prices for each book's balance over time.
 * @returns {StrategyResult[]}
 */
export function strategyResults({ trades, strategies, startingBankroll, latestPrice, window, tested, timeline }) {
  const closedIn = (/** @type {string} */ book) => trades.filter((t) => t.book === book && t.status === 'closed');
  const rows = strategies.map((strategy) => ({
    strategy,
    ...bookResult(
      trades.filter((t) => t.book === strategy),
      startingBankroll,
      latestPrice,
      timeline,
    ),
    twin: bookResult(
      trades.filter((t) => t.book === `${RANDOM_STRATEGY}:${strategy}`),
      startingBankroll,
      latestPrice,
      timeline,
    ),
    verdict: verdict(closedIn(strategy), closedIn(`${RANDOM_STRATEGY}:${strategy}`), tested ?? strategies.length),
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
    valueCurve: (timeline?.times ?? []).map((t, i) => ({ t, equity: avg((b) => b.valueCurve[i].equity) })),
    twin: null,
    verdict: null,
    checks: null,
  };
  return [...rows, randomRow];
}

/**
 * @typedef {Object} CoinResult
 * @property {string} poolAddress
 * @property {string} symbol
 * @property {string[]} strategies  Strategies that bought it, first buyer first.
 * @property {number} trades        Filled trades (open and closed).
 * @property {number} open
 * @property {number} closed
 * @property {number} wins          Closed with a profit.
 * @property {number} realizedUsd   Profit from closed trades.
 * @property {number} openUsd       What the open trades would make if sold now (null price: counted as 0).
 * @property {number} pnlUsd        realizedUsd + openUsd.
 * @property {number} lastAt        Latest buy or sell.
 */

/**
 * How each coin did for the strategies (random pickers left out), best first.
 * Open trades are valued like the balances are: sold now, after costs.
 * @param {PaperTrade[]} trades
 * @param {(poolAddress: string) => {price: number, liquidityUsd: number|null}|null} latestPrice
 * @returns {CoinResult[]}
 */
export function coinResults(trades, latestPrice) {
  /** @type {Map<string, CoinResult>} */
  const coins = new Map();
  const filled = trades
    .filter((t) => t.strategy !== RANDOM_STRATEGY && t.openedAt !== null && (t.status === 'open' || t.status === 'closed'))
    .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
  for (const t of filled) {
    let c = coins.get(t.poolAddress);
    if (!c) {
      c = { poolAddress: t.poolAddress, symbol: t.symbol, strategies: [], trades: 0, open: 0, closed: 0, wins: 0, realizedUsd: 0, openUsd: 0, pnlUsd: 0, lastAt: 0 };
      coins.set(t.poolAddress, c);
    }
    if (!c.strategies.includes(t.strategy)) c.strategies.push(t.strategy);
    c.trades++;
    c.lastAt = Math.max(c.lastAt, t.closedAt ?? t.openedAt ?? 0);
    if (t.status === 'closed') {
      c.closed++;
      c.realizedUsd += t.pnlUsd ?? 0;
      if ((t.pnlUsd ?? 0) > 0) c.wins++;
    } else {
      c.open++;
      const m = latestPrice(t.poolAddress);
      if (m !== null) c.openUsd += liquidationValue(t, m.price, m.liquidityUsd).proceedsUsd - t.sizeUsd;
    }
  }
  for (const c of coins.values()) c.pnlUsd = c.realizedUsd + c.openUsd;
  return [...coins.values()].sort((a, b) => b.pnlUsd - a.pnlUsd || b.lastAt - a.lastAt);
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

/**
 * @typedef {Object} HitRate
 * @property {number} n        Finished trades with these exact exits.
 * @property {number} hits     Of those, how many reached take profit.
 * @property {number|null} rate
 * @property {[number, number]|null} ci  95% range for the rate.
 */

/**
 * @typedef {Object} StrategyOdds
 * @property {string} strategy
 * @property {HitRate} hit     The strategy's own trades.
 * @property {HitRate} random  Its random picker's: what any coin from the same list did.
 */

/**
 * How often each strategy's trades reached take profit before the stop loss
 * or time limit: a measured hit rate, never a guess. Counts every run, but
 * only trades with the exits the strategy uses now (a different take profit
 * is a different question), and never trades made on a flagged price.
 * @param {PaperTrade[]} trades
 * @param {{id: string, trade: {stopLossPct: number, takeProfitPct: number, timeLimitMin: number}}[]} strategies
 * @returns {Map<string, StrategyOdds>}
 */
export function hitRates(trades, strategies) {
  /** @type {Map<string, StrategyOdds>} */
  const out = new Map();
  const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-9;
  for (const s of strategies) {
    const same = (/** @type {PaperTrade} */ t) =>
      t.status === 'closed' &&
      !t.dataFlag &&
      near(t.stopLossPct, s.trade.stopLossPct) &&
      near(t.takeProfitPct, s.trade.takeProfitPct) &&
      t.timeLimitMs === s.trade.timeLimitMin * 60_000;
    const rate = (/** @type {string} */ book) => {
      const mine = trades.filter((t) => t.book === book && same(t));
      const hits = mine.filter((t) => t.exitReason === 'take_profit').length;
      return { n: mine.length, hits, rate: mine.length ? hits / mine.length : null, ci: wilson(hits, mine.length) };
    };
    out.set(s.id, { strategy: s.id, hit: rate(s.id), random: rate(`${RANDOM_STRATEGY}:${s.id}`) });
  }
  return out;
}

/**
 * @typedef {Object} HotCoin
 * @property {string} poolAddress
 * @property {string} symbol
 * @property {string[]} strategies  Strategies whose rule fired on it in the window, strongest odds first.
 * @property {number} rules         Different rules among them (a fast and a slow version of one rule count once).
 * @property {number} firstAt       First signal in the window.
 * @property {number} lastAt        Latest signal.
 * @property {number} priceAtFirst
 * @property {number|null} priceNow  Latest trusted price.
 * @property {number|null} movePct   Since the first signal: how late a buy now would be.
 * @property {StrategyOdds[]} odds   One per strategy, same order.
 * @property {boolean} enoughTrades  The best odds rest on at least MIN_TRADES_FOR_VERDICT trades.
 */

/**
 * Coins the strategies are buying right now: their rules fired on it in the
 * last few minutes. Ranked by how many different rules agree, then by the
 * best measured hit rate's low end (so 2 of 2 doesn't outrank 12 of 30).
 * @param {Object} a
 * @param {{signalId: string, poolAddress: string, symbol: string, ts: number, priceUsd: number}[]} a.events  Signal fires in the window.
 * @param {{id: string, rule: string}[]} a.strategies  Active strategies and their rule.
 * @param {Map<string, StrategyOdds>} a.odds
 * @param {(pool: string) => number|null} a.priceNow
 * @returns {HotCoin[]}
 */
export function hotCoins({ events, strategies, odds, priceNow }) {
  const ruleOf = new Map(strategies.map((s) => [s.id, s.rule]));
  /** @type {Map<string, typeof events>} */
  const byPool = new Map();
  for (const e of events) {
    if (!ruleOf.has(e.signalId)) continue;
    const list = byPool.get(e.poolAddress) ?? [];
    list.push(e);
    byPool.set(e.poolAddress, list);
  }
  const low = (/** @type {StrategyOdds|undefined} */ o) => o?.hit.ci?.[0] ?? 0;
  /** @type {HotCoin[]} */
  const coins = [];
  for (const [pool, list] of byPool) {
    list.sort((a, b) => a.ts - b.ts);
    const ids = [...new Set(list.map((e) => e.signalId))].sort((a, b) => low(odds.get(b)) - low(odds.get(a)));
    const first = list[0];
    const now = priceNow(pool);
    const best = odds.get(ids[0]);
    coins.push({
      poolAddress: pool,
      symbol: list[list.length - 1].symbol,
      strategies: ids,
      rules: new Set(ids.map((id) => ruleOf.get(id))).size,
      firstAt: first.ts,
      lastAt: list[list.length - 1].ts,
      priceAtFirst: first.priceUsd,
      priceNow: now,
      movePct: now !== null && first.priceUsd > 0 ? now / first.priceUsd - 1 : null,
      odds: ids.map((id) => /** @type {StrategyOdds} */ (odds.get(id))),
      enoughTrades: (best?.hit.n ?? 0) >= MIN_TRADES_FOR_VERDICT,
    });
  }
  return coins.sort(
    (a, b) => b.rules - a.rules || low(b.odds[0]) - low(a.odds[0]) || b.lastAt - a.lastAt,
  );
}
