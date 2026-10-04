// @ts-check
import { buildPendingTrade, fillPending, closeTrade, exitReasonFor } from './paper.js';
import { RANDOM_STRATEGY } from './signal-loader.js';

/** @typedef {import('../types.js').Snapshot} Snapshot */
/** @typedef {import('../types.js').PaperTrade} PaperTrade */
/** @typedef {import('../types.js').SignalModule} SignalModule */
/** @typedef {import('../db.js').Store} Store */
/** @typedef {import('../config.js').Config} Config */

/**
 * @typedef {Object} CycleDeps
 * @property {Store} store
 * @property {import('../providers/provider.js').MarketProvider} provider
 * @property {SignalModule[]} signals
 * @property {Config} config
 * @property {number} runId          The run new trades belong to (see runs.js).
 * @property {() => number} [now]
 * @property {() => number} [rand]   Uniform [0,1), used to pick random control tokens.
 * @property {(msg: string) => void} [log]
 */

/**
 * @typedef {Object} CycleResult
 * @property {boolean} ok
 * @property {string|null} error
 * @property {number} snapshots
 * @property {number} signalEvents
 * @property {PaperTrade[]} queued     New pending trades (fill next poll).
 * @property {PaperTrade[]} opened     Pending trades that filled this poll.
 * @property {PaperTrade[]} cancelled  Pending trades that could not fill.
 * @property {PaperTrade[]} closed
 */

/** @param {string} signalId */
export const randomBook = (signalId) => `${RANDOM_STRATEGY}:${signalId}`;

/**
 * Cash available to a book: bankroll minus money in open trades plus realized P&L.
 * @param {Store} store
 * @param {string} book
 * @param {number} startingBankroll
 * @param {number} runId
 */
export function availableCash(store, book, startingBankroll, runId) {
  return startingBankroll + store.cashDelta(book, runId);
}

/**
 * Why a book may not open a trade on this pool right now, or null if it may.
 * @param {Store} store
 * @param {string} book
 * @param {string} poolAddress
 * @param {Config} config
 * @param {number} now
 * @param {number} runId
 */
export function blockReason(store, book, poolAddress, config, now, runId) {
  if (store.trades({ book, poolAddress, status: 'open', runId, limit: 1 }).length) return 'already_open';
  if (store.trades({ book, poolAddress, status: 'pending', runId, limit: 1 }).length) return 'already_open';
  const last = store.lastClosedAt(book, poolAddress, runId);
  if (last !== null && now - last < config.trade.reentryCooldownMin * 60_000) return 'cooldown';
  if (availableCash(store, book, config.startingBankrollUsd, runId) < config.trade.sizeUsd) return 'no_cash';
  return null;
}

/**
 * One poll: fetch data, store snapshots, fill last poll's queued trades, close
 * finished trades, run signals, and queue signal trades plus their random twins.
 *
 * @param {CycleDeps} deps
 * @returns {Promise<CycleResult>}
 */
export async function runCycle(deps) {
  const { store, provider, signals, config, runId } = deps;
  const now = deps.now ?? Date.now;
  const rand = deps.rand ?? Math.random;
  const log = deps.log ?? (() => {});
  const callsBefore = provider.totalCalls();

  /** @type {CycleResult} */
  const result = { ok: true, error: null, snapshots: 0, signalEvents: 0, queued: [], opened: [], cancelled: [], closed: [] };

  // 1. Fetch. On failure we still run exits so trades can't hang forever.
  /** @type {Snapshot[]} */
  let fetched = [];
  try {
    const trending = await provider.fetchTrending();
    const seen = new Set(trending.map((s) => s.poolAddress));
    const missing = store.openPools().filter((p) => !seen.has(p));
    const extra = missing.length ? await provider.fetchPools(missing) : [];
    fetched = [...trending, ...extra];
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
    log(`fetch failed: ${result.error}`);
  }

  const ts = now();
  /** @type {Snapshot[]} */
  const stored = store.tx(() => fetched.map((s) => store.insertSnapshot(s)));
  result.snapshots = stored.length;
  /** @type {Map<string, Snapshot>} */
  const fresh = new Map(stored.map((s) => [s.poolAddress, s]));

  // 2. Fill trades queued last poll, at this poll's price (like a trade placed by
  // hand a minute after the signal). Signal trades go first so a random twin can
  // be cancelled when the trade it mirrors was. Trades from an earlier run are
  // still seen through to the end under their own rules.
  const pending = store.trades({ status: 'pending', managed: true }).sort((a, b) => Number(a.strategy === RANDOM_STRATEGY) - Number(b.strategy === RANDOM_STRATEGY));
  /** @type {Set<number>} */
  const cancelledIds = new Set();
  for (const t of pending) {
    const snap = fresh.get(t.poolAddress);
    /** @type {PaperTrade} */
    let next;
    if (t.matchedTradeId !== null && cancelledIds.has(t.matchedTradeId)) {
      next = { ...t, status: 'cancelled', cancelReason: 'twin_cancelled', closedAt: ts };
    } else {
      next = fillPending(t, snap ?? null, config.trade.maxChasePct, ts);
    }
    store.updateTrade(next);
    if (next.status === 'cancelled') {
      cancelledIds.add(/** @type {number} */ (next.id));
      result.cancelled.push(next);
    } else result.opened.push(next);
  }

  // 3. Exits.
  const staleMs = config.trade.staleAfterMin * 60_000;
  for (const t of store.trades({ status: 'open', managed: true })) {
    const latest = fresh.get(t.poolAddress) ?? store.latestSnapshot(t.poolAddress);
    const reason = exitReasonFor(t, latest, ts, staleMs, config.trade.collapseLiquidityRatio);
    if (!reason) continue;
    const at = latest
      ? { price: latest.priceUsd, liquidityUsd: latest.liquidityUsd, snapshotId: latest.id ?? null }
      : { price: /** @type {number} */ (t.entryPrice), liquidityUsd: t.entryLiquidityUsd, snapshotId: null };
    const closed = closeTrade(t, at, reason, ts);
    store.updateTrade(closed);
    result.closed.push(closed);
  }

  // 4. Signals over the tradable universe (same filter for signals and random).
  // Requiring recent sells guards against coins that can be bought but not sold.
  const universe = stored.filter(
    (s) =>
      s.trendingRank !== null &&
      (s.liquidityUsd ?? 0) >= config.universe.minLiquidityUsd &&
      (s.sellsM5 ?? 0) >= config.universe.minSellsM5,
  );
  /** @type {Map<string, Snapshot[]>} */
  const histories = new Map();
  const historyFor = (/** @type {Snapshot} */ s) => {
    let h = histories.get(s.poolAddress);
    if (!h) {
      h = store.poolHistory(s.poolAddress, { beforeId: s.id, sinceTs: ts - 6 * 3600_000, limit: 500 });
      histories.set(s.poolAddress, h);
    }
    return h;
  };

  /** @type {PaperTrade[]} */
  const signalTrades = [];
  for (const sig of signals) {
    for (const snap of universe) {
      let res;
      try {
        res = sig.evaluate({ snapshot: snap, history: historyFor(snap), params: sig.params });
      } catch (err) {
        log(`signal ${sig.id} threw on ${snap.symbol}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!res?.fired) continue;
      const ev = store.insertSignalEvent({
        signalId: sig.id,
        snapshotId: /** @type {number} */ (snap.id),
        poolAddress: snap.poolAddress,
        symbol: snap.symbol,
        ts,
        value: Number.isFinite(res.value) ? res.value : 0,
        reason: res.reason,
        tradeId: null,
        skipReason: null,
        runId,
      });
      result.signalEvents++;
      const blocked = blockReason(store, sig.id, snap.poolAddress, config, ts, runId);
      if (blocked) {
        store.resolveSignalEvent(/** @type {number} */ (ev.id), null, blocked);
        continue;
      }
      const trade = store.insertTrade(
        buildPendingTrade({ strategy: sig.id, snapshot: snap, rules: config.trade, now: ts, signalEventId: ev.id, runId }),
      );
      store.resolveSignalEvent(/** @type {number} */ (ev.id), trade.id ?? null, null);
      signalTrades.push(trade);
      result.queued.push(trade);
    }
  }

  // 5. Random control: for every signal trade, that signal's random twin buys a
  // uniformly random token from the same universe, from its own $1,000 book.
  for (const st of signalTrades) {
    const book = randomBook(st.strategy);
    const candidates = universe.filter((s) => blockReason(store, book, s.poolAddress, config, ts, runId) === null);
    if (!candidates.length) {
      log(`random control skipped for trade ${st.id}: no eligible token or no cash in ${book}`);
      continue;
    }
    const pick = candidates[Math.floor(rand() * candidates.length)];
    const trade = store.insertTrade(
      buildPendingTrade({ strategy: RANDOM_STRATEGY, book, snapshot: pick, rules: config.trade, now: ts, matchedTradeId: st.id, runId }),
    );
    result.queued.push(trade);
  }

  store.insertPoll({
    ts,
    ok: result.ok,
    calls: provider.totalCalls() - callsBefore,
    pools: stored.length,
    error: result.error,
  });
  return result;
}
