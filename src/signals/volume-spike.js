// @ts-check

/** @type {import('../types.js').SignalModule} */
export default {
  id: 'volume-spike',
  name: 'Volume Spike',
  description:
    'Fires when the last 5 minutes of volume is several times the average 5-minute volume of the rest of the hour. ' +
    'It does not look at direction, so it can fire on sell-offs too.',
  params: {
    minMultiple: 3, // last 5m volume / average 5m volume over the previous 55m
    minVolM5: 5000, // USD, ignore tiny absolute volume
  },
  evaluate({ snapshot: s, params }) {
    if (s.volM5 === null || s.volH1 === null) return { fired: false, value: 0, reason: 'no volume data' };
    const baseline = Math.max(s.volH1 - s.volM5, 0) / 11;
    if (baseline <= 0) return { fired: false, value: 0, reason: 'no earlier volume in the hour to compare against' };
    const multiple = s.volM5 / baseline;
    const fired = s.volM5 >= params.minVolM5 && multiple >= params.minMultiple;
    return {
      fired,
      value: multiple,
      reason: `5m volume $${Math.round(s.volM5)} is ${multiple.toFixed(1)}x the hour's 5m average`,
    };
  },
};
