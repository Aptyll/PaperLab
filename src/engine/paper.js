// @ts-check
// Paper trade math. Pure functions: no I/O, no wallets, no orders.

/** @typedef {import('../types.js').PaperTrade} PaperTrade */
/** @typedef {import('../types.js').Snapshot} Snapshot */
/** @typedef {import('../types.js').TradeRules} TradeRules */
/** @typedef {import('../types.js').ExitReason} ExitReason */

/**
 * Build a new open paper trade at the snapshot's price.
 * We "buy" at mid price plus slippage and pay the fee out of the position size.
 *
 * @param {Object} a
 * @param {string} a.strategy
 * @param {string} [a.book]         Defaults to the strategy.
 * @param {Snapshot} a.snapshot   Must already be stored (has id).
 * @param {TradeRules} a.rules
 * @param {number} a.now
 * @param {number|null} [a.signalEventId]
 * @param {number|null} [a.matchedTradeId]
 * @returns {PaperTrade}
 */
export function buildOpenTrade({ strategy, book = strategy, snapshot, rules, now, signalEventId = null, matchedTradeId = null }) {
  if (snapshot.id === undefined) throw new Error('snapshot must be stored before opening a trade');
  const entryFillPrice = snapshot.priceUsd * (1 + rules.slippageRate);
  const feeUsd = rules.sizeUsd * rules.feeRate;
  return {
    strategy,
    book,
    matchedTradeId,
    signalEventId,
    poolAddress: snapshot.poolAddress,
    tokenAddress: snapshot.tokenAddress,
    symbol: snapshot.symbol,
    status: 'open',
    sizeUsd: rules.sizeUsd,
    feeRate: rules.feeRate,
    slippageRate: rules.slippageRate,
    stopLossPct: rules.stopLossPct,
    takeProfitPct: rules.takeProfitPct,
    timeLimitMs: rules.timeLimitMin * 60_000,
    openedAt: now,
    entrySnapshotId: snapshot.id,
    entryPrice: snapshot.priceUsd,
    entryFillPrice,
    quantity: (rules.sizeUsd - feeUsd) / entryFillPrice,
    closedAt: null,
    exitSnapshotId: null,
    exitPrice: null,
    exitFillPrice: null,
    exitReason: null,
    proceedsUsd: null,
    pnlUsd: null,
    pnlPct: null,
    aiProbability: null,
    aiModel: null,
    aiRationale: null,
  };
}

/**
 * Decide whether an open trade should close.
 * Stop loss and take profit trigger on the observed mid price move from entry.
 * Because we poll, the price may have moved past the level; we fill at the
 * observed price, not the level, which is what a real market order would get.
 *
 * @param {PaperTrade} t
 * @param {Snapshot|null} latest   Most recent snapshot of the pool, if any.
 * @param {number} now
 * @param {number} staleAfterMs
 * @returns {ExitReason|null}
 */
export function exitReasonFor(t, latest, now, staleAfterMs) {
  const fresh = latest !== null && latest.ts > t.openedAt && now - latest.ts <= staleAfterMs;
  if (fresh && latest) {
    const move = latest.priceUsd / t.entryPrice - 1;
    if (move <= -t.stopLossPct) return 'stop_loss';
    if (move >= t.takeProfitPct) return 'take_profit';
  }
  if (now - t.openedAt >= t.timeLimitMs) return fresh ? 'time_limit' : 'no_data';
  return null;
}

/**
 * Value of selling `t.quantity` at mid price `price`, after slippage and fee.
 * @param {PaperTrade} t
 * @param {number} price
 */
export function liquidationValue(t, price) {
  const exitFillPrice = price * (1 - t.slippageRate);
  const proceedsUsd = t.quantity * exitFillPrice * (1 - t.feeRate);
  return { exitFillPrice, proceedsUsd };
}

/**
 * Close a trade at the given snapshot's price (or the last known price for no_data exits).
 * @param {PaperTrade} t
 * @param {{price: number, snapshotId: number|null}} at
 * @param {ExitReason} reason
 * @param {number} now
 * @returns {PaperTrade}
 */
export function closeTrade(t, at, reason, now) {
  const { exitFillPrice, proceedsUsd } = liquidationValue(t, at.price);
  const pnlUsd = proceedsUsd - t.sizeUsd;
  return {
    ...t,
    status: 'closed',
    closedAt: now,
    exitSnapshotId: at.snapshotId,
    exitPrice: at.price,
    exitFillPrice,
    exitReason: reason,
    proceedsUsd,
    pnlUsd,
    pnlPct: pnlUsd / t.sizeUsd,
  };
}

/**
 * Price move needed just to break even after both fees and both slippages.
 * @param {TradeRules} r
 */
export function breakevenMove(r) {
  return 1 / ((1 - r.feeRate) * (1 - r.feeRate) * ((1 - r.slippageRate) / (1 + r.slippageRate))) - 1;
}
