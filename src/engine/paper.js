// @ts-check
// Paper trade math. Pure functions: no I/O, no wallets, no orders.
//
// How a paper trade is priced, to stay close to what a real swap would get:
//   - A signal creates a *pending* trade. It fills at the next poll's price,
//     the way a person copying the signal by hand would buy a minute later.
//     If the price has run up more than maxChasePct by then, it is cancelled.
//   - Every fill pays the DEX fee, a flat execution slippage (delay, bots),
//     and price impact from the pool's depth: buying $50 from a $100K pool
//     moves the price far less than from a $20K pool.
//   - If the pool loses most of its liquidity while held, the trade exits as
//     "collapsed" and sells into what is left, which is usually a near-total loss.

/** @typedef {import('../types.js').PaperTrade} PaperTrade */
/** @typedef {import('../types.js').Snapshot} Snapshot */
/** @typedef {import('../types.js').TradeRules} TradeRules */
/** @typedef {import('../types.js').ExitReason} ExitReason */
/** @typedef {import('../types.js').CancelReason} CancelReason */

/**
 * Price impact of a swap of `amountUsd` against a constant-product pool with
 * `liquidityUsd` total liquidity (half of it on the quote side).
 * Returns the fractional price move against you: 0.01 means 1% worse.
 *
 * Buying: average price = mid * (R + a) / R, so impact = a / R.
 * Selling: average price = mid * R / (R + v), so impact = v / (R + v).
 *
 * @param {'buy'|'sell'} side
 * @param {number} amountUsd
 * @param {number|null} liquidityUsd  Unknown liquidity means no impact can be estimated.
 */
export function priceImpact(side, amountUsd, liquidityUsd) {
  if (liquidityUsd === null || !(liquidityUsd > 0)) return 0;
  const quoteReserve = liquidityUsd / 2;
  return side === 'buy' ? amountUsd / quoteReserve : amountUsd / (quoteReserve + amountUsd);
}

/**
 * Create a pending trade when a signal (or its random twin) picks a token.
 *
 * @param {Object} a
 * @param {string} a.strategy
 * @param {string} [a.book]         Defaults to the strategy.
 * @param {Snapshot} a.snapshot     The snapshot the signal fired on. Must be stored (has id).
 * @param {TradeRules} a.rules
 * @param {number} a.now
 * @param {number|null} [a.signalEventId]
 * @param {number|null} [a.matchedTradeId]
 * @returns {PaperTrade}
 */
export function buildPendingTrade({ strategy, book = strategy, snapshot, rules, now, signalEventId = null, matchedTradeId = null }) {
  if (snapshot.id === undefined) throw new Error('snapshot must be stored before opening a trade');
  return {
    strategy,
    book,
    matchedTradeId,
    signalEventId,
    poolAddress: snapshot.poolAddress,
    tokenAddress: snapshot.tokenAddress,
    symbol: snapshot.symbol,
    status: 'pending',
    sizeUsd: rules.sizeUsd,
    feeRate: rules.feeRate,
    slippageRate: rules.slippageRate,
    stopLossPct: rules.stopLossPct,
    takeProfitPct: rules.takeProfitPct,
    timeLimitMs: rules.timeLimitMin * 60_000,
    signalAt: now,
    signalSnapshotId: snapshot.id,
    signalPrice: snapshot.priceUsd,
    cancelReason: null,
    openedAt: null,
    entrySnapshotId: null,
    entryPrice: null,
    entryFillPrice: null,
    entryLiquidityUsd: null,
    quantity: null,
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
 * Try to fill a pending trade at a fresh snapshot.
 * The fee comes out of the position size; the rest buys tokens at mid price
 * worsened by execution slippage and price impact.
 *
 * @param {PaperTrade} t
 * @param {Snapshot|null} fresh   This poll's snapshot of the pool, or null if none.
 * @param {number} maxChasePct
 * @param {number} now
 * @returns {PaperTrade}  Open, or cancelled.
 */
export function fillPending(t, fresh, maxChasePct, now) {
  if (!fresh || fresh.id === undefined) return { ...t, status: 'cancelled', cancelReason: 'no_data', closedAt: now };
  if (fresh.priceUsd > t.signalPrice * (1 + maxChasePct)) {
    return { ...t, status: 'cancelled', cancelReason: 'chased', closedAt: now };
  }
  const spend = t.sizeUsd * (1 - t.feeRate);
  const entryFillPrice = fresh.priceUsd * (1 + t.slippageRate) * (1 + priceImpact('buy', spend, fresh.liquidityUsd));
  return {
    ...t,
    status: 'open',
    openedAt: now,
    entrySnapshotId: fresh.id,
    entryPrice: fresh.priceUsd,
    entryFillPrice,
    entryLiquidityUsd: fresh.liquidityUsd,
    quantity: spend / entryFillPrice,
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
 * @param {number} collapseLiquidityRatio
 * @returns {ExitReason|null}
 */
export function exitReasonFor(t, latest, now, staleAfterMs, collapseLiquidityRatio) {
  if (t.status !== 'open' || t.openedAt === null || t.entryPrice === null) return null;
  const fresh = latest !== null && latest.ts > t.openedAt && now - latest.ts <= staleAfterMs;
  if (fresh && latest) {
    if (
      t.entryLiquidityUsd !== null &&
      latest.liquidityUsd !== null &&
      latest.liquidityUsd < t.entryLiquidityUsd * collapseLiquidityRatio
    ) {
      return 'collapsed';
    }
    const move = latest.priceUsd / t.entryPrice - 1;
    if (move <= -t.stopLossPct) return 'stop_loss';
    if (move >= t.takeProfitPct) return 'take_profit';
  }
  if (now - t.openedAt >= t.timeLimitMs) return fresh ? 'time_limit' : 'no_data';
  return null;
}

/**
 * Cash from selling the whole position at mid price `price` into a pool with
 * `liquidityUsd`, after execution slippage, price impact and the fee.
 * @param {PaperTrade} t
 * @param {number} price
 * @param {number|null} liquidityUsd
 */
export function liquidationValue(t, price, liquidityUsd) {
  const qty = t.quantity ?? 0;
  const markValue = qty * price;
  const exitFillPrice = price * (1 - t.slippageRate) * (1 - priceImpact('sell', markValue, liquidityUsd));
  const proceedsUsd = qty * exitFillPrice * (1 - t.feeRate);
  return { exitFillPrice, proceedsUsd };
}

/**
 * Close an open trade at the given price and pool depth.
 * @param {PaperTrade} t
 * @param {{price: number, liquidityUsd: number|null, snapshotId: number|null}} at
 * @param {ExitReason} reason
 * @param {number} now
 * @returns {PaperTrade}
 */
export function closeTrade(t, at, reason, now) {
  const { exitFillPrice, proceedsUsd } = liquidationValue(t, at.price, at.liquidityUsd);
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
 * Price move needed just to break even after both fees and both slippages,
 * ignoring price impact (which depends on the pool).
 * @param {Pick<TradeRules, 'feeRate'|'slippageRate'>} r
 */
export function breakevenMove(r) {
  return (1 + r.slippageRate) / ((1 - r.feeRate) * (1 - r.feeRate) * (1 - r.slippageRate)) - 1;
}
