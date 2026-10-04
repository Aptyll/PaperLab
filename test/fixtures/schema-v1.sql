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
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  size_usd REAL NOT NULL,
  fee_rate REAL NOT NULL,
  slippage_rate REAL NOT NULL,
  stop_loss_pct REAL NOT NULL,
  take_profit_pct REAL NOT NULL,
  time_limit_ms INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  entry_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  entry_price REAL NOT NULL,
  entry_fill_price REAL NOT NULL,
  quantity REAL NOT NULL,
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
