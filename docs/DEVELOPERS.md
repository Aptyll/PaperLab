# Paper Lab for developers

The technical side of Paper Lab: how to run it from a terminal, how a poll works, and how to add rules. For what the app is for, see the [README](../README.md). For a step-by-step install, see [SETUP.md](../SETUP.md).

## Run it

Needs Node 22.13 or newer (for the built-in SQLite). No build step.

```bash
npm install        # optional: only needed for type checking and AI scoring
npm start          # live data from GeckoTerminal  ->  http://localhost:4317
npm run demo       # fake market, no network, separate database
npm test
npm run check      # type check (JSDoc + // @ts-check)
```

`npm start` stores data in `data/paper.sqlite`. The demo writes to `data/demo.sqlite`, so fake trades never mix with real research data.

On Windows, `launcher/windows/Create desktop icon.cmd` adds a Paper Lab desktop icon that starts the app hidden with live data off (`--paused`) and opens the page. Nothing is added to startup.

## How it works

Every 60 seconds:

1. **Fetch** the GeckoTerminal Solana trending pools (1 API call) plus any pools with open trades that left the list (1 call per 30 pools). A built-in limiter keeps it under 25 calls a minute (the free limit is 30).
2. **Store** a snapshot per pool: price, market cap (or FDV when missing), liquidity, volume (5m/1h/6h/24h), buys/sells and unique buyers/sellers (5m/1h/24h), and pool creation time.
3. **Fill** trades queued at the previous check, at this check's price, the way a person copying a signal by hand would buy about a minute later. If the price has already risen more than 5% since the signal, the trade is cancelled instead (cancelled trades cost nothing and are left out of results).
4. **Close** open trades that hit stop loss (-20%), take profit (+40%) or the 60 minute limit. Prices are checked once per poll, so a fill happens at the observed price, which can be past the level. If a coin's pool loses more than 80% of its liquidity while held, the trade closes as **collapsed** and sells into what is left, which is usually a near-total loss.
5. **Run signals** on every trending pool with at least **$100K liquidity** and at least one sell in the last 5 minutes (a guard against coins that can be bought but not sold). These match the live trading rules. When a signal fires it queues a $100 paper trade, unless that signal already holds the token, closed it in the last 30 minutes, or is out of cash.
6. **Random twin.** Each time a signal queues a trade, that signal's random twin queues one on a randomly chosen token from the same filtered list, with the same size, costs, timing and exits. If the signal's trade is cancelled, so is the twin's. Every signal and every twin has its own $1,000. The scoreboard (home screen) shows each signal's "edge" over its twin and a verdict: too early, no edge, leaning, or clear.

Costs per trade, each way: 0.3% DEX fee, 1.5% execution slippage (delay, bots), and price impact from the pool's depth (constant-product math: $100 into a $100K pool costs about 0.2% more, into a $20K pool about 1%). Before impact, a token has to rise about 3.7% just to break even.

**Runs.** Every set of trading rules is its own run. If you change a shared setting (costs, the coin filter, the bankroll), a strategy's settings, or update to a version that simulates trades differently, a new run starts with fresh $1,000 books, and trades still open from the old run finish under their old rules. Earlier runs stay in the database: open one from the Guide page to see its scoreboard exactly as it ended. Adding or retiring a strategy, or adding a signal file, does not start a new run.

Updates never delete data. When a new version changes the database layout, it first saves a full copy (for example `data/paper.backup-v2-....sqlite`), then upgrades the database in place. Databases that an older version set aside (`data/paper.v1-....sqlite`) are merged back in as past runs and the files are left where they are.

## Strategies (bots)

A strategy is a bot name, one rule (a file in `src/signals/`), and optionally its own rule settings and exits (trade size, stop loss, take profit, time limit). They are listed in `src/strategies.js`:

| Bot | Formerly | Rule | Trade | Exits |
|---|---|---|---|---|
| Bot 1 | Falcon | Buy rush (`buyer-seller-ratio`) | $100 | −20% / +40% / 60 min |
| Bot 2 | Badger | Deep pool (`liquidity-mcap-ratio`) | $100 | −20% / +40% / 60 min |
| Bot 3 | Cobra | Volume burst (`volume-spike`) | $100 | −20% / +40% / 60 min |
| Bot 4 | Hawk | Buy rush | $100 | −10% / +20% / 20 min |
| Bot 5 | Otter | Deep pool | $100 | −10% / +20% / 20 min |
| Bot 6 | Viper | Volume burst | $100 | −10% / +20% / 20 min |
| Bot 7 | Eagle | Buy rush | $250 | −25% / +60% / 120 min |
| Bot 8 | Bison | Deep pool | $250 | −25% / +60% / 120 min |
| Bot 9 | Mamba | Volume burst | $250 | −25% / +60% / 120 min |
| Bot 10 | Kestrel | Buy rush, skips copycat tickers | $100 | −20% / +40% / 60 min |

Each strategy has its own $1,000 and its own random twin with the same exits. Bots 1 to 3 keep the signal ids as their ids, so trades recorded before strategies existed stay with them. Settings are fixed per id: to try other numbers, add a new bot with a new id; to stop one, set `retired: true` (it stops buying, open trades finish, history stays). The "could be luck" test gets stricter with the number of strategies in the run (a Bonferroni bar), and retired ones still count.

## Settings

Copy what you want to change into `config.local.json` (git-ignored). Example:

```json
{
  "pollIntervalSec": 60,
  "trade": { "sizeUsd": 100, "stopLossPct": 0.2, "takeProfitPct": 0.4, "timeLimitMin": 60 },
  "universe": { "minLiquidityUsd": 100000, "minSellsM5": 1 },
  "signalParams": { "volume-spike": { "minMultiple": 4 } }
}
```

All defaults are in `src/config.js`.

## Adding a signal

Add one file to `src/signals/`. It is picked up on restart. A signal no strategy uses trades as its own strategy, under its own id and name, with its own $1,000 and random twin; add entries to `src/strategies.js` for code-names or other exits.

```js
// src/signals/price-momentum.js
// @ts-check
/** @type {import('../types.js').SignalModule} */
export default {
  id: 'price-momentum',
  name: 'Price Momentum',
  description: 'Fires when price is up strongly over 5 minutes.',
  params: { minChangePct: 10 },
  evaluate({ snapshot, history, params }) {
    const c = snapshot.priceChangeM5;
    if (c === null) return { fired: false, value: 0, reason: 'no data' };
    return { fired: c >= params.minChangePct, value: c, reason: `up ${c.toFixed(1)}% in 5m` };
  },
};
```

`history` holds earlier snapshots of the same pool (oldest first, up to 6 hours) if a signal needs trends. Files starting with `_` are ignored.

## AI scoring (off by default, costs money)

When enabled, every newly opened trade is sent to Claude with its snapshot and recent history. Claude returns a probability that the trade closes in profit, and that probability is stored with the trade. The scoreboard then shows a calibration table and a Brier score against a "base rate" baseline.

To turn it on:

1. `npm install` (installs the optional `@anthropic-ai/sdk`)
2. `export ANTHROPIC_API_KEY=...`
3. Set `"ai": { "enabled": true }` in `config.local.json` (model and effort are configurable there too)

Each trade is one API call. Scoring runs in the background and never delays polling.

## Layout

```
src/
  main.js              entry point (Node version check)
  run.js               wires everything together and starts the server
  config.js            defaults + config.local.json
  types.js             JSDoc types: Snapshot, SignalModule, PaperTrade, ...
  db.js                SQLite schema and queries (node:sqlite)
  app.js               polling loop + background AI scoring
  server.js            localhost JSON API, server-sent events, static files
  providers/           geckoterminal.js (live), simulated.js (demo)
  signals/             one file per signal
  engine/              cycle.js (one poll), paper.js (trade math), stats.js (results)
  ai/scorer.js         optional Claude scoring
public/                dashboard (plain HTML/CSS/JS, vendored Lightweight Charts)
test/                  node:test tests
```

