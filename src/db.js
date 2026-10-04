// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';

/** @typedef {import('./types.js').Snapshot} Snapshot */
/** @typedef {import('./types.js').PaperTrade} PaperTrade */
/** @typedef {import('./types.js').SignalEvent} SignalEvent */

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
]);

/**
 * Bump when the trades table changes in a way old rows can't follow. An older
 * database is set aside (renamed, not deleted) and a fresh one is started,
 * since results from different trading rules shouldn't be mixed anyway.
 */
export const SCHEMA_VERSION = 2;

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
  skip_reason TEXT
);
CREATE INDEX IF NOT EXISTS signal_events_signal_ts ON signal_events (signal_id, ts);

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
  ai_rationale TEXT
);
CREATE INDEX IF NOT EXISTS trades_strategy_status ON trades (strategy, status);
CREATE INDEX IF NOT EXISTS trades_book_pool ON trades (book, pool_address, status);
CREATE INDEX IF NOT EXISTS trades_pool_status ON trades (pool_address, status);
`;

/**
 * @param {string} file
 * @returns {string|null}  New path of the archived database, or null if nothing was moved.
 */
function archiveIfOutdated(file) {
  if (!existsSync(file)) return null;
  const probe = new DatabaseSync(file);
  const version = Number(/** @type {any} */ (probe.prepare('PRAGMA user_version').get()).user_version);
  const hasTrades = probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trades'").get();
  probe.close();
  if (!hasTrades || version >= SCHEMA_VERSION) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = file.replace(/\.sqlite$/, '') + `.v${version || 1}-${stamp}.sqlite`;
  renameSync(file, target);
  for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, target + ext);
  return target;
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
    /** @type {string|null} Where an outdated database was moved, if it was. */
    this.archivedTo = null;
    if (file !== ':memory:') {
      mkdirSync(path.dirname(file), { recursive: true });
      this.archivedTo = archiveIfOutdated(file);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.insertSnapshotStmt = this.db.prepare(insertSql('snapshots', SNAPSHOT_COLS));
    this.insertTradeStmt = this.db.prepare(insertSql('trades', TRADE_COLS));
    this.insertEventStmt = this.db.prepare(insertSql('signal_events', EVENT_COLS));
  }

  close() {
    this.db.close();
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
   * Snapshots of one pool, oldest first.
   * @param {string} poolAddress
   * @param {{sinceTs?: number, beforeId?: number, limit?: number}} [opts]
   * @returns {Snapshot[]}
   */
  poolHistory(poolAddress, opts = {}) {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM snapshots
           WHERE pool_address = ? AND ts >= ? AND id < ?
           ORDER BY ts DESC, id DESC LIMIT ?
         ) ORDER BY ts ASC, id ASC`,
      )
      .all(poolAddress, opts.sinceTs ?? 0, opts.beforeId ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 2000);
    return rows.map((r) => /** @type {Snapshot} */ (fromRow(SNAPSHOT_COLS, r)));
  }

  /**
   * @param {string} poolAddress
   * @returns {Snapshot|null}
   */
  latestSnapshot(poolAddress) {
    const r = this.db
      .prepare('SELECT * FROM snapshots WHERE pool_address = ? ORDER BY ts DESC, id DESC LIMIT 1')
      .get(poolAddress);
    return r ? /** @type {Snapshot} */ (fromRow(SNAPSHOT_COLS, r)) : null;
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
   * @returns {SignalEvent[]}
   */
  recentSignalEvents(signalId, limit) {
    return this.db
      .prepare('SELECT * FROM signal_events WHERE signal_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(signalId, limit)
      .map((r) => /** @type {SignalEvent} */ (fromRow(EVENT_COLS, r)));
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
   * @param {{strategy?: string, book?: string, status?: string, poolAddress?: string, limit?: number}} [f]
   * @returns {PaperTrade[]}
   */
  trades(f = {}) {
    const where = [];
    /** @type {(string|number)[]} */
    const args = [];
    if (f.strategy) (where.push('strategy = ?'), args.push(f.strategy));
    if (f.book) (where.push('book = ?'), args.push(f.book));
    if (f.status) (where.push('status = ?'), args.push(f.status));
    if (f.poolAddress) (where.push('pool_address = ?'), args.push(f.poolAddress));
    const sql = `SELECT * FROM trades ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY signal_at DESC, id DESC LIMIT ?`;
    args.push(f.limit ?? 100000);
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => /** @type {PaperTrade} */ (fromRow(TRADE_COLS, r)));
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
   * When this book last closed a trade on this pool (epoch ms), or null.
   * @param {string} book
   * @param {string} poolAddress
   */
  lastClosedAt(book, poolAddress) {
    const r = /** @type {{t: number|null}|undefined} */ (
      this.db
        .prepare("SELECT MAX(closed_at) AS t FROM trades WHERE book = ? AND pool_address = ? AND status = 'closed'")
        .get(book, poolAddress)
    );
    return r?.t ?? null;
  }

  /**
   * Realized P&L minus cash locked in pending and open trades, for one book.
   * @param {string} book
   */
  cashDelta(book) {
    const r = /** @type {{d: number|null}|undefined} */ (
      this.db
        .prepare("SELECT SUM(CASE WHEN status IN ('open', 'pending') THEN -size_usd WHEN status = 'closed' THEN pnl_usd ELSE 0 END) AS d FROM trades WHERE book = ?")
        .get(book)
    );
    return r?.d ?? 0;
  }

  /** Distinct pools with a pending or open trade (they need fresh prices every poll). */
  openPools() {
    return this.db
      .prepare("SELECT DISTINCT pool_address AS p FROM trades WHERE status IN ('open', 'pending')")
      .all()
      .map((r) => String(r.p));
  }
}
