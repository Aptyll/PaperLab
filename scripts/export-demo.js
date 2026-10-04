// @ts-check
// Saves one session as plain files for the public demo page (GitHub Pages).
//
//   node scripts/export-demo.js                 the newest session
//   node scripts/export-demo.js --session=4     Session 4, as numbered on the page
//   node scripts/export-demo.js --db=path       another database file
//
// Read-only: it copies the database to a temporary file first and reads that
// copy, so Paper Lab can keep running and its data is never changed. It writes
// what the page would have shown at the session's last price update into
// demo/data/, then checks the files for anything that looks personal (folder
// paths, email addresses, keys) and refuses to finish if it finds any.
//
// What ends up in the files: paper trades, public coin names, prices, pool and
// token addresses (public contracts, not wallets), the bots' settings and the
// research notes. Nothing else: there is no wallet anywhere in Paper Lab.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, ROOT } from '../src/config.js';

const arg = (/** @type {string} */ name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const config = loadConfig([]);
const source = path.resolve(arg('db') ?? config.dbPath);
const OUT = path.join(ROOT, 'demo', 'data');
/** Price history kept before the session starts, so coin charts have some lead-in. */
const LEAD_IN_MS = 2 * 3600_000;

// 1. A consistent copy of the database, including anything still in its write-ahead log.
const tmp = mkdtempSync(path.join(tmpdir(), 'paper-lab-demo-'));
const copy = path.join(tmp, 'copy.sqlite');
const src = new DatabaseSync(source, { readOnly: true });
src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
src.close();

// 2. Which session. Sessions are numbered on the page in the order they started, deleted ones included.
const peek = new DatabaseSync(copy, { readOnly: true });
const runRows = /** @type {{id: number, started_at: number, deleted_at?: number|null}[]} */ (
  /** @type {unknown} */ (peek.prepare('SELECT * FROM runs ORDER BY started_at, id').all())
);
const lastPoll = Number(/** @type {any} */ (peek.prepare('SELECT MAX(ts) AS t FROM polls').get())?.t ?? 0);
peek.close();
const wanted = arg('session') ? Number(arg('session')) : null;
const live = runRows.filter((r) => !r.deleted_at);
const pick = wanted !== null ? runRows[wanted - 1] : live[live.length - 1];
if (!pick || pick.deleted_at) {
  console.error(wanted !== null ? `There is no Session ${wanted}.` : 'There are no sessions yet.');
  process.exit(1);
}
const sessionN = runRows.indexOf(pick) + 1;
const newest = pick === live[live.length - 1];

// 3. The page asks the server for "now"; freeze it at the session's last price update.
const { Store } = await import('../src/db.js');
const store = new Store(copy);
const info = store.runs().find((r) => r.id === pick.id);
if (!info) throw new Error('session vanished');
const recordedAt = newest && lastPoll ? lastPoll : (info.lastActivityAt ?? info.startedAt);
Date.now = () => recordedAt;

const { loadSignals } = await import('../src/engine/signal-loader.js');
const { resolveStrategies } = await import('../src/engine/strategies.js');
const { default: strategyDefs } = await import('../src/strategies.js');
const { createServer } = await import('../src/server.js');
const signals = await loadSignals(config.signalParams);
const strategies = resolveStrategies(strategyDefs, signals, config.trade);
/** Stands in for the market data source: the export never fetches anything. */
const provider = /** @type {any} */ ({ id: 'geckoterminal', callsInLastMinute: () => 0 });
const server = createServer({ store, config, signals, strategies, provider, app: null, aiEnabled: false, runId: pick.id });
await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(undefined)));
const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

/** @param {string} url @returns {Promise<any>} */
async function get(url) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { host: 'localhost' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// 4. Everything the pages ask for, under the same names the demo page looks for (see demoUrl in public/app.js).
/** @type {Map<string, unknown>} */
const files = new Map();
const status = await get('/api/status');
// Other sessions stay in the list so this one keeps its number, but show as deleted: the demo has just this one.
status.runs = status.runs.map((/** @type {any} */ r) => (r.id === pick.id ? r : { ...r, settings: {}, note: null, deletedAt: r.deletedAt ?? recordedAt }));
status.live = false;
status.recentPolls = status.recentPolls.slice(0, 1);
status.bootId = 'demo';
files.set('status', status);

const results = await get('/api/results');
files.set('results', results);
const trades = await get('/api/trades?limit=5000');
files.set('trades', trades);
const active = status.strategies.filter((/** @type {any} */ s) => !s.retired).map((/** @type {any} */ s) => s.id);
const coins = await get(`/api/coin-results?strategies=${encodeURIComponent(active.join(','))}`);
files.set('coin-results', coins);
const hot = await get('/api/hot');
files.set('hot', hot);
const tokens = await get('/api/tokens');
files.set('tokens', tokens);
files.set('signals', await get('/api/signals'));
files.set('notes', await get('/api/notes'));
files.set('turnover-replay', await get('/api/turnover-replay'));

const ids = new Set([...active, ...results.strategies.map((/** @type {any} */ r) => r.strategy).filter((/** @type {string} */ s) => s !== 'random')]);
for (const id of ids) files.set(`strategies/${id}`, await get(`/api/strategies/${encodeURIComponent(id)}`));

// Every coin a page can link to: trending now, traded, best coins, hot now.
const pools = new Set([
  ...tokens.map((/** @type {any} */ t) => t.poolAddress),
  ...trades.map((/** @type {any} */ t) => t.poolAddress),
  ...coins.map((/** @type {any} */ c) => c.poolAddress),
  ...hot.coins.map((/** @type {any} */ c) => c.poolAddress),
]);
const from = info.startedAt - LEAD_IN_MS;
for (const pool of pools) {
  if (!pool) continue;
  const p = await get(`/api/pools/${encodeURIComponent(pool)}`);
  p.snapshots = p.snapshots.filter((/** @type {any} */ s) => s.ts >= from && s.ts <= recordedAt);
  p.turnover = p.turnover.filter((/** @type {any} */ s) => s.ts >= from && s.ts <= recordedAt);
  files.set(`pools/${pool}`, p);
}

server.close();
store.close();
rmSync(tmp, { recursive: true, force: true });

// 5. Nothing personal goes out. Pool and token addresses are public; these patterns are not.
const PERSONAL = [
  { what: 'a Windows folder path', re: /[A-Za-z]:\\\\(?:Users|Documents and Settings)\\\\/i },
  { what: 'a Mac or Linux home folder', re: /\/(?:Users|home)\/[^/"\s]+/ },
  { what: 'an email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/ },
  { what: 'an API key', re: /sk-ant-|api[_-]?key"\s*:\s*"[^"]/i },
  { what: 'a private key or seed phrase', re: /private[_ ]?key|seed[_ ]?phrase|mnemonic/i },
];
for (const [name, body] of files) {
  const text = JSON.stringify(body);
  for (const p of PERSONAL) {
    const m = text.match(p.re);
    if (m) {
      console.error(`Stopped: ${name} contains what looks like ${p.what} ("${m[0]}"). Nothing was written.`);
      process.exit(1);
    }
  }
}

// 6. Write the files, replacing any earlier export.
rmSync(OUT, { recursive: true, force: true });
for (const [name, body] of files) {
  const file = path.join(OUT, `${name}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(7)) : v)));
}
const manifest = { session: sessionN, startedAt: info.startedAt, recordedAt, trades: info.trades };
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const names = readdirSync(OUT, { recursive: true }).map(String);
const bytes = names.reduce((a, n) => a + (statSync(path.join(OUT, n)).isFile() ? statSync(path.join(OUT, n)).size : 0), 0);
console.log(`Saved Session ${sessionN} (${info.trades} trades, ${pools.size} coins) to demo/data/: ${names.length} files, ${(bytes / 1e6).toFixed(1)} MB.`);
