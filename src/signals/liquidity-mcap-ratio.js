// @ts-check

/** @type {import('../types.js').SignalModule} */
export default {
  id: 'liquidity-mcap-ratio',
  name: 'Liquidity / Market Cap',
  description:
    'Fires when pool liquidity is large relative to market cap (FDV when market cap is missing). ' +
    'The idea: deeper liquidity means a token is harder to dump on you and its price is less fragile.',
  params: {
    minRatio: 0.15, // liquidity / market cap
    minLiquidityUsd: 10000,
  },
  evaluate({ snapshot: s, params }) {
    const cap = s.marketCapUsd ?? s.fdvUsd;
    if (s.liquidityUsd === null || cap === null || cap <= 0) return { fired: false, value: 0, reason: 'no liquidity or cap data' };
    const ratio = s.liquidityUsd / cap;
    const fired = s.liquidityUsd >= params.minLiquidityUsd && ratio >= params.minRatio;
    const capLabel = s.marketCapUsd === null ? 'FDV' : 'market cap';
    return { fired, value: ratio, reason: `liquidity is ${(ratio * 100).toFixed(1)}% of ${capLabel}` };
  },
};
