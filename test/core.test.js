// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeResponse } from '../src/providers/geckoterminal.js';
import { buildOpenTrade, exitReasonFor, closeTrade, breakevenMove } from '../src/engine/paper.js';
import { loadSignals } from '../src/engine/signal-loader.js';
import { runCycle } from '../src/engine/cycle.js';
import { strategyResults, wilson, calibration } from '../src/engine/stats.js';
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
    liquidityUsd: 20_000,
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

test('paper trade math: fees and slippage both ways', () => {
  const rules = DEFAULTS.trade;
  const t = buildOpenTrade({ strategy: 's', snapshot: { ...snap(), id: 1 }, rules, now: 0 });
  assert.equal(t.book, 's');
  // Flat price: lose both fees and both slippages.
  const flat = closeTrade(t, { price: 1, snapshotId: 2 }, 'time_limit', 1);
  assert.ok(flat.pnlUsd !== null && flat.pnlUsd < 0);
  // Exactly breakeven move returns the stake.
  const be = closeTrade(t, { price: 1 + breakevenMove(rules), snapshotId: 2 }, 'time_limit', 1);
  assert.ok(Math.abs(/** @type {number} */ (be.pnlUsd)) < 1e-9);
});

test('exit rules: stop loss, take profit, time limit, no data', () => {
  const t = buildOpenTrade({ strategy: 's', snapshot: { ...snap(), id: 1 }, rules: DEFAULTS.trade, now: 0 });
  const stale = 5 * 60_000;
  assert.equal(exitReasonFor(t, snap({ ts: 1000, priceUsd: 0.79 }), 1000, stale), 'stop_loss');
  assert.equal(exitReasonFor(t, snap({ ts: 1000, priceUsd: 1.41 }), 1000, stale), 'take_profit');
  assert.equal(exitReasonFor(t, snap({ ts: 1000, priceUsd: 1.1 }), 1000, stale), null);
  const hour = 60 * 60_000;
  assert.equal(exitReasonFor(t, snap({ ts: hour, priceUsd: 1.1 }), hour, stale), 'time_limit');
  assert.equal(exitReasonFor(t, snap({ ts: 1000, priceUsd: 1.1 }), hour, stale), 'no_data');
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

test('cycle opens signal trades with matching random twin trades, then closes them', async () => {
  const store = new Store(':memory:');
  let now = 10_000_000;
  let price = 1;
  /** @type {import('../src/providers/provider.js').MarketProvider} */
  const provider = {
    id: 'fake',
    callsInLastMinute: () => 0,
    totalCalls: () => 0,
    fetchTrending: async () => [
      snap({ ts: now, poolAddress: 'P1', symbol: 'A', priceUsd: price, buyersM5: 50, sellersM5: 5 }),
      snap({ ts: now, poolAddress: 'P2', symbol: 'B', priceUsd: price, trendingRank: 2 }),
    ],
    fetchPools: async () => [],
  };
  const signals = (await loadSignals()).filter((s) => s.id === 'buyer-seller-ratio');
  const deps = { store, provider, signals, config: DEFAULTS, now: () => now, rand: () => 0.99 };

  const r1 = await runCycle(deps);
  assert.equal(r1.opened.length, 2);
  const [sigTrade, randTrade] = r1.opened;
  assert.equal(sigTrade.strategy, 'buyer-seller-ratio');
  assert.equal(randTrade.strategy, 'random');
  assert.equal(randTrade.book, 'random:buyer-seller-ratio');
  assert.equal(randTrade.matchedTradeId, sigTrade.id);
  assert.equal(randTrade.poolAddress, 'P2', 'rand() = 0.99 picks the last candidate');

  // Signal still firing but already holding: skipped, nothing new opened.
  now += 60_000;
  const r2 = await runCycle(deps);
  assert.equal(r2.opened.length, 0);
  assert.equal(store.recentSignalEvents('buyer-seller-ratio', 1)[0].skipReason, 'already_open');

  // Price doubles: both hit take profit.
  now += 60_000;
  price = 2;
  const r3 = await runCycle(deps);
  assert.equal(r3.closed.length, 2);
  assert.ok(r3.closed.every((t) => t.exitReason === 'take_profit' && (t.pnlUsd ?? 0) > 0));

  // Right after closing: cooldown blocks re-entry.
  now += 60_000;
  const r4 = await runCycle(deps);
  assert.equal(r4.opened.length, 0);
  assert.equal(store.recentSignalEvents('buyer-seller-ratio', 1)[0].skipReason, 'cooldown');

  const res = strategyResults({
    trades: store.trades(),
    strategies: ['buyer-seller-ratio'],
    startingBankroll: 1000,
    latestPrice: () => null,
  });
  assert.equal(res[0].all.closed, 1);
  assert.equal(res[0].twin?.all.closed, 1);
  assert.ok(res[0].equityUsd > 1000);
  store.close();
});

test('a failed fetch still closes trades past their time limit', async () => {
  const store = new Store(':memory:');
  let now = 0;
  let fail = false;
  /** @type {import('../src/providers/provider.js').MarketProvider} */
  const provider = {
    id: 'fake',
    callsInLastMinute: () => 0,
    totalCalls: () => 0,
    fetchTrending: async () => {
      if (fail) throw new Error('boom');
      return [snap({ ts: now, poolAddress: 'P1', buyersM5: 50, sellersM5: 5 })];
    },
    fetchPools: async () => [],
  };
  const signals = (await loadSignals()).filter((s) => s.id === 'buyer-seller-ratio');
  const deps = { store, provider, signals, config: DEFAULTS, now: () => now };
  await runCycle(deps);
  fail = true;
  now += 61 * 60_000;
  const r = await runCycle(deps);
  assert.equal(r.ok, false);
  assert.equal(r.closed.length, 2, 'signal trade and its random twin');
  assert.ok(r.closed.every((t) => t.exitReason === 'no_data'));
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
