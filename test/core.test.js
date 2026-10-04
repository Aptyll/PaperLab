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
import { strategyResults, wilson, calibration, verdict, goLiveChecks } from '../src/engine/stats.js';
import { Store } from '../src/db.js';
import { DEFAULTS } from '../src/config.js';
import { runSettings, canContinue } from '../src/engine/runs.js';

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
  const deps = { store, provider: fakeProvider(() => now, pools), signals: await bsr(), config: DEFAULTS, now: () => now, rand: () => 0.99, runId: store.beginRun(runSettings(DEFAULTS, []), 0) };

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
  assert.equal(store.recentSignalEvents('buyer-seller-ratio', 1, deps.runId)[0].skipReason, 'already_open');

  now += 60_000;
  price = 2;
  const r3 = await runCycle(deps);
  assert.equal(r3.closed.length, 2);
  assert.ok(r3.closed.every((t) => t.exitReason === 'take_profit' && (t.pnlUsd ?? 0) > 0));

  now += 60_000;
  const r4 = await runCycle(deps);
  assert.equal(r4.queued.length, 0);
  assert.equal(store.recentSignalEvents('buyer-seller-ratio', 1, deps.runId)[0].skipReason, 'cooldown');

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
  const deps = { store, provider: fakeProvider(() => now, pools), signals: await bsr(), config: DEFAULTS, now: () => now, rand: () => 0.99, runId: store.beginRun(runSettings(DEFAULTS, []), 0) };
  await runCycle(deps);
  now += 60_000;
  price = 1.2;
  const r = await runCycle(deps);
  assert.deepEqual(r.cancelled.map((t) => t.cancelReason).sort(), ['chased', 'twin_cancelled']);
  assert.equal(availableCashOf(store), 2000 - 50 * r.queued.length, 'cancelled trades cost nothing; only the new queue holds cash');
  store.close();
});

/** @param {Store} store */
const availableCashOf = (store, run = 1) => 2000 + store.cashDelta('buyer-seller-ratio', run) + store.cashDelta('random:buyer-seller-ratio', run);

test('a failed fetch still closes trades past their time limit', async () => {
  const store = new Store(':memory:');
  let now = 0;
  let fail = false;
  const pools = () => [snap({ ts: now, poolAddress: 'P1', buyersM5: 50, sellersM5: 5 })];
  const deps = { store, provider: fakeProvider(() => now, pools, () => fail), signals: await bsr(), config: DEFAULTS, now: () => now, runId: store.beginRun(runSettings(DEFAULTS, []), 0) };
  await runCycle(deps);
  now += 60_000;
  await runCycle(deps); // fills
  fail = true;
  now += 61 * 60_000;
  const r = await runCycle(deps);
  assert.equal(r.ok, false);
  assert.equal(r.closed.length, 2, 'signal trade and its random twin');
  assert.ok(r.closed.every((t) => t.exitReason === 'no_data'));
  assert.equal(r.queued.length, 0, 'no new buys while prices are stale');
  assert.equal(r.signalEvents, 0);
  fail = false;
  now += 60_000;
  const back = await runCycle(deps);
  assert.ok(back.signalEvents > 0, 'rules run again on the next good data');
  store.close();
});

const SCHEMA_V1 = readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8');

/** A database as the first version left it: one closed and one open trade. @param {string} file */
function writeV1(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_V1);
  const s = snap();
  db.prepare(
    `INSERT INTO snapshots (id, ts, source, pool_address, token_address, symbol, name, price_usd, liquidity_usd)
     VALUES (1, 1000, 'geckoterminal', 'P1', 'T1', 'OLD', 'Old', 1, 150000)`,
  ).run();
  db.prepare(
    `INSERT INTO signal_events (id, signal_id, snapshot_id, pool_address, symbol, ts, value, reason, trade_id)
     VALUES (1, 'volume-spike', 1, 'P1', 'OLD', 1000, 4, 'volume 4x', 1)`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO trades (id, strategy, book, matched_trade_id, signal_event_id, pool_address, token_address, symbol, status,
       size_usd, fee_rate, slippage_rate, stop_loss_pct, take_profit_pct, time_limit_ms, opened_at, entry_snapshot_id,
       entry_price, entry_fill_price, quantity, closed_at, exit_reason, pnl_usd, pnl_pct)
     VALUES (?, ?, ?, ?, ?, 'P1', 'T1', 'OLD', ?, 50, 0.003, 0.015, 0.2, 0.4, 3600000, 1000, 1, 1, 1.02, 48, ?, ?, ?, ?)`,
  );
  ins.run(1, 'volume-spike', 'volume-spike', null, 1, 'closed', 2000, 'take_profit', 18, 0.36);
  ins.run(2, 'random', 'random:volume-spike', 1, null, 'open', null, null, null, null);
  db.close();
  void s;
}

test('an older database is upgraded in place, backed up, and kept as a past run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paperlab-'));
  const file = path.join(dir, 'paper.sqlite');
  writeV1(file);
  const store = new Store(file);
  assert.ok(store.backupPath && existsSync(store.backupPath), 'a full copy is taken first');
  const [run] = store.runs();
  assert.equal(run.origin, 'migrated');
  assert.equal(run.settings.engine, 1);
  assert.equal(run.settings.trade.stopLossPct, 0.2);
  assert.equal(run.trades, 2);
  const [open, closed] = store.trades({ runId: run.id });
  assert.equal(closed.pnlUsd, 18, 'results are unchanged');
  assert.equal(closed.signalAt, 1000, 'first-version trades filled at the signal');
  assert.equal(open.entryLiquidityUsd, 150000, 'filled in from the entry snapshot');
  assert.equal(store.recentSignalEvents('volume-spike', 5, run.id).length, 1);
  assert.equal(store.trades({ status: 'open', managed: true }).length, 1, 'its open trade is still seen through');

  const live = store.beginRun(runSettings(DEFAULTS, []), 5000);
  assert.notEqual(live, run.id, 'new rules start a new run');
  assert.equal(store.cashDelta('random:volume-spike', live), 0, 'the new run starts with full cash');
  store.close();

  const again = new Store(file);
  assert.equal(again.backupPath, null, 'already current: nothing to do');
  assert.equal(again.beginRun(runSettings(DEFAULTS, []), 9000), live, 'same rules continue the same run');
  assert.equal(again.runs().length, 2);
  again.close();
});

test('databases set aside by the previous version are merged in as past runs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paperlab-'));
  const file = path.join(dir, 'paper.sqlite');
  writeV1(path.join(dir, 'paper.v1-2026-10-04T01-00-00-000Z.sqlite'));
  const first = new Store(file);
  first.insertSnapshot(snap({ ts: 5000, poolAddress: 'P9' }));
  first.close();

  const store = new Store(file);
  assert.deepEqual(store.imported, [], 'merged once, on the first start that saw it');
  const [run] = store.runs();
  assert.equal(run.origin, 'imported');
  const trades = store.trades({ runId: run.id });
  assert.equal(trades.length, 2);
  const twin = trades.find((t) => t.book === 'random:volume-spike');
  const sig = trades.find((t) => t.book === 'volume-spike');
  assert.equal(twin?.matchedTradeId, sig?.id, 'links between trades survive the id shift');
  assert.ok(store.snapshotById(/** @type {number} */ (sig?.entrySnapshotId))?.symbol === 'OLD');
  assert.equal(store.trades({ status: 'open', managed: true }).length, 0, 'merged trades are kept exactly as they were');
  assert.equal(readdirSync(dir).filter((f) => f.includes('.v1-')).length, 1, 'the set-aside file is left in place');
  store.close();
});

test('runs: same rules continue, changed rules or costs start a new run', () => {
  const base = runSettings(DEFAULTS, []);
  const withSignal = { ...base, signals: { a: { x: 1 } } };
  assert.ok(canContinue(base, withSignal), 'adding a rule file keeps the run');
  assert.ok(!canContinue(withSignal, { ...base, signals: { a: { x: 2 } } }), 'changing a rule setting starts a new run');
  assert.ok(!canContinue(base, { ...base, trade: { ...base.trade, stopLossPct: 0.1 } }));
  assert.ok(!canContinue(base, { ...base, engine: base.engine + 1 }));
});

test('a new run trades from fresh books while the old run finishes its open trades', async () => {
  const store = new Store(':memory:');
  let now = 0;
  const pools = () => [
    snap({ ts: now, poolAddress: 'P1', buyersM5: 50, sellersM5: 5 }),
    snap({ ts: now, poolAddress: 'P2', trendingRank: 2 }),
  ];
  const signals = await bsr();
  const oldRun = store.beginRun(runSettings(DEFAULTS, signals), 0);
  const deps = { store, provider: fakeProvider(() => now, pools), signals, config: DEFAULTS, now: () => now, runId: oldRun };
  await runCycle(deps);
  now += 60_000;
  await runCycle(deps); // fills in the old run

  const config = { ...DEFAULTS, trade: { ...DEFAULTS.trade, stopLossPct: 0.1 } };
  const newRun = store.beginRun(runSettings(config, signals), now);
  assert.notEqual(newRun, oldRun);
  now += 60_000;
  const r = await runCycle({ ...deps, config, runId: newRun });
  assert.ok(r.queued.some((t) => t.strategy === 'buyer-seller-ratio' && t.runId === newRun), 'not blocked by the old run holding P1');
  now += 61 * 60_000;
  const r2 = await runCycle({ ...deps, config, runId: newRun });
  assert.ok(r2.closed.some((t) => t.runId === oldRun && t.exitReason === 'time_limit'), 'old trades close under their own rules');
  store.close();
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

test('go-live checks follow the written rules', () => {
  /** @param {number[]} pnls @param {number} [t0] */
  const closed = (pnls, t0 = 0) =>
    pnls.map((p, i) => /** @type {any} */ ({ status: 'closed', pnlUsd: p * 50, pnlPct: p, closedAt: t0 + i * 1000 }));
  const window = { start: 0, end: 60_000 };
  const good = closed(Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -0.2 : 0.3)));
  const byId = (/** @type {any[]} */ cs) => Object.fromEntries(cs.map((c) => [c.id, c.pass]));
  assert.deepEqual(byId(goLiveChecks(good, closed([0.01, -0.02]), window)), {
    trades: true, profit: true, random: true, average: true, best: true, halves: true,
  });
  const lucky = closed([...Array(30).fill(-0.05), 20]);
  const c = byId(goLiveChecks(lucky, [], window));
  assert.equal(c.profit, true, 'one moonshot makes the total positive');
  assert.equal(c.best, false, 'but not without it');
  assert.equal(c.halves, false, 'all the profit is in the second half');
});

test('controls: only this page can turn live data on or off, or quit', async () => {
  const { createServer } = await import('../src/server.js');
  const { EventEmitter } = await import('node:events');
  const app = Object.assign(new EventEmitter(), {
    running: false,
    lastCycle: null,
    start() { this.running = true; },
    async stop() { this.running = false; },
  });
  let quit = 0;
  const store = new Store(':memory:');
  const config = { ...DEFAULTS, port: 0 };
  const provider = /** @type {any} */ ({ id: 'simulated', callsInLastMinute: () => 0, totalCalls: () => 0 });
  const server = createServer({ store, config, signals: [], provider, app: /** @type {any} */ (app), aiEnabled: false, runId: 1, onQuit: () => quit++ });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  config.port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const base = `http://localhost:${config.port}`;
  const post = (/** @type {string} */ p, /** @type {Record<string, string>} */ headers) => fetch(base + p, { method: 'POST', headers });
  const ours = { origin: base, 'x-paper-lab': '1' };

  assert.equal((await post('/api/live/on', { origin: 'http://evil.example', 'x-paper-lab': '1' })).status, 403, 'other websites are refused');
  assert.equal((await post('/api/live/on', { origin: base })).status, 403, 'a plain form post is refused');
  assert.equal(app.running, false);
  assert.equal((await post('/api/live/on', ours)).status, 200);
  assert.equal(app.running, true);
  assert.equal((await (await fetch(base + '/api/status')).json()).live, true);
  await post('/api/live/off', ours);
  assert.equal(app.running, false);
  await post('/api/quit', ours);
  await new Promise((r) => setImmediate(r));
  assert.equal(quit, 1);
  server.close();
  store.close();
});
