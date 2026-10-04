# Paper Lab

A local research dashboard that paper-trades trending Solana memecoins. It watches the market, runs simple signal rules, opens **simulated** trades when a rule fires, and compares each rule against a random-pick baseline.

**Paper only.** There is no wallet connection, no private key handling and no order execution anywhere in this code. It binds to `localhost` only.

## Run it

Needs Node 22.13 or newer (for the built-in SQLite). No build step.

```bash
npm install        # optional: only needed for type checking and AI scoring
npm start          # live data from GeckoTerminal  ->  http://localhost:4317
npm run demo       # fake market, no network, separate database
npm test
npm run check      # type check (JSDoc + // @ts-check)
```

`npm start` stores data in `data/paper.sqlite`. The demo writes to `data/demo.sqlite`, so fake trades never mix with real research data. Delete a file to start over.

## Screens

- **Scoreboard** (home): one row per rule with its verdict against its random twin, a balance chart, and a feed of buys and sells. Click a row for that rule's page.
- **Rule page**: balance vs twin, open trades with their live result, closed trades with the reason each one fired. Twin trades, skipped trades and every fire are folded away below.
- **Coins**: the trending list. Coins below the liquidity floor are dimmed; dots show which rules hold a coin. Click one for its price chart with every buy and sell marked.

## How it works

Every 60 seconds:

1. **Fetch** the GeckoTerminal Solana trending pools (1 API call) plus any pools with open trades that left the list (1 call per 30 pools). A built-in limiter keeps it under 25 calls a minute (the free limit is 30).
2. **Store** a snapshot per pool: price, market cap (or FDV when missing), liquidity, volume (5m/1h/6h/24h), buys/sells and unique buyers/sellers (5m/1h/24h), and pool creation time.
3. **Fill** trades queued at the previous check, at this check's price, the way a person copying a signal by hand would buy about a minute later. If the price has already risen more than 5% since the signal, the trade is cancelled instead (cancelled trades cost nothing and are left out of results).
4. **Close** open trades that hit stop loss (-20%), take profit (+40%) or the 60 minute limit. Prices are checked once per poll, so a fill happens at the observed price, which can be past the level. If a coin's pool loses more than 80% of its liquidity while held, the trade closes as **collapsed** and sells into what is left, which is usually a near-total loss.
5. **Run signals** on every trending pool with at least **$100K liquidity** and at least one sell in the last 5 minutes (a guard against coins that can be bought but not sold). These match the live trading rules. When a signal fires it queues a $50 paper trade, unless that signal already holds the token, closed it in the last 30 minutes, or is out of cash.
6. **Random twin.** Each time a signal queues a trade, that signal's random twin queues one on a randomly chosen token from the same filtered list, with the same size, costs, timing and exits. If the signal's trade is cancelled, so is the twin's. Every signal and every twin has its own $1,000. The scoreboard (home screen) shows each signal's "edge" over its twin and a verdict: too early, no edge, leaning, or clear.

Costs per trade, each way: 0.3% DEX fee, 1.5% execution slippage (delay, bots), and price impact from the pool's depth (constant-product math: $50 into a $100K pool costs about 0.1% more, into a $20K pool about 0.5%). Before impact, a token has to rise about 3.7% just to break even.

If you upgrade from a version with different trade rules, the old database is renamed (for example `data/paper.v1-....sqlite`) and a fresh one starts, so results from different rules never mix.

## Settings

Copy what you want to change into `config.local.json` (git-ignored). Example:

```json
{
  "pollIntervalSec": 60,
  "trade": { "sizeUsd": 50, "stopLossPct": 0.2, "takeProfitPct": 0.4, "timeLimitMin": 60 },
  "universe": { "minLiquidityUsd": 100000, "minSellsM5": 1 },
  "signalParams": { "volume-spike": { "minMultiple": 4 } }
}
```

All defaults are in `src/config.js`.

## Adding a signal

Add one file to `src/signals/`. It is picked up on restart and gets its own scoreboard row and detail page, its own $1,000, and its own random twin.

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

## Data source and credits

Market data: [GeckoTerminal](https://www.geckoterminal.com) public API (free, no key, about 30 calls a minute). Charts: [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache 2.0, license in `public/vendor/`).
