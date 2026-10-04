// @ts-check
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { strategyResults, calibration } from './engine/stats.js';
import { breakevenMove } from './engine/paper.js';
import { RANDOM_STRATEGY } from './engine/signal-loader.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
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
 * @param {import('./providers/provider.js').MarketProvider} deps.provider
 * @param {import('./app.js').App|null} deps.app
 * @param {boolean} deps.aiEnabled
 * @returns {http.Server}
 */
export function createServer({ store, config, signals, provider, app, aiEnabled }) {
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();
  app?.on('cycle', (c) => {
    for (const res of sseClients) res.write(`event: cycle\ndata: ${JSON.stringify(c)}\n\n`);
  });

  const signalMeta = signals.map((s) => ({ id: s.id, name: s.name, description: s.description, params: s.params }));

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
        randomStrategy: RANDOM_STRATEGY,
      };
    }
    if (pathname === '/api/tokens') {
      const since = Date.now() - Math.max(10 * 60_000, config.pollIntervalSec * 3000);
      const open = [...store.trades({ status: 'open' }), ...store.trades({ status: 'pending' })];
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
        trades: store.trades({ poolAddress: pool, limit: 500 }),
      };
    }
    if (pathname === '/api/signals') return signalMeta;
    m = pathname.match(/^\/api\/strategies\/([a-z0-9-]+)$/);
    if (m) {
      const id = m[1];
      const events = id === RANDOM_STRATEGY ? [] : store.recentSignalEvents(id, 5000);
      const why = new Map(events.map((e) => [e.id, e.reason]));
      return {
        events: events.slice(0, 200),
        trades: store.trades({ book: id, limit: 500 }).map((t) => decorate(t, why)),
        twinTrades: store.trades({ book: `${RANDOM_STRATEGY}:${id}`, limit: 500 }).map((t) => decorate(t, why)),
      };
    }
    if (pathname === '/api/trades') {
      return store
        .trades({
          strategy: q.get('strategy') ?? undefined,
          book: q.get('book') ?? undefined,
          status: q.get('status') ?? undefined,
          limit: Math.min(Number(q.get('limit') ?? 500), 5000),
        })
        .map((t) => decorate(t, new Map()));
    }
    if (pathname === '/api/results') {
      const trades = store.trades();
      return {
        startingBankrollUsd: config.startingBankrollUsd,
        breakevenMovePct: breakevenMove(config.trade),
        strategies: strategyResults({
          trades,
          strategies: signals.map((s) => s.id),
          startingBankroll: config.startingBankrollUsd,
          latestPrice,
        }),
        calibration: calibration(trades),
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

  return http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) return send(res, 403, 'text/plain', 'Forbidden host');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
      const url = new URL(req.url ?? '/', 'http://localhost');

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
