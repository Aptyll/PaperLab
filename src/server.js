// @ts-check
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { strategyResults, calibration, coinResults, priceHistory, hitRates, hotCoins, GO_LIVE } from './engine/stats.js';
import { breakevenMove } from './engine/paper.js';
import { RANDOM_STRATEGY } from './engine/signal-loader.js';
import { runSettings } from './engine/runs.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
/** Changes on every start, so updated page files load fresh after a restart. */
const BOOT_ID = Date.now().toString(36);
/** Points on each balance-over-time line. The chart samples to its own grid, so more would not show. */
const CURVE_POINTS = 400;
/** "Hot now": coins a rule fired on within this long. */
const HOT_WINDOW_MIN = 15;
/** Polls further apart than this mean Paper Lab wasn't collecting (asleep, off): the chart skips that time. */
const GAP_MS = 5 * 60_000;
/** The last hour gets a point per poll (at most every 15s), so short chart views stay detailed. */
const RECENT_MS = 3600_000;
const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * Read-only JSON API plus static files. Binds to localhost only.
 *
 * @param {Object} deps
 * @param {import('./db.js').Store} deps.store
 * @param {import('./config.js').Config} deps.config
 * @param {import('./types.js').SignalModule[]} deps.signals
 * @param {import('./types.js').Strategy[]} deps.strategies
 * @param {import('./providers/provider.js').MarketProvider} deps.provider
 * @param {import('./app.js').App|null} deps.app
 * @param {boolean} deps.aiEnabled
 * @param {number} deps.runId  The run being traded now. Pages show it unless ?run= asks for an earlier one.
 * @param {() => void} [deps.onQuit]  Shuts the whole app down (the Quit button).
 * @returns {http.Server}
 */
export function createServer({ store, config, signals, strategies, provider, app, aiEnabled, runId, onQuit }) {
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();
  app?.on('cycle', (c) => {
    for (const res of sseClients) res.write(`event: cycle\ndata: ${JSON.stringify(c)}\n\n`);
  });
  app?.on('state', (live) => {
    for (const res of sseClients) res.write(`event: state\ndata: ${JSON.stringify({ live })}\n\n`);
  });

  const signalMeta = signals.map((s) => ({ id: s.id, name: s.name, description: s.description, params: s.params }));
  const strategyMeta = strategies.map((s) => ({
    id: s.id,
    codeName: s.codeName,
    rule: s.signal.id,
    params: s.params,
    trade: { sizeUsd: s.trade.sizeUsd, stopLossPct: s.trade.stopLossPct, takeProfitPct: s.trade.takeProfitPct, timeLimitMin: s.trade.timeLimitMin },
    retired: s.retired,
  }));

  /**
   * Add what the UI needs to explain a trade: the current move of open trades,
   * and why the signal picked it.
   * @param {import('./types.js').PaperTrade} t
   * @param {Map<number|undefined, string>} why
   */
  const decorate = (t, why) => {
    let markPct = null;
    if (t.status === 'open' && t.entryPrice) {
      const s = store.latestSnapshot(t.poolAddress);
      if (s) markPct = s.priceUsd / t.entryPrice - 1;
    }
    return { ...t, markPct, why: t.signalEventId !== null ? why.get(t.signalEventId) ?? null : null };
  };

  /** @param {string} pool */
  const latestPrice = (pool) => {
    const s = store.latestSnapshot(pool);
    return s ? { price: s.priceUsd, liquidityUsd: s.liquidityUsd } : null;
  };

  /**
   * Moments to chart each book's balance at, evenly spaced over the run, with
   * the saved prices of every coin it traded. A finished run's never changes, so it's kept.
   * @type {Map<string, import('./engine/stats.js').Timeline>}
   */
  const pastTimelines = new Map();
  /** @param {import('./types.js').PaperTrade[]} trades @param {number} start @param {number} end */
  const timeline = (trades, start, end) => {
    const key = `${trades.length}:${start}:${end}`;
    const kept = pastTimelines.get(key);
    if (kept) return kept;
    // Points spread over the time Paper Lab was collecting, not over the time it was off.
    const spans = store.activeSpans(start, end, GAP_MS);
    if (!spans.length) spans.push([start, end]);
    const total = spans.reduce((a, [s, e]) => a + (e - s), 0) || 1;
    /** @type {Set<number>} */
    const at = new Set([start, end]);
    for (const [s, e] of spans) {
      const k = Math.max(1, Math.round((CURVE_POINTS * (e - s)) / total));
      for (let i = 0; i <= k; i++) at.add(Math.round(s + ((e - s) * i) / k));
      const step = Math.max(15_000, config.pollIntervalSec * 1000);
      for (let t = Math.max(s, end - RECENT_MS); t < e; t += step) at.add(Math.round(t));
    }
    const times = [...at].sort((a, b) => a - b);
    const opened = trades.filter((t) => t.openedAt !== null);
    const from = Math.min(start, ...opened.map((t) => /** @type {number} */ (t.openedAt)));
    const pools = [...new Set(opened.map((t) => t.poolAddress))];
    const made = { times, priceAt: priceHistory(store.pricesBetween(pools, from, end)) };
    if (end < Date.now() - 60_000) pastTimelines.set(key, made);
    return made;
  };

  /** @param {URLSearchParams} q */
  const runOf = (q) => {
    const r = Number(q.get('run'));
    return Number.isInteger(r) && r > 0 ? r : runId;
  };

  /**
   * @param {string} pathname
   * @param {URLSearchParams} q
   * @returns {unknown}
   */
  function api(pathname, q) {
    if (pathname === '/api/status') {
      return {
        provider: provider.id,
        demo: provider.id === 'simulated',
        pollIntervalSec: config.pollIntervalSec,
        startingBankrollUsd: config.startingBankrollUsd,
        trade: config.trade,
        breakevenMovePct: breakevenMove(config.trade),
        universe: config.universe,
        ai: { enabled: aiEnabled, model: aiEnabled ? config.ai.model : null },
        callsInLastMinute: provider.callsInLastMinute(),
        lastCycle: app?.lastCycle ?? null,
        recentPolls: store.recentPolls(10),
        signals: signalMeta,
        strategies: strategyMeta,
        randomStrategy: RANDOM_STRATEGY,
        runId,
        runs: store.runs(),
        live: app?.running ?? false,
        bootId: BOOT_ID,
      };
    }
    if (pathname === '/api/tokens') {
      const since = Date.now() - Math.max(10 * 60_000, config.pollIntervalSec * 3000);
      const open = [...store.trades({ status: 'open', runId }), ...store.trades({ status: 'pending', runId })];
      const latest = store.latestPerPool(since);
      // Pools that dropped out of the latest trending list keep their old rank in
      // storage; blank it so ranks shown are always current.
      const newest = Math.max(0, ...latest.filter((s) => s.trendingRank !== null).map((s) => s.ts));
      return latest
        .map((s) => ({
          ...s,
          trendingRank: s.trendingRank !== null && s.ts >= newest - 1000 ? s.trendingRank : null,
          openStrategies: open.filter((t) => t.poolAddress === s.poolAddress).map((t) => t.strategy),
        }))
        .sort((a, b) => (a.trendingRank ?? 1e9) - (b.trendingRank ?? 1e9));
    }
    let m = pathname.match(/^\/api\/pools\/([^/]+)$/);
    if (m) {
      const pool = decodeURIComponent(m[1]);
      return {
        snapshots: store.poolHistory(pool, { limit: 3000 }),
        trades: store.trades({ poolAddress: pool, runId: runOf(q), limit: 500 }),
        heldBack: store.flaggedReadings([pool]),
      };
    }
    if (pathname === '/api/signals') return signalMeta;
    m = pathname.match(/^\/api\/strategies\/([a-z0-9-]+)$/);
    if (m) {
      const id = m[1];
      const run = runOf(q);
      const events = id === RANDOM_STRATEGY ? [] : store.recentSignalEvents(id, 5000, run);
      const why = new Map(events.map((e) => [e.id, e.reason]));
      return {
        events: events.slice(0, 200),
        trades: store.trades({ book: id, runId: run, limit: 500 }).map((t) => decorate(t, why)),
        twinTrades: store.trades({ book: `${RANDOM_STRATEGY}:${id}`, runId: run, limit: 500 }).map((t) => decorate(t, why)),
      };
    }
    if (pathname === '/api/trades') {
      return store
        .trades({
          strategy: q.get('strategy') ?? undefined,
          book: q.get('book') ?? undefined,
          status: q.get('status') ?? undefined,
          runId: runOf(q),
          limit: Math.min(Number(q.get('limit') ?? 500), 5000),
        })
        .map((t) => decorate(t, new Map()));
    }
    if (pathname === '/api/coin-results') {
      // Optional ?strategies=a,b limits it to the strategies on screen.
      const only = q.get('strategies')?.split(',').filter(Boolean);
      const trades = store.trades({ runId: runOf(q) }).filter((t) => !t.dataFlag && (!only || only.includes(t.strategy)));
      return coinResults(trades, latestPrice);
    }
    if (pathname === '/api/hot') {
      // What the strategies are buying right now, with each one's measured hit rate. Current run only.
      const now = Date.now();
      const active = strategies.filter((s) => !s.retired);
      const odds = hitRates(store.trades(), active);
      const coins = hotCoins({
        events: store.signalFiresSince(now - HOT_WINDOW_MIN * 60_000, runId),
        strategies: active.map((s) => ({ id: s.id, rule: s.signal.id })),
        odds,
        priceNow: (pool) => store.latestSnapshot(pool)?.priceUsd ?? null,
      });
      return { windowMin: HOT_WINDOW_MIN, coins: coins.slice(0, 8), more: Math.max(0, coins.length - 8) };
    }
    if (pathname === '/api/results') {
      const run = runOf(q);
      const all = store.trades({ runId: run });
      // Trades made on a price reading the sanity check flagged are left out, and listed so the page can say so.
      const trades = all.filter((t) => !t.dataFlag);
      const excluded = all
        .filter((t) => t.dataFlag && (t.status === 'open' || t.status === 'closed'))
        .map((t) => ({ id: t.id, strategy: t.strategy, book: t.book, symbol: t.symbol, poolAddress: t.poolAddress, status: t.status, openedAt: t.openedAt, closedAt: t.closedAt, pnlUsd: t.pnlUsd, reason: t.dataFlag }));
      const info = store.runs().find((r) => r.id === run);
      const settings = info?.settings;
      const start = info?.startedAt ?? 0;
      const end = run === runId ? Date.now() : info?.lastActivityAt ?? start;
      // A past run may include rules that have since been removed or renamed.
      const ids = strategies.map((s) => s.id).filter((id) => run === runId || trades.some((t) => t.strategy === id));
      for (const t of trades) if (t.strategy !== RANDOM_STRATEGY && !ids.includes(t.strategy)) ids.push(t.strategy);
      const bankroll = settings?.startingBankrollUsd ?? config.startingBankrollUsd;
      const costs = { ...config.trade, ...settings?.trade };
      return {
        runId: run,
        startingBankrollUsd: bankroll,
        breakevenMovePct: breakevenMove(costs),
        strategies: strategyResults({ trades, strategies: ids, startingBankroll: bankroll, latestPrice, window: { start, end }, tested: ids.length, timeline: timeline(trades, start, end) }),
        // Paper-run clock from the go-live rules: stops longer than 5 minutes don't count.
        clock: { startedAt: start, spans: store.activeSpans(start, end, GAP_MS), gapMs: GAP_MS, activeMs: store.activeMs(start, end, GO_LIVE.maxGapMs), targetMs: GO_LIVE.paperRunMs },
        calibration: calibration(trades),
        excluded,
      };
    }
    return undefined;
  }

  /** @param {string|undefined} host */
  const allowedHost = (host) => {
    // Guards against DNS rebinding: only answer requests addressed to localhost.
    const name = (host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return name === 'localhost' || name === '127.0.0.1' || name === '::1';
  };

  /** @param {string|undefined} origin */
  const sameOrigin = (origin) => {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      return u.protocol === 'http:' && allowedHost(u.host) && Number(u.port || 80) === config.port;
    } catch {
      return false;
    }
  };

  return http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) return send(res, 403, 'text/plain', 'Forbidden host');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST') {
        // The only things a page can change: live data on/off, and quit.
        // Another website open in the same browser could try to send these, so
        // require our own origin plus a custom header (which forces the browser
        // to ask permission first, and we never grant it).
        if (!sameOrigin(req.headers.origin) || req.headers['x-paper-lab'] !== '1') return send(res, 403, 'text/plain', 'Forbidden');
        if (url.pathname === '/api/live/on') {
          app?.start();
          return send(res, 200, 'application/json', JSON.stringify({ live: true }));
        }
        if (url.pathname === '/api/live/off') {
          await app?.stop();
          return send(res, 200, 'application/json', JSON.stringify({ live: false }));
        }
        if (url.pathname === '/api/reset') {
          // Start over: every strategy back to its bankroll in a new run. The old
          // run and all its trades stay, under past runs; its open trades still
          // finish under their own exits but don't count in the new run.
          await app?.inFlight;
          runId = store.startRun(runSettings(config, strategies), Date.now(), 'Started over from the page.');
          await app?.switchRun(runId);
          for (const c of sseClients) c.write(`event: cycle\ndata: {}\n\n`);
          return send(res, 200, 'application/json', JSON.stringify({ runId }));
        }
        if (url.pathname === '/api/quit' && onQuit) {
          send(res, 200, 'application/json', '{"quitting":true}');
          for (const c of sseClients) c.end();
          setImmediate(onQuit);
          return;
        }
        return send(res, 404, 'application/json', '{"error":"not found"}');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');

      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const body = api(url.pathname, url.searchParams);
        if (body === undefined) return send(res, 404, 'application/json', '{"error":"not found"}');
        return send(res, 200, 'application/json', JSON.stringify(body));
      }

      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');
      try {
        const data = await readFile(file);
        // Every response is already no-store; the version tag on the page's own files is a second guard so a
        // browser that keeps an old copy anyway (an old tab, back/forward cache) still gets the new files.
        if (rel === 'index.html') return send(res, 200, TYPES['.html'], String(data).replace(/(\/(?:style\.css|app\.js))"/g, `$1?v=${BOOT_ID}"`));
        return send(res, 200, TYPES[path.extname(file)] ?? 'application/octet-stream', data);
      } catch {
        return send(res, 404, 'text/plain', 'Not found');
      }
    } catch (err) {
      return send(res, 500, 'text/plain', err instanceof Error ? err.message : 'error');
    }
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string|Buffer} body
 */
function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
