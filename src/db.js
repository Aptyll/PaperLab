// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { canContinue } from './engine/runs.js';

/** @typedef {import('./types.js').Snapshot} Snapshot */
/** @typedef {import('./types.js').PaperTrade} PaperTrade */
/** @typedef {import('./types.js').SignalEvent} SignalEvent */
/** @typedef {import('./engine/runs.js').RunSettings} RunSettings */

/**
 * @typedef {Object} Run
 * @property {number} id
 * @property {number} startedAt
 * @property {'live'|'migrated'|'imported'} origin  Live runs are started by this version; the others came from older versions.
 * @property {RunSettings} settings
 * @property {string|null} note
 * @property {number} trades       Trades that filled (cancelled ones not counted).
 * @property {number|null} lastActivityAt
 */

/** Snapshot fields in column order: [jsName, sqlName]. */
const SNAPSHOT_COLS = /** @type {const} */ ([
  ['ts', 'ts'],
  ['source', 'source'],
  ['poolAddress', 'pool_address'],
  ['tokenAddress', 'token_address'],
  ['symbol', 'symbol'],
  ['name', 'name'],
  ['dex', 'dex'],
  ['trendingRank', 'trending_rank'],
  ['priceUsd', 'price_usd'],
  ['marketCapUsd', 'market_cap_usd'],
  ['fdvUsd', 'fdv_usd'],
  ['liquidityUsd', 'liquidity_usd'],
  ['volM5', 'vol_m5'],
  ['volH1', 'vol_h1'],
  ['volH6', 'vol_h6'],
  ['volH24', 'vol_h24'],
  ['buysM5', 'buys_m5'],
  ['sellsM5', 'sells_m5'],
  ['buyersM5', 'buyers_m5'],
  ['sellersM5', 'sellers_m5'],
  ['buysH1', 'buys_h1'],
  ['sellsH1', 'sells_h1'],
  ['buyersH1', 'buyers_h1'],
  ['sellersH1', 'sellers_h1'],
  ['buysH24', 'buys_h24'],
  ['sellsH24', 'sells_h24'],
  ['priceChangeM5', 'price_change_m5'],
  ['priceChangeH1', 'price_change_h1'],
  ['poolCreatedAt', 'pool_created_at'],
]);

const TRADE_COLS = /** @type {const} */ ([
  ['strategy', 'strategy'],
  ['book', 'book'],
  ['matchedTradeId', 'matched_trade_id'],
  ['signalEventId', 'signal_event_id'],
  ['poolAddress', 'pool_address'],
  ['tokenAddress', 'token_address'],
  ['symbol', 'symbol'],
  ['status', 'status'],
  ['sizeUsd', 'size_usd'],
  ['feeRate', 'fee_rate'],
  ['slippageRate', 'slippage_rate'],
  ['stopLossPct', 'stop_loss_pct'],
  ['takeProfitPct', 'take_profit_pct'],
  ['timeLimitMs', 'time_limit_ms'],
  ['signalAt', 'signal_at'],
  ['signalSnapshotId', 'signal_snapshot_id'],
  ['signalPrice', 'signal_price'],
  ['cancelReason', 'cancel_reason'],
  ['openedAt', 'opened_at'],
  ['entrySnapshotId', 'entry_snapshot_id'],
  ['entryPrice', 'entry_price'],
  ['entryFillPrice', 'entry_fill_price'],
  ['entryLiquidityUsd', 'entry_liquidity_usd'],
  ['quantity', 'quantity'],
  ['closedAt', 'closed_at'],
  ['exitSnapshotId', 'exit_snapshot_id'],
  ['exitPrice', 'exit_price'],
  ['exitFillPrice', 'exit_fill_price'],
  ['exitReason', 'exit_reason'],
  ['proceedsUsd', 'proceeds_usd'],
  ['pnlUsd', 'pnl_usd'],
  ['pnlPct', 'pnl_pct'],
  ['aiProbability', 'ai_probability'],
  ['aiModel', 'ai_model'],
  ['aiRationale', 'ai_rationale'],
  ['runId', 'run_id'],
]);

const EVENT_COLS = /** @type {const} */ ([
  ['signalId', 'signal_id'],
  ['snapshotId', 'snapshot_id'],
  ['poolAddress', 'pool_address'],
  ['symbol', 'symbol'],
  ['ts', 'ts'],
  ['value', 'value'],
  ['reason', 'reason'],
  ['tradeId', 'trade_id'],
  ['skipReason', 'skip_reason'],
  ['runId', 'run_id'],
]);

/**
 * Bump when the tables change, and add a step to migrate(). Data is never
 * deleted: an older database is backed up, then upgraded in place, and its
 * trades become a past run that stays viewable.
 * 1: first version (no user_version set). 2: pending trades. 3: runs.
 */
export const SCHEMA_VERSION = 3;

const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('live', 'migrated', 'imported')),
  settings TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS imports (
  file TEXT PRIMARY KEY,
  imported_at INTEGER NOT NULL,
  run_id INTEGER REFERENCES runs(id)
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  dex TEXT,
  trending_rank INTEGER,
  price_usd REAL NOT NULL,
  market_cap_usd REAL,
  fdv_usd REAL,
  liquidity_usd REAL,
  vol_m5 REAL, vol_h1 REAL, vol_h6 REAL, vol_h24 REAL,
  buys_m5 INTEGER, sells_m5 INTEGER, buyers_m5 INTEGER, sellers_m5 INTEGER,
  buys_h1 INTEGER, sells_h1 INTEGER, buyers_h1 INTEGER, sellers_h1 INTEGER,
  buys_h24 INTEGER, sells_h24 INTEGER,
  price_change_m5 REAL, price_change_h1 REAL,
  pool_created_at INTEGER
);
CREATE INDEX IF NOT EXISTS snapshots_pool_ts ON snapshots (pool_address, ts);

-- Readings the price sanity check doesn't trust (src/engine/sanity.js). The
-- snapshot itself is kept as received; this only says not to act on it.
CREATE TABLE IF NOT EXISTS snapshot_flags (
  snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id),
  reason TEXT NOT NULL,
  flagged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots (ts);

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  pools INTEGER NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY,
  signal_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  pool_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  reason TEXT NOT NULL,
  trade_id INTEGER,
  skip_reason TEXT,
  run_id INTEGER REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS signal_events_signal_ts ON signal_events (signal_id, ts);
CREATE INDEX IF NOT EXISTS signal_events_run_signal ON signal_events (run_id, signal_id, ts);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  strategy TEXT NOT NULL,
  book TEXT NOT NULL,
  matched_trade_id INTEGER REFERENCES trades(id),
  signal_event_id INTEGER REFERENCES signal_events(id),
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'cancelled')),
  size_usd REAL NOT NULL,
  fee_rate REAL NOT NULL,
  slippage_rate REAL NOT NULL,
  stop_loss_pct REAL NOT NULL,
  take_profit_pct REAL NOT NULL,
  time_limit_ms INTEGER NOT NULL,
  signal_at INTEGER NOT NULL,
  signal_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  signal_price REAL NOT NULL,
  cancel_reason TEXT,
  opened_at INTEGER,
  entry_snapshot_id INTEGER REFERENCES snapshots(id),
  entry_price REAL,
  entry_fill_price REAL,
  entry_liquidity_usd REAL,
  quantity REAL,
  closed_at INTEGER,
  exit_snapshot_id INTEGER REFERENCES snapshots(id),
  exit_price REAL,
  exit_fill_price REAL,
  exit_reason TEXT,
  proceeds_usd REAL,
  pnl_usd REAL,
  pnl_pct REAL,
  ai_probability REAL,
  ai_model TEXT,
  ai_rationale TEXT,
  run_id INTEGER REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS trades_run_book ON trades (run_id, book, pool_address, status);
CREATE INDEX IF NOT EXISTS trades_strategy_status ON trades (strategy, status);
CREATE INDEX IF NOT EXISTS trades_book_pool ON trades (book, pool_address, status);
CREATE INDEX IF NOT EXISTS trades_pool_status ON trades (pool_address, status);
CREATE INDEX IF NOT EXISTS polls_ts ON polls (ts);
`;

/** Snapshots the price sanity check trusts. */
const TRUSTED = 'id NOT IN (SELECT snapshot_id FROM snapshot_flags)';
/** Why a trade can't be trusted: the sanity flag on the reading it was bought or sold at, if any. */
const TRADE_FLAG = '(SELECT reason FROM snapshot_flags f WHERE f.snapshot_id IN (trades.entry_snapshot_id, trades.exit_snapshot_id) LIMIT 1)';

/** Polls further apart than this mean Paper Lab was off (the chart marks the same gaps). */
export const OFF_GAP_MS = 5 * 60_000;
/**
 * Times Paper Lab was off: no poll for longer than OFF_GAP_MS. Goes in a WITH clause
 * ahead of any query that uses OFF_FLAG.
 */
const OFF_GAPS = `off_gaps AS MATERIALIZED (
  SELECT prev AS from_ts, ts AS to_ts FROM (SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev FROM polls) WHERE ts - prev > ${OFF_GAP_MS})`;
/**
 * Why else a trade can't be trusted: it was waiting to buy or holding while
 * Paper Lab was off, so nothing checked its stop or target and it sold (or
 * will sell) at whatever the price was hours later.
 */
const OFF_FLAG = `(SELECT 'open while Paper Lab was off for ' ||
    CASE WHEN g.to_ts - g.from_ts < 5400000 THEN printf('%d min', (g.to_ts - g.from_ts) / 60000) ELSE printf('%.1fh', (g.to_ts - g.from_ts) / 3600000.0) END
  FROM off_gaps g WHERE g.from_ts >= trades.signal_at AND g.to_ts <= COALESCE(trades.closed_at, 9e15) ORDER BY g.from_ts LIMIT 1)`;

const MANAGED = "(run_id IS NULL OR run_id NOT IN (SELECT id FROM runs WHERE origin = 'imported'))";
const SNAPSHOT_SQL_COLS = SNAPSHOT_COLS.map((c) => c[1]).join(', ');
const EVENT_SQL_COLS = 'signal_id, snapshot_id, pool_address, symbol, ts, value, reason, trade_id, skip_reason';
const TRADES_TABLE_SQL = /** @type {RegExpMatchArray} */ (SCHEMA.match(/CREATE TABLE IF NOT EXISTS trades \([\s\S]*?\n\);/))[0];

/** @param {DatabaseSync} db @param {string} sql @returns {any} */
const one = (db, sql) => db.prepare(sql).get();

/** @param {DatabaseSync} db @param {string} schema */
function hasTable(db, schema, name = 'trades') {
  return !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/**
 * SQL that copies trades from an older table into the current trades table.
 * Version 1 trades filled instantly, so their signal is their fill.
 * Offsets shift ids when merging another database into this one.
 *
 * @param {string} src       Source table, e.g. "trades_old" or "arc.trades".
 * @param {string} snapSrc   Snapshots table the source ids point into.
 * @param {boolean} v1
 * @param {{trade: number, event: number, snap: number}} off
 * @param {string} dest
 */
function tradeCopySql(src, snapSrc, v1, off, dest = 'main.trades') {
  const plus = (/** @type {string} */ e, /** @type {number} */ n) => (n ? `(${e} + ${n})` : e);
  /** @type {[string, string][]} */
  const map = [
    ['id', plus('t.id', off.trade)],
    ['strategy', 't.strategy'],
    ['book', 't.book'],
    ['matched_trade_id', plus('t.matched_trade_id', off.trade)],
    ['signal_event_id', plus('t.signal_event_id', off.event)],
    ['pool_address', 't.pool_address'],
    ['token_address', 't.token_address'],
    ['symbol', 't.symbol'],
    ['status', 't.status'],
    ['size_usd', 't.size_usd'],
    ['fee_rate', 't.fee_rate'],
    ['slippage_rate', 't.slippage_rate'],
    ['stop_loss_pct', 't.stop_loss_pct'],
    ['take_profit_pct', 't.take_profit_pct'],
    ['time_limit_ms', 't.time_limit_ms'],
    ['signal_at', v1 ? 't.opened_at' : 't.signal_at'],
    ['signal_snapshot_id', plus(v1 ? 't.entry_snapshot_id' : 't.signal_snapshot_id', off.snap)],
    ['signal_price', v1 ? 't.entry_price' : 't.signal_price'],
    ['cancel_reason', v1 ? 'NULL' : 't.cancel_reason'],
    ['opened_at', 't.opened_at'],
    ['entry_snapshot_id', plus('t.entry_snapshot_id', off.snap)],
    ['entry_price', 't.entry_price'],
    ['entry_fill_price', 't.entry_fill_price'],
    ['entry_liquidity_usd', v1 ? `(SELECT s.liquidity_usd FROM ${snapSrc} s WHERE s.id = t.entry_snapshot_id)` : 't.entry_liquidity_usd'],
    ['quantity', 't.quantity'],
    ['closed_at', 't.closed_at'],
    ['exit_snapshot_id', plus('t.exit_snapshot_id', off.snap)],
    ['exit_price', 't.exit_price'],
    ['exit_fill_price', 't.exit_fill_price'],
    ['exit_reason', 't.exit_reason'],
    ['proceeds_usd', 't.proceeds_usd'],
    ['pnl_usd', 't.pnl_usd'],
    ['pnl_pct', 't.pnl_pct'],
    ['ai_probability', 't.ai_probability'],
    ['ai_model', 't.ai_model'],
    ['ai_rationale', 't.ai_rationale'],
    ['run_id', ':run'],
  ];
  return `INSERT INTO ${dest} (${map.map((m) => m[0]).join(', ')}) SELECT ${map.map((m) => m[1]).join(', ')} FROM ${src} t`;
}

/**
 * Create a run describing trades made by an older version, from what the
 * trades themselves recorded. Returns null if there are no trades.
 * @param {DatabaseSync} db
 * @param {string} src
 * @param {boolean} v1
 * @param {number} engine
 * @param {'migrated'|'imported'} origin
 * @param {string} note
 */
function runFromTrades(db, src, v1, engine, origin, note) {
  const t = one(db, `SELECT size_usd, fee_rate, slippage_rate, stop_loss_pct, take_profit_pct, time_limit_ms FROM ${src} ORDER BY id DESC LIMIT 1`);
  if (!t) return null;
  const first = one(db, `SELECT MIN(${v1 ? 'opened_at' : 'signal_at'}) AS t FROM ${src}`).t;
  /** @type {RunSettings} */
  const settings = {
    engine,
    startingBankrollUsd: null,
    trade: {
      sizeUsd: t.size_usd,
      feeRate: t.fee_rate,
      slippageRate: t.slippage_rate,
      stopLossPct: t.stop_loss_pct,
      takeProfitPct: t.take_profit_pct,
      timeLimitMin: t.time_limit_ms / 60_000,
    },
    universe: null,
    signals: {},
  };
  const r = db
    .prepare('INSERT INTO main.runs (started_at, origin, settings, note) VALUES (?, ?, ?, ?)')
    .run(first ?? Date.now(), origin, JSON.stringify(settings), note);
  return Number(r.lastInsertRowid);
}

const NOTES = /** @type {Record<number, string>} */ ({
  1: 'First version: trades filled instantly at the signal price, with no price impact and no liquidity floor.',
  2: 'Recorded before runs were tracked.',
});

/**
 * Bring an older database up to the current tables, in place. A full backup
 * is written first. Returns the backup path, or null if nothing changed.
 * @param {DatabaseSync} db
 * @param {string} file
 */
function migrate(db, file) {
  const version = Number(one(db, 'PRAGMA user_version').user_version) || 1;
  if (!hasTable(db, 'main') || version >= SCHEMA_VERSION) return null;
  let backup = null;
  if (file !== ':memory:') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = file.replace(/\.sqlite$/, '') + `.backup-v${version}-${stamp}.sqlite`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(RUNS_SCHEMA);
  db.exec('BEGIN');
  try {
    const v1 = version < 2;
    const runId = runFromTrades(db, 'main.trades', v1, version, 'migrated', NOTES[version] ?? '');
    if (v1) {
      // The status rule changed, which SQLite can only do by rebuilding the table.
      db.exec(TRADES_TABLE_SQL.replace('CREATE TABLE IF NOT EXISTS trades', 'CREATE TABLE trades_v3'));
      db.prepare(tradeCopySql('main.trades', 'main.snapshots', true, { trade: 0, event: 0, snap: 0 }, 'trades_v3')).run({ run: runId });
      db.exec('DROP TABLE trades; ALTER TABLE trades_v3 RENAME TO trades;');
    } else {
      db.exec('ALTER TABLE trades ADD COLUMN run_id INTEGER REFERENCES runs(id)');
      db.prepare('UPDATE trades SET run_id = ?').run(runId);
    }
    db.exec('ALTER TABLE signal_events ADD COLUMN run_id INTEGER REFERENCES runs(id)');
    db.prepare('UPDATE signal_events SET run_id = ?').run(runId);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return backup;
}

/**
 * @param {readonly (readonly [string, string])[]} cols
 * @param {Record<string, any>} row
 */
function fromRow(cols, row) {
  /** @type {Record<string, any>} */
  const out = { id: row.id };
  for (const [js, sql] of cols) out[js] = row[sql] ?? null;
  return out;
}

/**
 * @param {readonly (readonly [string, string])[]} cols
 * @param {Record<string, any>} obj
 */
function toParams(cols, obj) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [js, sql] of cols) {
    const v = obj[js];
    out[sql] = v === undefined ? null : v;
  }
  return out;
}

/**
 * @param {string} table
 * @param {readonly (readonly [string, string])[]} cols
 */
const insertSql = (table, cols) =>
  `INSERT INTO ${table} (${cols.map((c) => c[1]).join(', ')}) VALUES (${cols.map((c) => ':' + c[1]).join(', ')})`;

export class Store {
  /** @param {string} file  Path, or ":memory:". */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    /** @type {string|null} Full copy taken before upgrading an older database, if one was. */
    this.backupPath = migrate(this.db, file);
    /** Whether a run split by an earlier upgrade was joined back together on this start. */
    this.rejoined = false;
    this.db.exec(RUNS_SCHEMA);
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; PRAGMA foreign_keys = ON;`);
    /** @type {{file: string, runId: number|null, error: string|null}[]} Databases set aside by earlier versions, merged in now. */
    this.imported = file === ':memory:' ? [] : this.importArchives(file);
    this.insertSnapshotStmt = this.db.prepare(insertSql('snapshots', SNAPSHOT_COLS));
    this.insertTradeStmt = this.db.prepare(insertSql('trades', TRADE_COLS));
    this.insertEventStmt = this.db.prepare(insertSql('signal_events', EVENT_COLS));
  }

  close() {
    this.db.close();
  }

  // ---- runs ----

  /**
   * Merge databases that older versions set aside (data/paper.v1-....sqlite)
   * into this one as past runs. The files themselves are left untouched.
   * @param {string} file
   */
  importArchives(file) {
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.sqlite$/, '');
    const escaped = base.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    const pattern = new RegExp('^' + escaped + '\\.v(\\d+)-.+\\.sqlite$');
    /** @type {{file: string, runId: number|null, error: string|null}[]} */
    const out = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      const m = name.match(pattern);
      if (!m || this.db.prepare('SELECT 1 FROM imports WHERE file = ?').get(name)) continue;
      try {
        out.push({ file: name, runId: this.importArchive(path.join(dir, name), name, Number(m[1])), error: null });
      } catch (err) {
        out.push({ file: name, runId: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  /**
   * @param {string} full
   * @param {string} name
   * @param {number} version
   * @returns {number|null}
   */
  importArchive(full, name, version) {
    const db = this.db;
    db.prepare('ATTACH DATABASE ? AS arc').run(full);
    try {
      /** @type {number|null} */
      let runId = null;
      this.tx(() => {
        if (hasTable(db, 'arc')) {
          const v1 = !db.prepare('PRAGMA arc.table_info(trades)').all().some((c) => c.name === 'signal_at');
          const max = (/** @type {string} */ t) => Number(one(db, `SELECT COALESCE(MAX(id), 0) AS m FROM main.${t}`).m);
          const off = { snap: max('snapshots'), event: max('signal_events'), trade: max('trades') };
          db.exec(`INSERT INTO main.snapshots (id, ${SNAPSHOT_SQL_COLS}) SELECT id + ${off.snap}, ${SNAPSHOT_SQL_COLS} FROM arc.snapshots`);
          runId = runFromTrades(db, 'arc.trades', v1, version, 'imported', NOTES[version] ?? '');
          if (hasTable(db, 'arc', 'signal_events')) {
            db.prepare(
              `INSERT INTO main.signal_events (id, ${EVENT_SQL_COLS}, run_id)
               SELECT id + ${off.event}, signal_id, snapshot_id + ${off.snap}, pool_address, symbol, ts, value, reason,
                      trade_id + ${off.trade}, skip_reason, :run FROM arc.signal_events`,
            ).run({ run: runId });
          }
          db.prepare(tradeCopySql('arc.trades', 'arc.snapshots', v1, off)).run({ run: runId });
        }
        db.prepare('INSERT INTO imports (file, imported_at, run_id) VALUES (?, ?, ?)').run(name, Date.now(), runId);
      });
      return runId;
    } finally {
      db.exec('DETACH DATABASE arc');
    }
  }

  /**
   * Continue the latest run if its rules match, otherwise start a new one.
   * @param {RunSettings} settings
   * @param {number} now
   * @returns {number} Run id.
   */
  beginRun(settings, now) {
    this.rejoinSplitRun(settings);
    const last = /** @type {any} */ (
      this.db.prepare("SELECT * FROM runs WHERE origin IN ('live', 'migrated') ORDER BY id DESC LIMIT 1").get()
    );
    if (last) {
      /** @type {RunSettings} */
      let prev = JSON.parse(last.settings);
      if (last.origin === 'migrated') {
        // An upgrade in the middle of a paper run shouldn't restart it. Older
        // versions only recorded the trade settings, so compare those (and the
        // engine); anything they didn't record is taken to be unchanged.
        const trade = { ...settings.trade, ...prev.trade };
        // Back then each rule traded under its own id with the run's exits.
        const strategies = Object.fromEntries(
          Object.entries(settings.strategies ?? {})
            .filter(([id, st]) => id === st.signal)
            .map(([id, st]) => [id, { ...st, exits: Object.fromEntries(Object.keys(st.exits).map((k) => [k, /** @type {any} */ (trade)[k]])) }]),
        );
        prev = { ...settings, engine: prev.engine, trade, strategies };
      }
      if (canContinue(prev, settings)) {
        const merged = { ...settings, signals: { ...prev.signals, ...settings.signals } };
        this.db.prepare("UPDATE runs SET settings = ?, origin = 'live' WHERE id = ?").run(JSON.stringify(merged), last.id);
        return Number(last.id);
      }
    }
    const r = this.db
      .prepare("INSERT INTO runs (started_at, origin, settings, note) VALUES (?, 'live', ?, NULL)")
      .run(now, JSON.stringify(settings));
    return Number(r.lastInsertRowid);
  }

  /**
   * Start a new run now, whatever the settings: "start over" from the page.
   * The run before it stays as it is, under past runs.
   * @param {RunSettings} settings
   * @param {number} now
   * @param {string} note
   * @returns {number}
   */
  startRun(settings, now, note) {
    const r = this.db.prepare("INSERT INTO runs (started_at, origin, settings, note) VALUES (?, 'live', ?, ?)").run(now, JSON.stringify(settings), note);
    return Number(r.lastInsertRowid);
  }

  /**
   * Repair for one specific mistake: an upgrade (before this fix) filed a
   * running paper test away as a "migrated" run and started a new run seconds
   * later with the same rules. If the newest run is exactly that, fold it back
   * into the run it split from, so the test reads as one continuous run.
   * A full copy of the database is saved first.
   * @param {RunSettings} settings
   * @returns {boolean} Whether a split run was rejoined.
   */
  rejoinSplitRun(settings) {
    // Runs merged in from set-aside files are created between the two, so skip them.
    const [live, prev] = /** @type {any[]} */ (
      this.db.prepare("SELECT * FROM runs WHERE origin IN ('live', 'migrated') ORDER BY id DESC LIMIT 2").all()
    );
    if (!live || !prev || live.origin !== 'live' || prev.origin !== 'migrated') return false;
    /** @type {RunSettings} */
    const old = JSON.parse(prev.settings);
    /** @type {RunSettings} */
    const cur = JSON.parse(live.settings);
    if (old.engine !== cur.engine || !canContinue({ ...cur, trade: { ...cur.trade, ...old.trade } }, cur)) return false;
    if (!canContinue(cur, settings)) return false;
    const lastOld = Number(
      one(this.db, `SELECT MAX(COALESCE(closed_at, opened_at, signal_at)) AS t FROM trades WHERE run_id = ${Number(prev.id)}`).t ?? 0,
    );
    if (Number(live.started_at) - lastOld > 30 * 60_000) return false; // a real pause between tests, not a split
    if (this.file !== ':memory:') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = this.file.replace(/\.sqlite$/, '') + `.backup-before-rejoin-${stamp}.sqlite`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      this.backupPath = backup;
    }
    this.tx(() => {
      this.db.prepare('UPDATE trades SET run_id = ? WHERE run_id = ?').run(prev.id, live.id);
      this.db.prepare('UPDATE signal_events SET run_id = ? WHERE run_id = ?').run(prev.id, live.id);
      this.db
        .prepare("UPDATE runs SET origin = 'live', settings = ?, note = NULL WHERE id = ?")
        .run(JSON.stringify({ ...cur, signals: { ...old.signals, ...cur.signals } }), prev.id);
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(live.id);
    });
    this.rejoined = true;
    return true;
  }

  /**
   * Every run, oldest first.
   * @returns {Run[]}
   */
  runs() {
    return this.db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM trades t WHERE t.run_id = r.id AND t.status IN ('open', 'closed')) AS trade_count,
           (SELECT MAX(COALESCE(t.closed_at, t.opened_at, t.signal_at)) FROM trades t WHERE t.run_id = r.id) AS last_activity
         FROM runs r ORDER BY r.started_at, r.id`,
      )
      .all()
      .map((r) => ({
        id: Number(r.id),
        startedAt: Number(r.started_at),
        origin: /** @type {Run['origin']} */ (r.origin),
        settings: JSON.parse(String(r.settings)),
        note: r.note === null ? null : String(r.note),
        trades: Number(r.trade_count),
        lastActivityAt: r.last_activity === null ? null : Number(r.last_activity),
      }));
  }

  /**
   * Run fn inside a transaction.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- snapshots ----

  /**
   * @param {Snapshot} s
   * @returns {Snapshot} The same snapshot with its new id.
   */
  insertSnapshot(s) {
    const r = this.insertSnapshotStmt.run(toParams(SNAPSHOT_COLS, s));
    return { ...s, id: Number(r.lastInsertRowid) };
  }

  /**
   * Trusted snapshots of one pool, oldest first (readings the sanity check flagged are left out).
   * @param {string} poolAddress
   * @param {{sinceTs?: number, beforeId?: number, limit?: number}} [opts]
   * @returns {Snapshot[]}
   */
  poolHistory(poolAddress, opts = {}) {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM snapshots
           WHERE pool_address = ? AND ts >= ? AND id < ? AND ${TRUSTED}
           ORDER BY ts DESC, id DESC LIMIT ?
         ) ORDER BY ts ASC, id ASC`,
      )
      .all(poolAddress, opts.sinceTs ?? 0, opts.beforeId ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 2000);
    return rows.map((r) => /** @type {Snapshot} */ (fromRow(SNAPSHOT_COLS, r)));
  }

  /**
   * The pool's latest trusted snapshot (before a snapshot id, if given).
   * @param {string} poolAddress
   * @param {number} [beforeId]
   * @returns {Snapshot|null}
   */
  latestSnapshot(poolAddress, beforeId = Number.MAX_SAFE_INTEGER) {
    const r = this.db
      .prepare(`SELECT * FROM snapshots WHERE pool_address = ? AND id < ? AND ${TRUSTED} ORDER BY ts DESC, id DESC LIMIT 1`)
      .get(poolAddress, beforeId);
    return r ? /** @type {Snapshot} */ (fromRow(SNAPSHOT_COLS, r)) : null;
  }

  /**
   * Record readings the sanity check doesn't trust. A reading flagged once stays flagged.
   * @param {Map<number, string>} flags  Snapshot id to reason.
   * @param {number} at
   */
  flagSnapshots(flags, at) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO snapshot_flags (snapshot_id, reason, flagged_at) VALUES (?, ?, ?)');
    this.tx(() => {
      for (const [id, reason] of flags) stmt.run(id, reason, at);
    });
  }

  /**
   * Flagged readings, newest first, optionally only of some pools.
   * @param {string[]} [pools]
   * @returns {{snapshotId: number, poolAddress: string, symbol: string, ts: number, priceUsd: number, reason: string}[]}
   */
  flaggedReadings(pools) {
    const rows = this.db
      .prepare(
        `SELECT f.snapshot_id, s.pool_address, s.symbol, s.ts, s.price_usd, f.reason FROM snapshot_flags f JOIN snapshots s ON s.id = f.snapshot_id
         ${pools ? 'WHERE s.pool_address IN (SELECT value FROM json_each(?))' : ''} ORDER BY s.ts DESC`,
      )
      .all(...(pools ? [JSON.stringify(pools)] : []));
    return rows.map((r) => ({
      snapshotId: Number(r.snapshot_id),
      poolAddress: String(r.pool_address),
      symbol: String(r.symbol),
      ts: Number(r.ts),
      priceUsd: Number(r.price_usd),
      reason: String(r.reason),
    }));
  }

  /**
   * Every pool's readings in order, for checking the whole history once.
   * @param {(pool: string, readings: {id: number, ts: number, priceUsd: number, fdvUsd: number|null, liquidityUsd: number|null}[]) => void} each
   */
  eachPoolReadings(each) {
    /** @type {string|null} */
    let pool = null;
    /** @type {{id: number, ts: number, priceUsd: number, fdvUsd: number|null, liquidityUsd: number|null}[]} */
    let rows = [];
    for (const r of this.db.prepare('SELECT id, pool_address, ts, price_usd, fdv_usd, liquidity_usd FROM snapshots ORDER BY pool_address, ts, id').iterate()) {
      if (r.pool_address !== pool) {
        if (pool !== null) each(pool, rows);
        pool = String(r.pool_address);
        rows = [];
      }
      rows.push({
        id: Number(r.id),
        ts: Number(r.ts),
        priceUsd: Number(r.price_usd),
        fdvUsd: r.fdv_usd === null ? null : Number(r.fdv_usd),
        liquidityUsd: r.liquidity_usd === null ? null : Number(r.liquidity_usd),
      });
    }
    if (pool !== null) each(pool, rows);
  }

  /**
   * Latest snapshot per pool among pools seen since `sinceTs`, best trending rank first.
   * @param {number} sinceTs
   * @returns {Snapshot[]}
   */
  latestPerPool(sinceTs) {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM snapshots s
         JOIN (SELECT pool_address, MAX(id) AS max_id FROM snapshots WHERE ts >= ? GROUP BY pool_address) m
           ON s.id = m.max_id
         ORDER BY s.trending_rank IS NULL, s.trending_rank, s.vol_h1 DESC`,
      )
      .all(sinceTs);
    return rows.map((r) => /** @type {Snapshot} */ (fromRow(SNAPSHOT_COLS, r)));
  }

  /**
   * Saved prices of some pools up to a moment, oldest first: just what valuing open trades back in time needs.
   * @param {string[]} pools
   * @param {number} sinceTs
   * @param {number} untilTs
   * @returns {{poolAddress: string, ts: number, priceUsd: number, liquidityUsd: number|null}[]}
   */
  pricesBetween(pools, sinceTs, untilTs) {
    if (!pools.length) return [];
    const rows = this.db
      .prepare(
        `SELECT pool_address, ts, price_usd, liquidity_usd FROM snapshots
         WHERE pool_address IN (SELECT value FROM json_each(?)) AND ts >= ? AND ts <= ? AND ${TRUSTED}
         ORDER BY pool_address, ts, id`,
      )
      .all(JSON.stringify(pools), sinceTs, untilTs);
    return rows.map((r) => ({
      poolAddress: String(r.pool_address),
      ts: Number(r.ts),
      priceUsd: Number(r.price_usd),
      liquidityUsd: r.liquidity_usd === null ? null : Number(r.liquidity_usd),
    }));
  }

  /** @param {number} id */
  snapshotById(id) {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
    return r ? /** @type {Snapshot} */ (fromRow(SNAPSHOT_COLS, r)) : null;
  }

  // ---- polls ----

  /** @param {{ts: number, ok: boolean, calls: number, pools: number, error: string|null}} p */
  insertPoll(p) {
    this.db
      .prepare('INSERT INTO polls (ts, ok, calls, pools, error) VALUES (?, ?, ?, ?, ?)')
      .run(p.ts, p.ok ? 1 : 0, p.calls, p.pools, p.error);
  }

  /**
   * Time the engine was actually running between two moments: gaps of more
   * than `maxGapMs` between polls (the app was stopped) don't count.
   * @param {number} from
   * @param {number} to
   * @param {number} maxGapMs
   */
  activeMs(from, to, maxGapMs) {
    const r = /** @type {{ms: number|null}|undefined} */ (
      this.db
        .prepare(
          `SELECT SUM(MIN(ts - prev, ?)) AS ms FROM (
             SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev FROM polls WHERE ts >= ? AND ts <= ?
           ) WHERE prev IS NOT NULL AND ts - prev <= ?`,
        )
        .get(maxGapMs, from, to, maxGapMs)
    );
    return r?.ms ?? 0;
  }

  /**
   * Stretches of time Paper Lab was collecting prices: polls no further apart
   * than maxGapMs. The chart draws these and skips the time between them.
   * A stretch still going at `to` runs to `to`.
   * @param {number} from
   * @param {number} to
   * @param {number} maxGapMs
   * @returns {[number, number][]}
   */
  activeSpans(from, to, maxGapMs) {
    /** @type {[number, number][]} */
    const spans = [];
    for (const r of this.db.prepare('SELECT ts FROM polls WHERE ts >= ? AND ts <= ? ORDER BY ts').iterate(from, to)) {
      const ts = Number(r.ts);
      const last = spans[spans.length - 1];
      if (last && ts - last[1] <= maxGapMs) last[1] = ts;
      else spans.push([ts, ts]);
    }
    const last = spans[spans.length - 1];
    if (last && to - last[1] <= maxGapMs) last[1] = to;
    return spans;
  }

  /** @param {number} limit */
  recentPolls(limit) {
    return this.db.prepare('SELECT * FROM polls ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---- signal events ----

  /**
   * @param {SignalEvent} e
   * @returns {SignalEvent}
   */
  insertSignalEvent(e) {
    const r = this.insertEventStmt.run(toParams(EVENT_COLS, e));
    return { ...e, id: Number(r.lastInsertRowid) };
  }

  /**
   * @param {number} id
   * @param {number|null} tradeId
   * @param {string|null} skipReason
   */
  resolveSignalEvent(id, tradeId, skipReason) {
    this.db.prepare('UPDATE signal_events SET trade_id = ?, skip_reason = ? WHERE id = ?').run(tradeId, skipReason, id);
  }

  /**
   * @param {string} signalId
   * @param {number} limit
   * @param {number} runId
   * @returns {SignalEvent[]}
   */
  recentSignalEvents(signalId, limit, runId) {
    return this.db
      .prepare('SELECT * FROM signal_events WHERE signal_id = ? AND run_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(signalId, runId, limit)
      .map((r) => /** @type {SignalEvent} */ (fromRow(EVENT_COLS, r)));
  }

  /**
   * Signal fires since a moment in a run, with the price they fired at, oldest first.
   * @param {number} sinceTs
   * @param {number} runId
   * @returns {{signalId: string, poolAddress: string, symbol: string, ts: number, priceUsd: number}[]}
   */
  signalFiresSince(sinceTs, runId) {
    return this.db
      .prepare(
        `SELECT e.signal_id, e.pool_address, e.symbol, e.ts, s.price_usd FROM signal_events e JOIN snapshots s ON s.id = e.snapshot_id
         WHERE e.run_id = ? AND e.ts >= ? ORDER BY e.ts, e.id`,
      )
      .all(runId, sinceTs)
      .map((r) => ({ signalId: String(r.signal_id), poolAddress: String(r.pool_address), symbol: String(r.symbol), ts: Number(r.ts), priceUsd: Number(r.price_usd) }));
  }

  // ---- trades ----

  /**
   * @param {PaperTrade} t
   * @returns {PaperTrade}
   */
  insertTrade(t) {
    const r = this.insertTradeStmt.run(toParams(TRADE_COLS, t));
    return { ...t, id: Number(r.lastInsertRowid) };
  }

  /**
   * Write every mutable column of an existing trade.
   * @param {PaperTrade} t
   */
  updateTrade(t) {
    const sets = TRADE_COLS.map((c) => `${c[1]} = :${c[1]}`).join(', ');
    this.db.prepare(`UPDATE trades SET ${sets} WHERE id = :id`).run({ ...toParams(TRADE_COLS, t), id: t.id ?? null });
  }

  /**
   * `managed` limits to trades the engine still looks after: everything except
   * trades merged in from databases set aside by older versions, which are
   * kept exactly as they were.
   * @param {{strategy?: string, book?: string, status?: string, poolAddress?: string, runId?: number, managed?: boolean, limit?: number}} [f]
   * @returns {PaperTrade[]}
   */
  trades(f = {}) {
    const where = [];
    /** @type {(string|number)[]} */
    const args = [];
    if (f.runId !== undefined) (where.push('run_id = ?'), args.push(f.runId));
    if (f.managed) where.push(MANAGED);
    if (f.strategy) (where.push('strategy = ?'), args.push(f.strategy));
    if (f.book) (where.push('book = ?'), args.push(f.book));
    if (f.status) (where.push('status = ?'), args.push(f.status));
    if (f.poolAddress) (where.push('pool_address = ?'), args.push(f.poolAddress));
    const sql = `WITH ${OFF_GAPS} SELECT *, ${TRADE_FLAG} AS price_flag, ${OFF_FLAG} AS off_flag FROM trades ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY signal_at DESC, id DESC LIMIT ?`;
    args.push(f.limit ?? 100000);
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => {
        const kind = r.price_flag ? 'price' : r.off_flag ? 'off' : null;
        return /** @type {PaperTrade} */ ({ ...fromRow(TRADE_COLS, r), dataFlag: r.price_flag ?? r.off_flag ?? null, dataFlagKind: kind });
      });
  }

  /**
   * @param {number} id
   * @param {{probability: number, model: string, rationale: string}} score
   */
  setAiScore(id, score) {
    this.db
      .prepare('UPDATE trades SET ai_probability = ?, ai_model = ?, ai_rationale = ? WHERE id = ?')
      .run(score.probability, score.model, score.rationale, id);
  }

  /** @param {number} id */
  tradeById(id) {
    const r = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
    return r ? /** @type {PaperTrade} */ (fromRow(TRADE_COLS, r)) : null;
  }

  /**
   * When this book last closed a trade on this pool in this run (epoch ms), or null.
   * @param {string} book
   * @param {string} poolAddress
   * @param {number} runId
   */
  lastClosedAt(book, poolAddress, runId) {
    const r = /** @type {{t: number|null}|undefined} */ (
      this.db
        .prepare("SELECT MAX(closed_at) AS t FROM trades WHERE book = ? AND pool_address = ? AND run_id = ? AND status = 'closed'")
        .get(book, poolAddress, runId)
    );
    return r?.t ?? null;
  }

  /**
   * Realized P&L minus cash locked in pending and open trades, for one book in one run.
   * @param {string} book
   * @param {number} runId
   */
  cashDelta(book, runId) {
    const r = /** @type {{d: number|null}|undefined} */ (
      this.db
        // A trade made on a reading the sanity check flagged, or open while Paper Lab was off, doesn't count, either way.
        .prepare(
          `WITH ${OFF_GAPS} SELECT SUM(CASE WHEN ${TRADE_FLAG} IS NOT NULL OR ${OFF_FLAG} IS NOT NULL THEN 0 WHEN status IN ('open', 'pending') THEN -size_usd WHEN status = 'closed' THEN pnl_usd ELSE 0 END) AS d FROM trades WHERE book = ? AND run_id = ?`,
        )
        .get(book, runId)
    );
    return r?.d ?? 0;
  }

  /** Distinct pools with a pending or open trade the engine manages (they need fresh prices every poll). */
  openPools() {
    return this.db
      .prepare(`SELECT DISTINCT pool_address AS p FROM trades WHERE status IN ('open', 'pending') AND ${MANAGED}`)
      .all()
      .map((r) => String(r.p));
  }
}
