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
import { strategyResults, wilson, calibration, verdict, goLiveChecks, coinResults, priceHistory, hitRates, hotCoins } from '../src/engine/stats.js';
import { Store } from '../src/db.js';
import { DEFAULTS } from '../src/config.js';
import { suspectPrice, checkSavedPrices } from '../src/engine/sanity.js';
import { runSettings, canContinue } from '../src/engine/runs.js';
import { resolveStrategies } from '../src/engine/strategies.js';
import STRATEGY_DEFS from '../src/strategies.js';

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
/** Falcon only (the buyer/seller rule with default exits), traded with `config`'s rules. */
const falcon = async (config = DEFAULTS) => resolveStrategies(STRATEGY_DEFS.slice(0, 1), await bsr(), config.trade);

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
  const deps = { store, provider: fakeProvider(() => now, pools), strategies: await falcon(), config: DEFAULTS, now: () => now, rand: () => 0.99, runId: store.beginRun(runSettings(DEFAULTS, []), 0) };

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
  const deps = { store, provider: fakeProvider(() => now, pools), strategies: await falcon(), config: DEFAULTS, now: () => now, rand: () => 0.99, runId: store.beginRun(runSettings(DEFAULTS, []), 0) };
  await runCycle(deps);
  now += 60_000;
  price = 1.2;
  const r = await runCycle(deps);
  assert.deepEqual(r.cancelled.map((t) => t.cancelReason).sort(), ['chased', 'twin_cancelled']);
  assert.equal(availableCashOf(store), 2000 - DEFAULTS.trade.sizeUsd * r.queued.length, 'cancelled trades cost nothing; only the new queue holds cash');
  store.close();
});

/** @param {Store} store */
const availableCashOf = (store, run = 1) => 2000 + store.cashDelta('buyer-seller-ratio', run) + store.cashDelta('random:buyer-seller-ratio', run);

test('a failed fetch still closes trades past their time limit', async () => {
  const store = new Store(':memory:');
  let now = 0;
  let fail = false;
  const pools = () => [snap({ ts: now, poolAddress: 'P1', buyersM5: 50, sellersM5: 5 })];
  const deps = { store, provider: fakeProvider(() => now, pools, () => fail), strategies: await falcon(), config: DEFAULTS, now: () => now, runId: store.beginRun(runSettings(DEFAULTS, []), 0) };
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

test('upgrading mid-run from the previous version keeps the same run going', async () => {
  const f = await falcon();
  const dir = mkdtempSync(path.join(tmpdir(), 'paperlab-'));
  const file = path.join(dir, 'paper.sqlite');
  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL('./fixtures/schema-v2.sql', import.meta.url), 'utf8'));
  db.exec('PRAGMA user_version = 2');
  db.prepare(
    `INSERT INTO snapshots (id, ts, source, pool_address, token_address, symbol, name, price_usd) VALUES (1, 1000, 'x', 'P1', 'T1', 'A', 'A', 1)`,
  ).run();
  const t = DEFAULTS.trade;
  db.prepare(
    `INSERT INTO trades (strategy, book, pool_address, token_address, symbol, status, size_usd, fee_rate, slippage_rate, stop_loss_pct,
       take_profit_pct, time_limit_ms, signal_at, signal_snapshot_id, signal_price)
     VALUES ('volume-spike', 'volume-spike', 'P1', 'T1', 'A', 'pending', ?, ?, ?, ?, ?, ?, 1000, 1, 1)`,
  ).run(t.sizeUsd, t.feeRate, t.slippageRate, t.stopLossPct, t.takeProfitPct, t.timeLimitMin * 60_000);
  db.close();

  const store = new Store(file);
  const [migrated] = store.runs();
  assert.equal(store.beginRun(runSettings(DEFAULTS, f), 5000), migrated.id, 'same rules: the run carries on');
  assert.equal(store.runs()[0].origin, 'live');
  assert.equal(store.runs().length, 1);

  // What the previous update did by mistake: file the run away and start a new one.
  store.db.prepare("UPDATE runs SET origin = 'migrated' WHERE id = ?").run(migrated.id);
  const split = Number(
    store.db
      .prepare("INSERT INTO runs (started_at, origin, settings) VALUES (?, 'live', ?)")
      .run(2000, JSON.stringify(runSettings(DEFAULTS, f))).lastInsertRowid,
  );
  store.db.prepare(`UPDATE trades SET run_id = ? WHERE id = 1`).run(split);
  // An older set-aside file merged in on the same start sits between them.
  store.db.prepare("INSERT INTO runs (started_at, origin, settings) VALUES (1, 'imported', '{}')").run();
  store.close();
  const healed = new Store(file);
  assert.equal(healed.beginRun(runSettings(DEFAULTS, f), 9000), migrated.id, 'the split run is joined back');
  assert.equal(healed.rejoined, true);
  assert.ok(healed.backupPath && existsSync(healed.backupPath));
  assert.equal(healed.runs().filter((r) => r.origin !== 'imported').length, 1);
  assert.equal(healed.trades({ runId: migrated.id }).length, 1, 'its trades come along');
  healed.close();

  const changed = new Store(file);
  const other = { ...DEFAULTS, trade: { ...DEFAULTS.trade, stopLossPct: 0.1 } };
  assert.notEqual(changed.beginRun(runSettings(other, await falcon(other)), 6000), migrated.id, 'changed rules still start a new run');
  changed.close();
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
  const a1 = { signal: 'a', params: { x: 1 }, exits: { stopLossPct: 0.2 } };
  const withSignal = { ...base, strategies: { a: a1 } };
  assert.ok(canContinue(base, withSignal), 'adding a rule file keeps the run');
  assert.ok(!canContinue(withSignal, { ...base, strategies: { a: { ...a1, params: { x: 2 } } } }), 'changing a rule setting starts a new run');
  assert.ok(!canContinue(withSignal, { ...base, strategies: { a: { ...a1, exits: { stopLossPct: 0.1 } } } }), "changing a strategy's exits starts a new run");
  assert.ok(canContinue(withSignal, { ...base, strategies: { a: a1, b: { ...a1, exits: { stopLossPct: 0.1 } } } }), 'a new code-name with other exits keeps the run');
  const legacy = { ...base, strategies: undefined, signals: { a: { x: 1 } }, trade: { ...base.trade, stopLossPct: 0.2 } };
  assert.ok(canContinue(legacy, { ...base, trade: legacy.trade, strategies: { a: { ...a1, exits: { ...a1.exits, sizeUsd: DEFAULTS.trade.sizeUsd, takeProfitPct: 0.4, timeLimitMin: 60 } } } }), 'runs recorded before strategies existed carry on');
  assert.ok(!canContinue(base, { ...base, trade: { ...base.trade, feeRate: 0.01 } }), 'changing shared costs starts a new run');
  assert.ok(!canContinue(base, { ...base, engine: base.engine + 1 }));
});

test('a new run trades from fresh books while the old run finishes its open trades', async () => {
  const store = new Store(':memory:');
  let now = 0;
  const pools = () => [
    snap({ ts: now, poolAddress: 'P1', buyersM5: 50, sellersM5: 5 }),
    snap({ ts: now, poolAddress: 'P2', trendingRank: 2 }),
  ];
  const strategies = await falcon();
  const oldRun = store.beginRun(runSettings(DEFAULTS, strategies), 0);
  const deps = { store, provider: fakeProvider(() => now, pools), strategies, config: DEFAULTS, now: () => now, runId: oldRun };
  await runCycle(deps);
  now += 60_000;
  await runCycle(deps); // fills in the old run

  const config = { ...DEFAULTS, trade: { ...DEFAULTS.trade, stopLossPct: 0.1 } };
  const newStrategies = await falcon(config);
  const newRun = store.beginRun(runSettings(config, newStrategies), now);
  assert.notEqual(newRun, oldRun);
  now += 60_000;
  const r = await runCycle({ ...deps, strategies: newStrategies, config, runId: newRun });
  assert.ok(r.queued.some((t) => t.strategy === 'buyer-seller-ratio' && t.runId === newRun), 'not blocked by the old run holding P1');
  now += 61 * 60_000;
  const r2 = await runCycle({ ...deps, strategies: newStrategies, config, runId: newRun });
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
  assert.equal(verdict(trades(noisy(0.1, 5)), trades(noisy(0, 5))).label, 'too_early');
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
    profit: true, random: true, average: true, best: true, halves: true,
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
  const server = createServer({ store, config, signals: [], strategies: [], provider, app: /** @type {any} */ (app), aiEnabled: false, runId: 1, onQuit: () => quit++ });
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

test('the six strategies continue the run the original three were in', async () => {
  const signals = await loadSignals();
  const strategies = resolveStrategies(STRATEGY_DEFS, signals, DEFAULTS.trade);
  assert.deepEqual(strategies.map((s) => s.codeName), ['Falcon', 'Badger', 'Cobra', 'Hawk', 'Otter', 'Viper']);
  const store = new Store(':memory:');
  // Settings exactly as the previous version recorded them: one entry per rule, shared exits.
  const legacy = {
    engine: 2,
    startingBankrollUsd: DEFAULTS.startingBankrollUsd,
    trade: { ...DEFAULTS.trade },
    universe: { ...DEFAULTS.universe },
    signals: Object.fromEntries(signals.map((s) => [s.id, { ...s.params }])),
  };
  const old = Number(
    store.db.prepare("INSERT INTO runs (started_at, origin, settings) VALUES (1, 'live', ?)").run(JSON.stringify(legacy)).lastInsertRowid,
  );
  assert.equal(store.beginRun(runSettings(DEFAULTS, strategies), 2), old, 'adding Hawk, Otter and Viper keeps the run');
  store.close();
});

test('each strategy trades with its own exits and its own random picker', async () => {
  const store = new Store(':memory:');
  let now = 0;
  const pools = () => [
    snap({ ts: now, poolAddress: 'P1', buyersM5: 50, sellersM5: 5 }),
    snap({ ts: now, poolAddress: 'P2', trendingRank: 2 }),
  ];
  const strategies = resolveStrategies(
    STRATEGY_DEFS.filter((d) => d.signal === 'buyer-seller-ratio'),
    await bsr(),
    DEFAULTS.trade,
  );
  const deps = { store, provider: fakeProvider(() => now, pools), strategies, config: DEFAULTS, now: () => now, rand: () => 0.99, runId: store.beginRun(runSettings(DEFAULTS, strategies), 0) };
  const r = await runCycle(deps);
  const hawk = r.queued.find((t) => t.strategy === 'hawk');
  const hawkRandom = r.queued.find((t) => t.book === 'random:hawk');
  assert.equal(hawk?.stopLossPct, 0.1);
  assert.equal(hawk?.timeLimitMs, 20 * 60_000);
  assert.equal(hawkRandom?.stopLossPct, 0.1, 'the random picker uses the same exits');
  assert.equal(r.queued.find((t) => t.strategy === 'buyer-seller-ratio')?.stopLossPct, 0.2);
  assert.equal(store.recentSignalEvents('hawk', 5, deps.runId).length, 1);
  store.close();
});

test('coin results rank coins by strategy profit, random pickers left out', () => {
  const base = { sizeUsd: 50, feeRate: 0, slippageRate: 0, quantity: 100, openedAt: 1000, closedAt: null, pnlUsd: null };
  const trades = /** @type {any[]} */ ([
    { ...base, strategy: 'hawk', book: 'hawk', poolAddress: 'A', symbol: 'AAA', status: 'closed', closedAt: 2000, pnlUsd: 10 },
    { ...base, strategy: 'falcon', book: 'falcon', poolAddress: 'A', symbol: 'AAA', status: 'closed', closedAt: 3000, pnlUsd: -4 },
    { ...base, strategy: 'hawk', book: 'hawk', poolAddress: 'B', symbol: 'BBB', status: 'open' },
    { ...base, strategy: 'random', book: 'random:hawk', poolAddress: 'C', symbol: 'CCC', status: 'closed', closedAt: 2000, pnlUsd: 99 },
    { ...base, strategy: 'hawk', book: 'hawk', poolAddress: 'D', symbol: 'DDD', status: 'cancelled', openedAt: null },
  ]);
  // B is open: 100 tokens worth $0.60 each now, bought for $50, so +$10 before price impact.
  const coins = coinResults(trades, (pool) => (pool === 'B' ? { price: 0.6, liquidityUsd: null } : null));
  assert.deepEqual(
    coins.map((c) => c.symbol),
    ['BBB', 'AAA'],
  );
  assert.equal(coins[1].pnlUsd, 6);
  assert.deepEqual(coins[1].strategies, ['hawk', 'falcon']);
  assert.equal(coins[1].wins, 1);
  assert.ok(coins[0].openUsd > 9.9 && coins[0].openUsd <= 10, `open value ${coins[0].openUsd}`);
});

test('balance over time counts open trades at the price saved at each moment', () => {
  const base = { sizeUsd: 50, feeRate: 0, slippageRate: 0, quantity: 100, closedAt: null, pnlUsd: null, poolAddress: 'A' };
  const trades = /** @type {any[]} */ ([
    { ...base, strategy: 'hawk', book: 'hawk', status: 'closed', openedAt: 1000, closedAt: 3000, pnlUsd: -20 },
    { ...base, strategy: 'hawk', book: 'hawk', status: 'open', openedAt: 2500, poolAddress: 'B' },
    { ...base, strategy: 'random', book: 'random:hawk', status: 'open', openedAt: 1000 },
  ]);
  // A's 100 tokens bought for $50: worth $40 at t=2000, so -$10 then. B is bought at $0.50 and worth $0.70 by t=4000.
  const priceAt = priceHistory([
    { poolAddress: 'A', ts: 1000, priceUsd: 0.5, liquidityUsd: null },
    { poolAddress: 'A', ts: 2000, priceUsd: 0.4, liquidityUsd: null },
    { poolAddress: 'B', ts: 2500, priceUsd: 0.5, liquidityUsd: null },
    { poolAddress: 'B', ts: 3500, priceUsd: 0.7, liquidityUsd: null },
  ]);
  const [hawk, random] = strategyResults({
    trades,
    strategies: ['hawk'],
    startingBankroll: 1000,
    latestPrice: () => null,
    timeline: { times: [500, 2000, 3000, 4000], priceAt },
  });
  const at = (/** @type {any[]} */ c) => c.map((p) => Math.round(p.equity * 100) / 100);
  assert.deepEqual(at(hawk.valueCurve), [1000, 990, 980, 1000], 'before buying, open at a loss, sold, then the next trade up $20');
  assert.deepEqual(at(hawk.twin?.valueCurve ?? []), [1000, 990, 990, 990]);
  assert.deepEqual(at(random.valueCurve), at(hawk.twin?.valueCurve ?? []), 'the random row averages the random pickers');
});

test('a new run keeps pricing and closing trades left open in the old run', async () => {
  const store = new Store(':memory:');
  let now = 10_000_000;
  let price = 1;
  // A real move: FDV moves with the price and the pool's liquidity with its square root (see sanity.js).
  const real = () => ({ priceUsd: price, fdvUsd: 100_000 * price, marketCapUsd: 100_000 * price, liquidityUsd: 200_000 * Math.sqrt(price) });
  const pools = () => [
    snap({ ts: now, poolAddress: 'P1', symbol: 'A', ...real(), buyersM5: 50, sellersM5: 5 }),
    snap({ ts: now, poolAddress: 'P2', symbol: 'B', ...real(), trendingRank: 2 }),
  ];
  const first = await falcon();
  const old = { store, provider: fakeProvider(() => now, pools), strategies: first, config: DEFAULTS, now: () => now, rand: () => 0.99, runId: store.beginRun(runSettings(DEFAULTS, first), 0) };
  await runCycle(old);
  now += 60_000;
  assert.equal((await runCycle(old)).opened.length, 2);

  // Bigger trades: a new run starts, as when trade size went from $50 to $100.
  const bigger = { ...DEFAULTS, trade: { ...DEFAULTS.trade, sizeUsd: DEFAULTS.trade.sizeUsd * 2 } };
  const strategies = resolveStrategies(STRATEGY_DEFS.slice(0, 1), await bsr(), bigger.trade);
  const runId = store.beginRun(runSettings(bigger, strategies), now);
  assert.notEqual(runId, old.runId);

  now += 60_000;
  price = 2;
  const r = await runCycle({ ...old, config: bigger, strategies, runId });
  const closedOld = r.closed.filter((t) => t.runId === old.runId);
  assert.equal(closedOld.length, 2, 'the old run\'s open trades close under their own exits');
  assert.ok(closedOld.every((t) => t.exitReason === 'take_profit' && t.sizeUsd === DEFAULTS.trade.sizeUsd));
  assert.equal(store.trades({ status: 'open', runId: old.runId }).length, 0);
  store.close();
});

test('price sanity: a jump the pool and FDV did not move with is not trusted', () => {
  /** @param {number} ts @param {number} priceUsd @param {number} liquidityUsd @param {number} fdvUsd */
  const at = (ts, priceUsd, liquidityUsd, fdvUsd) => ({ ts, priceUsd, liquidityUsd, fdvUsd });
  // SPEC on 2026-10-04: 4.1x in a minute, liquidity flat, FDV only 2.8x.
  const before = at(0, 0.00021069, 3.16e5, 2.09e5);
  assert.match(String(suspectPrice(at(60_000, 0.00086539, 3.181e5, 5.771e5), before)), /liquidity .* and FDV/);
  // A real 4x: liquidity about 2x (square root), FDV 4x.
  assert.equal(suspectPrice(at(60_000, 0.00084, 6.3e5, 8.36e5), before), null);
  // A real crash where liquidity left with the price.
  assert.equal(suspectPrice(at(60_000, 0.00002, 0.9e5, 0.2e5), before), null);
  // Ordinary moves aren't checked; neither is a reading after a long gap.
  assert.equal(suspectPrice(at(60_000, 0.0003, 3.16e5, 2.09e5), before), null);
  assert.equal(suspectPrice(at(3600_000, 0.00086539, 3.181e5, 5.771e5), before), null);
});

test('a bad price reading does not close a trade, and old trades made on one are left out', async () => {
  const store = new Store(':memory:');
  let now = 10_000_000;
  let reading = { priceUsd: 1, fdvUsd: 100_000, marketCapUsd: 100_000, liquidityUsd: 200_000 };
  const pools = () => [snap({ ts: now, poolAddress: 'P1', symbol: 'A', ...reading, buyersM5: 50, sellersM5: 5 })];
  const strategies = await falcon();
  const deps = { store, provider: fakeProvider(() => now, pools), strategies, config: DEFAULTS, now: () => now, rand: () => 0.99, runId: store.beginRun(runSettings(DEFAULTS, strategies), 0) };
  await runCycle(deps);
  now += 60_000;
  const held = (await runCycle(deps)).opened.length;
  assert.ok(held >= 1);

  // A glitch: 4x the price, nothing else moved. Take profit (+40%) must not fire on it.
  now += 60_000;
  reading = { ...reading, priceUsd: 4 };
  const glitch = await runCycle(deps);
  assert.equal(glitch.closed.length, 0);
  assert.equal(store.flaggedReadings().length, 1);
  assert.equal(store.trades({ status: 'open' }).length, held);
  // Back to normal next poll: still open, nothing was sold at the bad price.
  now += 60_000;
  reading = { ...reading, priceUsd: 1.02 };
  assert.equal((await runCycle(deps)).closed.length, 0);

  // A trade an older version closed at that reading is kept, but flagged and not counted.
  const [open] = store.trades({ status: 'open', book: strategies[0].id });
  const bad = store.flaggedReadings()[0];
  store.updateTrade({ ...open, status: 'closed', closedAt: now, exitSnapshotId: bad.snapshotId, exitPrice: 4, exitFillPrice: 3.9, exitReason: 'take_profit', pnlUsd: 280, pnlPct: 2.8, proceedsUsd: 380 });
  assert.equal(checkSavedPrices(store, now), 1, 'checking the history again finds the same one reading');
  const [flagged] = store.trades({ status: 'closed' });
  assert.match(String(flagged.dataFlag), /price 4x/);
  assert.equal(store.cashDelta(flagged.book, deps.runId), 0, 'its made-up profit is not cash');
  store.close();
});

test('hot now: rules agreeing first, odds from trades with the same exits only', () => {
  const exits = { stopLossPct: 0.2, takeProfitPct: 0.4, timeLimitMin: 60 };
  const base = { status: 'closed', stopLossPct: 0.2, takeProfitPct: 0.4, timeLimitMs: 3600_000, dataFlag: null };
  const trades = /** @type {any[]} */ ([
    ...Array.from({ length: 12 }, (_, i) => ({ ...base, book: 'falcon', exitReason: i < 6 ? 'take_profit' : 'stop_loss' })),
    { ...base, book: 'falcon', exitReason: 'take_profit', takeProfitPct: 0.2 }, // other exits: a different question
    { ...base, book: 'falcon', exitReason: 'take_profit', dataFlag: 'bad price' }, // flagged: never counted
    ...Array.from({ length: 10 }, (_, i) => ({ ...base, book: 'random:falcon', exitReason: i < 2 ? 'take_profit' : 'time_limit' })),
    { ...base, book: 'badger', exitReason: 'take_profit' },
  ]);
  const odds = hitRates(trades, [{ id: 'falcon', trade: exits }, { id: 'badger', trade: exits }, { id: 'hawk', trade: exits }]);
  assert.deepEqual([odds.get('falcon')?.hit.hits, odds.get('falcon')?.hit.n, odds.get('falcon')?.random.hits], [6, 12, 2]);
  const ev = (/** @type {string} */ signalId, /** @type {string} */ pool, /** @type {number} */ ts) => ({ signalId, poolAddress: pool, symbol: pool, ts, priceUsd: 1 });
  const hot = hotCoins({
    // A: falcon and hawk share one rule. B: badger alone, 1 of 1. C: two different rules.
    events: [ev('falcon', 'A', 1), ev('hawk', 'A', 2), ev('badger', 'B', 3), ev('falcon', 'C', 1), ev('badger', 'C', 4)],
    strategies: [{ id: 'falcon', rule: 'r1' }, { id: 'hawk', rule: 'r1' }, { id: 'badger', rule: 'r2' }],
    odds,
    priceNow: () => 1.1,
  });
  assert.deepEqual(hot.map((c) => c.poolAddress), ['C', 'A', 'B'], '2 rules first; then 6 of 12 beats 1 of 1');
  assert.equal(hot[1].rules, 1, 'a fast and a slow version of one rule agree as one');
  assert.equal(hot[2].enoughTrades, false);
  assert.ok(Math.abs((hot[0].movePct ?? 0) - 0.1) < 1e-9);
});

test('starting over opens a new run that later starts continue, and time off splits the chart', async () => {
  const store = new Store(':memory:');
  const strategies = await falcon();
  const settings = runSettings(DEFAULTS, strategies);
  const first = store.beginRun(settings, 0);
  const fresh = store.startRun(settings, 1000, 'Started over from the page.');
  assert.notEqual(fresh, first);
  assert.equal(store.beginRun(settings, 2000), fresh, 'restarting the app keeps the run you started over into');
  // Polls every minute, then the computer sleeps for an hour.
  for (const ts of [0, 60_000, 120_000, 3720_000, 3780_000]) store.insertPoll({ ts, ok: true, calls: 1, pools: 1, error: null });
  assert.deepEqual(store.activeSpans(0, 3800_000, 5 * 60_000), [[0, 120_000], [3720_000, 3800_000]]);
  store.close();
});
