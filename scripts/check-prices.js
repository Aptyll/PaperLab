// @ts-check
// Dry run of the price sanity check (src/engine/sanity.js) over a saved
// database: which readings it would hold back and which trades it would leave
// out. Read-only; changes nothing.
//
//   node scripts/check-prices.js           (the real database)
//   node scripts/check-prices.js --demo
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { flagReadings } from '../src/engine/sanity.js';

const { dbPath } = loadConfig(process.argv.slice(2));
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

/** @type {Map<number, string>} */
const flags = new Map();
/** @type {Map<number, {pool: string, ts: number, price: number}>} */
const info = new Map();
let total = 0;
/** @type {string|null} */
let pool = null;
/** @type {any[]} */
let rows = [];
const flush = () => {
  for (const [id, why] of flagReadings(rows)) flags.set(id, why);
};
for (const r of db.prepare('SELECT id, pool_address, ts, price_usd, fdv_usd, liquidity_usd FROM snapshots ORDER BY pool_address, ts, id').iterate()) {
  total++;
  if (r.pool_address !== pool) {
    flush();
    pool = String(r.pool_address);
    rows = [];
  }
  const s = { id: Number(r.id), ts: Number(r.ts), priceUsd: Number(r.price_usd), fdvUsd: r.fdv_usd === null ? null : Number(r.fdv_usd), liquidityUsd: r.liquidity_usd === null ? null : Number(r.liquidity_usd) };
  rows.push(s);
  info.set(s.id, { pool, ts: s.ts, price: s.priceUsd });
}
flush();

const symbols = new Map(db.prepare('SELECT pool_address, MAX(symbol) s FROM snapshots GROUP BY pool_address').all().map((r) => [String(r.pool_address), String(r.s)]));
console.log(`${total} price readings checked, ${flags.size} would be held back (${((flags.size / Math.max(1, total)) * 100).toFixed(2)}%).`);
const byPool = new Map();
for (const id of flags.keys()) {
  const p = /** @type {any} */ (info.get(id)).pool;
  byPool.set(p, (byPool.get(p) ?? 0) + 1);
}
console.log(`Across ${byPool.size} coin(s):`);
for (const [p, n] of [...byPool].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${symbols.get(p)} (${p}): ${n}`);
console.log('\nExamples:');
for (const [id, why] of [...flags].slice(0, 40)) {
  const i = /** @type {any} */ (info.get(id));
  console.log(`  ${iso(i.ts)} ${symbols.get(i.pool)} #${id} @${i.price.toPrecision(5)}: ${why}`);
}
const trades = db
  .prepare("SELECT id, run_id, book, symbol, status, entry_snapshot_id, exit_snapshot_id, pnl_usd FROM trades WHERE status IN ('open', 'closed')")
  .all()
  .filter((t) => flags.has(Number(t.entry_snapshot_id)) || flags.has(Number(t.exit_snapshot_id)));
console.log(`\n${trades.length} trade(s) would be left out of results:`);
for (const t of trades) console.log(`  #${t.id} run ${t.run_id} ${t.book} ${t.symbol} ${t.status} pnl ${t.pnl_usd ?? '-'} (${flags.get(Number(t.entry_snapshot_id)) ? 'bought' : 'sold'} on: ${flags.get(Number(t.entry_snapshot_id)) ?? flags.get(Number(t.exit_snapshot_id))})`);
db.close();
