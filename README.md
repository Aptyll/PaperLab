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

## How it works

Every 60 seconds:

1. **Fetch** the GeckoTerminal Solana trending pools (1 API call) plus any pools with open trades that left the list (1 call per 30 pools). A built-in limiter keeps it under 25 calls a minute (the free limit is 30).
2. **Store** a snapshot per pool: price, market cap (or FDV when missing), liquidity, volume (5m/1h/6h/24h), buys/sells and unique buyers/sellers (5m/1h/24h), and pool creation time.
3. **Close** open trades that hit stop loss (-20%), take profit (+40%) or the 60 minute limit. Prices are checked once per poll, so a fill happens at the observed price, which can be past the level.
4. **Run signals** on every trending pool with at least $5K liquidity. When one fires, it opens a $50 paper trade, unless that signal already holds the token, closed it in the last 30 minutes, or is out of cash.
5. **Random twin.** Each time a signal opens a trade, that signal's random twin buys a randomly chosen token from the same filtered list, with the same size, costs and exits. Every signal and every twin has its own $1,000, so both face the same cash limits. The Results tab shows each signal's "edge" over its twin.

Costs per trade: 0.3% fee and 1.5% slippage on entry and again on exit, so a token has to rise about 3.7% just to break even.

## Settings

Copy what you want to change into `config.local.json` (git-ignored). Example:

```json
{
  "pollIntervalSec": 60,
  "trade": { "sizeUsd": 50, "stopLossPct": 0.2, "takeProfitPct": 0.4, "timeLimitMin": 60 },
  "universe": { "minLiquidityUsd": 5000 },
  "signalParams": { "volume-spike": { "minMultiple": 4 } }
}
```

All defaults are in `src/config.js`.

## Adding a signal

Add one file to `src/signals/`. It is picked up on restart and gets its own tab, its own $1,000, and its own random twin.

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

When enabled, every newly opened trade is sent to Claude with its snapshot and recent history. Claude returns a probability that the trade closes in profit, and that probability is stored with the trade. The Results tab then shows a calibration table and a Brier score against a "base rate" baseline.

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
