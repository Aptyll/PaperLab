// @ts-check

/** @type {import('../types.js').SignalModule} */
export default {
  id: 'buyer-seller-ratio',
  name: 'Buyer/Seller Ratio',
  description:
    'Fires when unique buyers outnumber unique sellers by a wide margin over the last 5 minutes. ' +
    'Falls back to buy/sell transaction counts when wallet counts are missing.',
  params: {
    minRatio: 2.0, // buyers / sellers
    minBuyers: 15, // ignore thin activity
  },
  evaluate({ snapshot: s, params }) {
    const buyers = s.buyersM5 ?? s.buysM5;
    const sellers = s.sellersM5 ?? s.sellsM5;
    if (buyers === null || sellers === null) return { fired: false, value: 0, reason: 'no 5m buyer/seller data' };
    const ratio = buyers / Math.max(sellers, 1);
    const fired = buyers >= params.minBuyers && ratio >= params.minRatio;
    return { fired, value: ratio, reason: `${buyers} buyers vs ${sellers} sellers in 5m (ratio ${ratio.toFixed(2)})` };
  },
};
