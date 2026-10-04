// @ts-check
// Core data shapes shared across the app. This file only holds JSDoc typedefs.

/**
 * One timestamped market observation of a single pool.
 * Prices are USD. Nullable fields are ones the data source sometimes omits.
 *
 * @typedef {Object} Snapshot
 * @property {number} [id]              Row id once stored.
 * @property {number} ts                When we fetched it (epoch ms).
 * @property {string} source            Provider id, e.g. "geckoterminal".
 * @property {string} poolAddress       DEX pool address (what we track).
 * @property {string} tokenAddress      Base token mint address.
 * @property {string} symbol
 * @property {string} name
 * @property {string|null} dex
 * @property {number|null} trendingRank 1-based rank in the trending list, null if fetched for another reason.
 * @property {number} priceUsd
 * @property {number|null} marketCapUsd Often null for brand new tokens.
 * @property {number|null} fdvUsd
 * @property {number|null} liquidityUsd
 * @property {number|null} volM5
 * @property {number|null} volH1
 * @property {number|null} volH6
 * @property {number|null} volH24
 * @property {number|null} buysM5       Buy transactions in the last 5 minutes.
 * @property {number|null} sellsM5
 * @property {number|null} buyersM5     Unique buying wallets in the last 5 minutes.
 * @property {number|null} sellersM5
 * @property {number|null} buysH1
 * @property {number|null} sellsH1
 * @property {number|null} buyersH1
 * @property {number|null} sellersH1
 * @property {number|null} buysH24
 * @property {number|null} sellsH24
 * @property {number|null} priceChangeM5 Percent.
 * @property {number|null} priceChangeH1 Percent.
 * @property {number|null} poolCreatedAt Epoch ms. Used as token age.
 */

/**
 * What a signal module returns for one snapshot.
 *
 * @typedef {Object} SignalResult
 * @property {boolean} fired
 * @property {number} value   The measured quantity (ratio, multiple, ...), for display and later analysis.
 * @property {string} reason  Short human readable explanation.
 */

/**
 * Input handed to a signal module.
 *
 * @typedef {Object} SignalContext
 * @property {Snapshot} snapshot      Latest snapshot for this pool.
 * @property {Snapshot[]} history     Earlier snapshots of the same pool, oldest first (excludes `snapshot`).
 * @property {Record<string, number>} params  The module's params, merged with any overrides from config.
 */

/**
 * A pluggable signal. Each file in src/signals/ default-exports one of these.
 *
 * @typedef {Object} SignalModule
 * @property {string} id            Unique slug, also the strategy name for its paper trades.
 * @property {string} name          Display name.
 * @property {string} description   One or two sentences shown in the UI.
 * @property {Record<string, number>} params  Default thresholds.
 * @property {(ctx: SignalContext) => SignalResult} evaluate
 */

/**
 * A stored signal firing.
 *
 * @typedef {Object} SignalEvent
 * @property {number} [id]
 * @property {string} signalId
 * @property {number} snapshotId
 * @property {string} poolAddress
 * @property {string} symbol
 * @property {number} ts
 * @property {number} value
 * @property {string} reason
 * @property {number|null} tradeId   Trade opened because of it, null if skipped (cooldown, no cash, ...).
 * @property {string|null} skipReason
 */

/**
 * @typedef {'open'|'closed'} TradeStatus
 * @typedef {'take_profit'|'stop_loss'|'time_limit'|'no_data'} ExitReason
 */

/**
 * A simulated position. Nothing here ever touches a wallet or a real order.
 *
 * @typedef {Object} PaperTrade
 * @property {number} [id]
 * @property {string} strategy          Signal id, or "random" for control trades.
 * @property {string} book              Which $1,000 bankroll pays for it: the signal id, or "random:<signal id>".
 *                                      Each signal has its own random twin so cash limits hit both sides equally.
 * @property {number|null} matchedTradeId For random control trades: the signal trade that triggered it.
 * @property {number|null} signalEventId
 * @property {string} poolAddress
 * @property {string} tokenAddress
 * @property {string} symbol
 * @property {TradeStatus} status
 * @property {number} sizeUsd           Cash committed, fees included.
 * @property {number} feeRate           Per side, e.g. 0.003.
 * @property {number} slippageRate      Per side, e.g. 0.015.
 * @property {number} stopLossPct       e.g. 0.20 means close at -20% price move.
 * @property {number} takeProfitPct     e.g. 0.40 means close at +40% price move.
 * @property {number} timeLimitMs
 * @property {number} openedAt
 * @property {number} entrySnapshotId
 * @property {number} entryPrice        Observed mid price at entry.
 * @property {number} entryFillPrice    Entry price after slippage.
 * @property {number} quantity          Tokens "bought".
 * @property {number|null} closedAt
 * @property {number|null} exitSnapshotId
 * @property {number|null} exitPrice
 * @property {number|null} exitFillPrice
 * @property {ExitReason|null} exitReason
 * @property {number|null} proceedsUsd  Cash back after slippage and fee.
 * @property {number|null} pnlUsd
 * @property {number|null} pnlPct       pnlUsd / sizeUsd.
 * @property {number|null} aiProbability Model's probability (0..1) that this trade closes with a profit after costs.
 * @property {string|null} aiModel
 * @property {string|null} aiRationale
 */

/**
 * @typedef {Object} TradeRules
 * @property {number} sizeUsd
 * @property {number} feeRate
 * @property {number} slippageRate
 * @property {number} stopLossPct
 * @property {number} takeProfitPct
 * @property {number} timeLimitMin
 * @property {number} reentryCooldownMin  Wait this long after a trade on a token closes before the same strategy trades it again.
 * @property {number} staleAfterMin       If a pool has had no fresh data for this long when a trade must close, mark the exit "no_data".
 */

export {};
