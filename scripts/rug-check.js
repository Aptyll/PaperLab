// @ts-check
// Would a cheap filter have kept the strategies out of rug pulls? For every
// finished trade, looks at what was known when it was signalled (pool age,
// another coin already trending under the same ticker, a recent collapse on
// that ticker) and reports, per filter, what it would have blocked: the
// collapses it saves AND the good trades it costs. Read-only; changes nothing.
//
//   node scripts/rug-check.js           (the real database)
//   node scripts/rug-check.js --demo
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';

const { dbPath } = loadConfig(process.argv.slice(2));
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const H = 3600_000;
const OFF_GAP_MS = 5 * 60_000;

// Off periods and bad readings, so trades the results already leave out are left out here too.
const polls = db.prepare('SELECT ts FROM polls ORDER BY ts').all().map((r) => Number(r.ts));
/** @type {[number, number][]} */
const gaps = [];
for (let i = 1; i < polls.length; i++) if (polls[i] - polls[i - 1] > OFF_GAP_MS) gaps.push([polls[i - 1], polls[i]]);
const hasFlags = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'snapshot_flags'").get();
const flagged = new Set(hasFlags ? db.prepare('SELECT snapshot_id FROM snapshot_flags').all().map((r) => Number(r.snapshot_id)) : []);

const trades = /** @type {any[]} */ (
  db
    .prepare(
      `SELECT t.id, t.strategy, t.book, t.symbol, t.pool_address, t.token_address, t.signal_at, t.closed_at, t.exit_reason, t.pnl_usd,
              t.entry_snapshot_id, t.exit_snapshot_id, s.pool_created_at, s.liquidity_usd
       FROM trades t LEFT JOIN snapshots s ON s.id = t.entry_snapshot_id
       WHERE t.status = 'closed' ORDER BY t.signal_at`,
    )
    .all()
).filter((t) => !flagged.has(Number(t.entry_snapshot_id)) && !flagged.has(Number(t.exit_snapshot_id)) && !gaps.some(([a, b]) => a >= t.signal_at && b <= t.closed_at));

// When each token was first seen, by ticker: a later token under a ticker already seen is a copycat.
/** @type {Map<string, {token: string, first: number}[]>} */
const byTicker = new Map();
for (const r of db.prepare('SELECT UPPER(symbol) AS sym, token_address AS token, MIN(ts) AS first FROM snapshots GROUP BY UPPER(symbol), token_address').all()) {
  const list = byTicker.get(String(r.sym)) ?? [];
  list.push({ token: String(r.token), first: Number(r.first) });
  byTicker.set(String(r.sym), list);
}
// Collapses by ticker, from any book (what the engine itself had seen happen).
const collapses = /** @type {any[]} */ (db.prepare("SELECT UPPER(symbol) AS sym, token_address AS token, closed_at FROM trades WHERE exit_reason = 'collapsed'").all());

/** @param {any} t @param {number} withinMs */
const seenSince = db.prepare('SELECT 1 FROM snapshots WHERE token_address = ? AND ts > ? AND ts <= ? LIMIT 1');
// Same test as the live rule (Store.copycatOf): another token under this ticker, seen before this one and still seen in the window.
const copycat = (t, withinMs) =>
  (byTicker.get(String(t.symbol).toUpperCase()) ?? []).some(
    (o) =>
      o.token !== t.token_address &&
      o.first < (byTicker.get(String(t.symbol).toUpperCase())?.find((x) => x.token === t.token_address)?.first ?? t.signal_at) &&
      !!seenSince.get(o.token, t.signal_at - withinMs, t.signal_at),
  );
/** @param {any} t @param {number} withinMs */
const tickerCollapsed = (t, withinMs) => collapses.some((c) => c.sym === String(t.symbol).toUpperCase() && c.closed_at < t.signal_at && c.closed_at > t.signal_at - withinMs);
/** @param {any} t */
const ageMin = (t) => (t.pool_created_at ? (t.signal_at - Number(t.pool_created_at)) / 60_000 : null);

/** @type {[string, (t: any) => boolean][]} */
const FILTERS = [
  ['pool under 15 min old', (t) => (ageMin(t) ?? Infinity) < 15],
  ['pool under 30 min old', (t) => (ageMin(t) ?? Infinity) < 30],
  ['pool under 60 min old', (t) => (ageMin(t) ?? Infinity) < 60],
  ['pool under 2 h old', (t) => (ageMin(t) ?? Infinity) < 120],
  ['copycat ticker (other token seen first, last 24 h)', (t) => copycat(t, 24 * H)],
  ['ticker collapsed in the last 6 h', (t) => tickerCollapsed(t, 6 * H)],
  ['copycat OR ticker collapsed', (t) => copycat(t, 24 * H) || tickerCollapsed(t, 6 * H)],
  ['copycat OR pool under 30 min', (t) => copycat(t, 24 * H) || (ageMin(t) ?? Infinity) < 30],
];

const money = (/** @type {number} */ v) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(0)}`;
/** @param {string} label @param {any[]} list */
function report(label, list) {
  const sum = (/** @type {any[]} */ l) => l.reduce((a, t) => a + Number(t.pnl_usd ?? 0), 0);
  const rugs = list.filter((t) => t.exit_reason === 'collapsed');
  console.log(`\n=== ${label}: ${list.length} finished trades, ${money(sum(list))}; ${rugs.length} collapsed (${money(sum(rugs))})`);
  console.log('  filter                                              blocks  of which collapsed  blocked P&L  P&L of the rest');
  for (const [name, f] of FILTERS) {
    const hit = list.filter(f);
    const hitRugs = hit.filter((t) => t.exit_reason === 'collapsed');
    console.log(`  ${name.padEnd(50)}  ${String(hit.length).padStart(6)}  ${`${hitRugs.length} of ${rugs.length}`.padStart(18)}  ${money(sum(hit)).padStart(11)}  ${money(sum(list) - sum(hit)).padStart(15)}`);
  }
}

const known = trades.filter((t) => t.pool_created_at).length;
console.log(`${trades.length} finished trades counted (bad-price and off-period trades left out, as in the results); pool age known for ${known}.`);
report('Strategies', trades.filter((t) => t.strategy !== 'random'));
report('Random pickers', trades.filter((t) => t.strategy === 'random'));

console.log('\nCollapsed strategy trades (latest 60):');
for (const t of trades.filter((x) => x.exit_reason === 'collapsed' && x.strategy !== 'random').slice(-60)) {
  const age = ageMin(t);
  console.log(`  #${t.id} ${new Date(t.signal_at).toISOString().slice(0, 16)}Z ${t.strategy} ${t.symbol} ${String(t.pool_address).slice(0, 6)}… age ${age === null ? '?' : `${Math.round(age)} min`}  copycat ${copycat(t, 24 * H) ? 'yes' : 'no'}  ticker collapsed before ${tickerCollapsed(t, 6 * H) ? 'yes' : 'no'}  ${money(Number(t.pnl_usd))}`);
}
db.close();
