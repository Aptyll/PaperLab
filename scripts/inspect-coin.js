// @ts-check
// Read-only look at one coin's saved prices and trades, to check a surprising
// result against the raw data. Changes nothing.
//
//   node scripts/inspect-coin.js SPEC            (all pools with that ticker)
//   node scripts/inspect-coin.js SPEC --demo     (the demo database)
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const symbol = args.find((a) => !a.startsWith('--'));
if (!symbol) {
  console.error('Usage: node scripts/inspect-coin.js <TICKER> [--demo]');
  process.exit(1);
}
const { dbPath } = loadConfig(args);
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const iso = (/** @type {any} */ ms) => (ms ? new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '-');
const num = (/** @type {any} */ v, d = 4) => (v === null || v === undefined ? '-' : Number(v).toPrecision(d));

const pools = /** @type {any[]} */ (
  db
    .prepare(
      `SELECT pool_address, token_address, name, dex, COUNT(*) n, MIN(ts) first, MAX(ts) last
       FROM snapshots WHERE symbol = ? COLLATE NOCASE GROUP BY pool_address, token_address ORDER BY first`,
    )
    .all(symbol)
);
console.log(`${pools.length} pool(s) with ticker ${symbol}:`);
for (const p of pools) console.log(`  pool ${p.pool_address}  token ${p.token_address}  "${p.name}" ${p.dex ?? ''}  ${p.n} snapshots ${iso(p.first)} to ${iso(p.last)}`);

for (const p of pools) {
  const trades = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, book, status, opened_at, closed_at, entry_price, entry_fill_price, exit_price, exit_fill_price, exit_reason, pnl_usd,
                entry_snapshot_id, exit_snapshot_id, entry_liquidity_usd, run_id
         FROM trades WHERE pool_address = ? ORDER BY COALESCE(opened_at, signal_at)`,
      )
      .all(p.pool_address)
  );
  console.log(`\n=== pool ${p.pool_address}: ${trades.length} trade(s)`);
  for (const t of trades) {
    console.log(
      `  #${t.id} run ${t.run_id} ${t.book} ${t.status}  open ${iso(t.opened_at)} @${num(t.entry_price)} (fill ${num(t.entry_fill_price)}, snap ${t.entry_snapshot_id}, liq ${num(t.entry_liquidity_usd, 3)})` +
        `  close ${iso(t.closed_at)} @${num(t.exit_price)} (fill ${num(t.exit_fill_price)}, snap ${t.exit_snapshot_id}) ${t.exit_reason ?? ''}  pnl ${num(t.pnl_usd)}`,
    );
  }
  // Every snapshot from an hour before the first trade to an hour after the last, or the last 120 if no trades.
  const from = trades.length ? Math.min(...trades.map((t) => Number(t.opened_at ?? t.closed_at ?? 0)).filter(Boolean)) - 3600_000 : 0;
  const to = trades.length ? Math.max(...trades.map((t) => Number(t.closed_at ?? t.opened_at ?? 0))) + 3600_000 : Number.MAX_SAFE_INTEGER;
  const snaps = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, ts, source, trending_rank, price_usd, liquidity_usd, fdv_usd, market_cap_usd, vol_m5, vol_h1, price_change_m5, price_change_h1, buys_m5, sells_m5
         FROM snapshots WHERE pool_address = ? AND ts BETWEEN ? AND ? ORDER BY ts, id`,
      )
      .all(p.pool_address, from, to)
  );
  console.log(`  ${snaps.length} snapshot(s) ${iso(from || null)} to ${to === Number.MAX_SAFE_INTEGER ? 'end' : iso(to)}:`);
  console.log('  id        time                  rank  price        liquidity  fdv        mcap       vol5m      vol1h      chg5m   chg1h   buys/sells5m  price/fdv');
  let prev = null;
  for (const s of snaps.slice(-400)) {
    const jump = prev && prev.price_usd ? s.price_usd / prev.price_usd : 1;
    const flag = jump > 2 || jump < 0.5 ? `  <-- x${jump.toFixed(2)}` : '';
    console.log(
      `  ${String(s.id).padEnd(9)} ${iso(s.ts)}  ${String(s.trending_rank ?? '-').padEnd(4)}  ${num(s.price_usd, 5).padEnd(11)}  ${num(s.liquidity_usd, 4).padEnd(9)}  ${num(s.fdv_usd, 4).padEnd(9)}  ${num(s.market_cap_usd, 4).padEnd(9)}  ${num(s.vol_m5, 4).padEnd(9)}  ${num(s.vol_h1, 4).padEnd(9)}  ${num(s.price_change_m5, 3).padEnd(6)}  ${num(s.price_change_h1, 3).padEnd(6)}  ${s.buys_m5 ?? '-'}/${s.sells_m5 ?? '-'}`.padEnd(150) +
        `  ${s.fdv_usd ? num(s.price_usd / s.fdv_usd, 4) : '-'}${flag}`,
    );
    prev = s;
  }
}
db.close();
