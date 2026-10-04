// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeResponse } from '../src/providers/geckoterminal.js';
import { buildPendingTrade, fillPending, exitReasonFor, closeTrade, breakevenMove, priceImpact } from '../src/engine/paper.js';
import { loadSignals } from '../src/engine/signal-loader.js';
import { runCycle } from '../src/engine/cycle.js';
import { strategyResults, wilson, calibration, verdict } from '../src/engine/stats.js';
import { Store } from '../src/db.js';
import { DEFAULTS } from '../src/config.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/geckoterminal-trending.json', import.meta.url), 'utf8'));

/** @returns {import('../src/types.js').Snapshot} */
function snap(over = {}) {
  return {
    ts: 1_000_000,
    source: 'test',
    poolAddress: 'POOL1',
    tokenAddress: 'TOKEN1',
    symbol: 'TST',
    name: 'Test',
    dex: null,
    trendingRank: 1,
    priceUsd: 1,
    marketCapUsd: 100_000,
    fdvUsd: 100_000,
    liquidityUsd: 200_000,
    volM5: 1000,
    volH1: 12_000,
    volH6: null,
    volH24: null,
    buysM5: 10,
    sellsM5: 10,
    buyersM5: 10,
    sellersM5: 10,
    buysH1: null,
    sellsH1: null,
    buyersH1: null,
    sellersH1: null,
    buysH24: null,
    sellsH24: null,
    priceChangeM5: null,
    priceChangeH1: null,
    poolCreatedAt: null,
    ...over,
  };
}

test('GeckoTerminal response normalizes into snapshots', () => {
  const out = normalizeResponse(fixture, 123, 0);
  assert.equal(out.length, 2, 'pool without a price is dropped');
  const [a, b] = out;
  assert.equal(a.symbol, 'WIFCAT');
  assert.equal(a.tokenAddress, 'MintAAA111');
  assert.equal(a.poolAddress, 'PoolAAA111');
  assert.equal(a.trendingRank, 1);
  assert.equal(a.priceUsd, 0.000123);
  assert.equal(a.marketCapUsd, null);
  assert.equal(a.fdvUsd, 123000);
  assert.equal(a.liquidityUsd, 45000.5);
  assert.equal(a.buyersM5, 40);
  assert.equal(a.sellersM5, 12);
  assert.equal(a.volM5, 8000);
  assert.equal(a.poolCreatedAt, Date.parse('2026-10-04T01:00:00Z'));
  assert.equal(b.symbol, 'NOINC', 'symbol falls back to pair name when token is not included');
  assert.equal(b.trendingRank, 3);
});

const RULES = DEFAULTS.trade;
const STALE = 5 * 60_000;

/** Pending trade at price 1, filled one minute later at `fillPrice` into `liquidity`. */
function filledTrade(fillPrice = 1, liquidity = /** @type {number|null} */ (null)) {
  const p = buildPendingTrade({ strategy: 's', snapshot: { ...snap(), id: 1 }, rules: RULES, now: 0 });
  return fillPending(p, { ...snap({ ts: 60_000, priceUsd: fillPrice, liquidityUsd: liquidity }), id: 2 }, RULES.maxChasePct, 60_000);
}

test('price impact grows as the pool gets thinner', () => {
  assert.equal(priceImpact('buy', 50, null), 0);
  assert.ok(Math.abs(priceImpact('buy', 50, 100_000) - 0.001) < 1e-12, '$50 into $50K quote side is 0.1%');
  assert.ok(priceImpact('buy', 50, 20_000) > priceImpact('buy', 50, 100_000));
  assert.ok(priceImpact('sell', 50, 1_000) > 0.09, 'selling into a drained pool loses a lot');
});

test('paper trade math: fees and slippage both ways', () => {
  const t = filledTrade(1, null);
  assert.equal(t.status, 'open');
  assert.equal(t.book, 's');
  const flat = closeTrade(t, { price: 1, liquidityUsd: null, snapshotId: 3 }, 'time_limit', 1);
  assert.ok(flat.pnlUsd !== null && flat.pnlUsd < 0, 'flat price loses the costs');
  const be = closeTrade(t, { price: 1 + breakevenMove(RULES), liquidityUsd: null, snapshotId: 3 }, 'time_limit', 1);
  assert.ok(Math.abs(/** @type {number} */ (be.pnlUsd)) < 1e-9, 'breakeven move returns the stake when there is no impact');
  const thin = closeTrade(filledTrade(1, 20_000), { price: 1, liquidityUsd: 20_000, snapshotId: 3 }, 'time_limit', 1);
  assert.ok(/** @type {number} */ (thin.pnlUsd) < /** @type {number} */ (flat.pnlUsd), 'thin pool costs more');
});

test('pending trades fill at the next price, or cancel', () => {
  const p = buildPendingTrade({ strategy: 's', snapshot: { ...snap(), id: 1 }, rules: RULES, now: 0 });
  assert.equal(p.status, 'pending');
  assert.equal(fillPending(p, null, 0.05, 1).cancelReason, 'no_data');
  assert.equal(fillPending(p, { ...snap({ priceUsd: 1.06 }), id: 2 }, 0.05, 1).cancelReason, 'chased');
  const ok = fillPending(p, { ...snap({ priceUsd: 0.97 }), id: 2 }, 0.05, 1);
  assert.equal(ok.status, 'open');
  assert.equal(ok.entryPrice, 0.97, 'fills at the new price, not the signal price');
});

test('exit rules: collapse, stop loss, take profit, time limit, no data', () => {
  const t = filledTrade(1, 200_000); // opened at 60_000
  const at = (/** @type {number} */ ts, /** @type {any} */ over) => exitReasonFor(t, snap({ ts, ...over }), ts, STALE, RULES.collapseLiquidityRatio);
  assert.equal(at(120_000, { priceUsd: 1.1, liquidityUsd: 30_000 }), 'collapsed');
  assert.equal(at(120_000, { priceUsd: 0.79 }), 'stop_loss');
  assert.equal(at(120_000, { priceUsd: 1.41 }), 'take_profit');
  assert.equal(at(120_000, { priceUsd: 1.1 }), null);
  const end = 60_000 + 60 * 60_000;
  assert.equal(at(end, { priceUsd: 1.1 }), 'time_limit');
  assert.equal(exitReasonFor(t, snap({ ts: 120_000, priceUsd: 1.1 }), end, STALE, 0.2), 'no_data');
  const rug = closeTrade(t, { price: 0.5, liquidityUsd: 2_000, snapshotId: 9 }, 'collapsed', end);
  assert.ok(/** @type {number} */ (rug.pnlPct) < -0.5, 'a collapse is a heavy loss');
});

test('built-in signals load and fire on the expected inputs', async () => {
  const sigs = await loadSignals();
  const by = Object.fromEntries(sigs.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), ['buyer-seller-ratio', 'liquidity-mcap-ratio', 'volume-spike']);
  const ev = (/** @type {string} */ id, /** @type {any} */ s) => by[id].evaluate({ snapshot: s, history: [], params: by[id].params });

  assert.equal(ev('buyer-seller-ratio', snap({ buyersM5: 40, sellersM5: 10 })).fired, true);
  assert.equal(ev('buyer-seller-ratio', snap({ buyersM5: 12, sellersM5: 1 })).fired, false, 'too few buyers');

  // 55 minutes at $1k per 5m, then $10k in the last 5m.
  assert.equal(ev('volume-spike', snap({ volM5: 10_000, volH1: 21_000 })).fired, true);
  assert.equal(ev('volume-spike', snap({ volM5: 1000, volH1: 12_000 })).fired, false);

  assert.equal(ev('liquidity-mcap-ratio', snap({ liquidityUsd: 20_000, marketCapUsd: 100_000 })).fired, true);
  assert.equal(ev('liquidity-mcap-ratio', snap({ liquidityUsd: 20_000, marketCapUsd: null, fdvUsd: 1_000_000 })).fired, false);
});

/**
 * @param {() => number} now
 * @param {() => import('../src/types.js').Snapshot[]} pools
 * @param {() => boolean} [fail]
 * @returns {import('../src/providers/provider.js').MarketProvider}
 */
function fakeProvider(now, pools, fail = () => false) {
  return {
    id: 'fake',
    callsInLastMinute: () => 0,
    totalCalls: () => 0,
    fetchTrending: async () => {
      if (fail()) throw new Error('boom');
      return pools();
    },
    fetchPools: async () => [],
  };
}

const bsr = async () => (await loadSignals()).filter((s) => s.id === 'buyer-seller-ratio');

test('cycle: queue, fill next poll with a random twin, exit, cooldown', async () => {
  const store = new Store(':memory:');
  let now = 10_000_000;
  let price = 1;
  const pools = () => [
    snap({ ts: now, poolAddress: 'P1', symbol: 'A', priceUsd: price, buyersM5: 50, sellersM5: 5 }),
    snap({ ts: now, poolAddress: 'P2', symbol: 'B', priceUsd: price, trendingRank: 2 }),
    snap({ ts: now, poolAddress: 'P3', symbol: 'THIN', priceUsd: price, trendingRank: 3, liquidityUsd: 5_000 }),
    snap({ ts: now, poolAddress: 'P4', symbol: 'NOSELL', priceUsd: price, trendingRank: 4, sellsM5: 0 }),
  ];
  const deps = { store, provider: fakeProvider(() => now, pools), signals: await bsr(), config: DEFAULTS, now: () => now, rand: () => 0.99 };

  const r1 = await runCycle(deps);
  assert.equal(r1.queued.length, 2);
  const [sigTrade, randTrade] = r1.queued;
  assert.equal(sigTrade.status, 'pending');
  assert.equal(randTrade.book, 'random:buyer-seller-ratio');
  assert.equal(randTrade.matchedTradeId, sigTrade.id);
  assert.equal(randTrade.poolAddress, 'P2', 'thin and no-sell coins are excluded; rand() = 0.99 picks the last eligible');

  now += 60_000;
  price = 1.02;
  const r2 = await runCycle(deps);
  assert.equal(r2.opened.length, 2, 'both fill one poll later');
  assert.ok(r2.opened.every((t) => t.entryPrice === 1.02));
  assert.equal(r2.queued.length, 0);
  assert.equal(store.recentSignalEvents('buyer-seller-ratio', 1)[0].skipReason, 'already_open');

  now += 60_000;
  price = 2;
  const r3 = await runCycle(deps);
  assert.equal(r3.closed.length, 2);
  assert.ok(r3.closed.every((t) => t.exitReason === 'take_profit' && (t.pnlUsd ?? 0) > 0));

  now += 60_000;
  const r4 = await runCycle(deps);
  assert.equal(r4.queued.length, 0);
  assert.equal(store.recentSignalEvents('buyer-seller-ratio', 1)[0].skipReason, 'cooldown');

  const res = strategyResults({ trades: store.trades(), strategies: ['buyer-seller-ratio'], startingBankroll: 1000, latestPrice: () => null });
  assert.equal(res[0].all.closed, 1);
  assert.equal(res[0].twin?.all.closed, 1);
  assert.ok(res[0].equityUsd > 1000);
  store.close();
});

test('cycle: a chased signal trade cancels its random twin too', async () => {
  const store = new Store(':memory:');
  let now = 0;
  let price = 1;
  const pools = () => [
    snap({ ts: now, poolAddress: 'P1', priceUsd: price, buyersM5: 50, sellersM5: 5 }),
    snap({ ts: now, poolAddress: 'P2', priceUsd: 1, trendingRank: 2 }),
  ];
  const deps = { store, provider: fakeProvider(() => now, pools), signals: await bsr(), config: DEFAULTS, now: () => now, rand: () => 0.99 };
  await runCycle(deps);
  now += 60_000;
  price = 1.2;
  const r = await runCycle(deps);
  assert.deepEqual(r.cancelled.map((t) => t.cancelReason).sort(), ['chased', 'twin_cancelled']);
  assert.equal(availableCashOf(store), 2000 - 50 * r.queued.length, 'cancelled trades cost nothing; only the new queue holds cash');
  store.close();
});

/** @param {Store} store */
const availableCashOf = (store) => 2000 + store.cashDelta('buyer-seller-ratio') + store.cashDelta('random:buyer-seller-ratio');

test('a failed fetch still closes trades past their time limit', async () => {
  const store = new Store(':memory:');
  let now = 0;
  let fail = false;
  const pools = () => [snap({ ts: now, poolAddress: 'P1', buyersM5: 50, sellersM5: 5 })];
  const deps = { store, provider: fakeProvider(() => now, pools, () => fail), signals: await bsr(), config: DEFAULTS, now: () => now };
  await runCycle(deps);
  now += 60_000;
  await runCycle(deps); // fills
  fail = true;
  now += 61 * 60_000;
  const r = await runCycle(deps);
  assert.equal(r.ok, false);
  assert.equal(r.closed.length, 2, 'signal trade and its random twin');
  assert.ok(r.closed.every((t) => t.exitReason === 'no_data'));
  store.close();
});

test('an outdated database is set aside, not deleted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paperlab-'));
  const file = path.join(dir, 'paper.sqlite');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE trades (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('open', 'closed')))");
  old.close();
  const store = new Store(file);
  assert.ok(store.archivedTo && existsSync(store.archivedTo));
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.sqlite')).length, 2);
  store.close();
  const again = new Store(file);
  assert.equal(again.archivedTo, null, 'current schema is kept');
  again.close();
});

test('wilson interval and calibration', () => {
  const ci = wilson(5, 10);
  assert.ok(ci && ci[0] < 0.5 && ci[1] > 0.5);
  assert.equal(wilson(0, 0), null);
  const t = /** @type {any} */ ({ status: 'closed', aiProbability: 0.8, pnlUsd: 1 });
  const f = /** @type {any} */ ({ status: 'closed', aiProbability: 0.2, pnlUsd: -1 });
  const c = calibration([t, f]);
  assert.equal(c.n, 2);
  assert.ok(c.brier !== null && c.baselineBrier !== null && c.brier < c.baselineBrier);
});

test('verdict: too early, no edge, leaning, clear', () => {
  const trades = (/** @type {number[]} */ pcts) => pcts.map((p) => /** @type {any} */ ({ status: 'closed', pnlPct: p, pnlUsd: p * 50 }));
  const noisy = (/** @type {number} */ center, /** @type {number} */ n) => Array.from({ length: n }, (_, i) => center + (i % 2 ? 0.2 : -0.2));
  assert.equal(verdict(trades(noisy(0.1, 10)), trades(noisy(0, 10))).label, 'too_early');
  assert.equal(verdict(trades(noisy(-0.05, 30)), trades(noisy(0, 30))).label, 'no_edge');
  assert.equal(verdict(trades(noisy(0.05, 30)), trades(noisy(0, 30))).label, 'leaning');
  assert.equal(verdict(trades(noisy(0.2, 30)), trades(noisy(0, 30))).label, 'clear');
});
