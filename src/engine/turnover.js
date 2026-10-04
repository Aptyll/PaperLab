// @ts-check
// Turnover: how much of a coin's value changed hands in the last hour
// (1h volume divided by market cap), whether that is speeding up or slowing
// down, and what the price did meanwhile. Noah's reading of the three together:
//
//   high and rising with price   -> attention: new buyers are absorbing sellers
//   high with flat or falling price -> distribution: early holders selling into the hype
//   falling while price holds    -> fading: attention leaving, price usually follows
//
// The cut-offs below are first guesses, not measured. replayTurnover() checks
// them against what prices did afterwards in Paper Lab's own saved readings.

/** @typedef {import('../types.js').Snapshot} Snapshot */
/** @typedef {'attention'|'distribution'|'fading'} TurnoverLabel */

export const TURNOVER = {
  /** "High": at least this share of the coin's value traded in the last hour. */
  high: 0.25,
  /** The last hour's pace against the pool's 6-hour average pace: above this is rising, below `falling` is falling. */
  rising: 1.25,
  falling: 0.75,
  /** Price moved less than this over the hour (either way) counts as flat. */
  flatPrice: 0.05,
  /** Replay: how long after a reading to look at the price, and how far either side of that a reading may be. */
  afterMin: 60,
  slackMin: 10,
  /** Replay: a coin counts once per label within this long, so a coin labelled every minute isn't counted 60 times. */
  spacingMin: 30,
};

/**
 * @typedef {Object} TurnoverRead
 * @property {number|null} turnover  1h volume / market cap (FDV when the cap is missing).
 * @property {number|null} pace      The last hour's volume against the average hour of the last 6 (or of the pool's life, if younger).
 * @property {number|null} priceH1   Price change over the last hour, as a fraction.
 * @property {TurnoverLabel|null} label
 */

/**
 * @param {Snapshot} s
 * @returns {TurnoverRead}
 */
export function readTurnover(s) {
  const cap = s.marketCapUsd !== null && s.marketCapUsd > 0 ? s.marketCapUsd : s.fdvUsd !== null && s.fdvUsd > 0 ? s.fdvUsd : null;
  const turnover = cap !== null && s.volH1 !== null ? s.volH1 / cap : null;
  // A pool younger than 6 hours has less than 6 hours of volume in its 6h figure.
  const hours = s.poolCreatedAt !== null ? Math.min(6, Math.max(1, (s.ts - s.poolCreatedAt) / 3600_000)) : 6;
  const pace = s.volH1 !== null && s.volH6 !== null && s.volH6 > 0 && hours > 1 ? s.volH1 / (s.volH6 / hours) : null;
  const priceH1 = s.priceChangeH1 !== null ? s.priceChangeH1 / 100 : null;
  return { turnover, pace, priceH1, label: labelOf(turnover, pace, priceH1) };
}

/**
 * @param {number|null} turnover
 * @param {number|null} pace
 * @param {number|null} priceH1
 * @returns {TurnoverLabel|null}
 */
export function labelOf(turnover, pace, priceH1) {
  if (turnover === null || pace === null || priceH1 === null) return null;
  const T = TURNOVER;
  // Falling attention is checked first: a high but shrinking turnover with a steady price is fading, not distribution.
  if (pace <= T.falling && priceH1 > -T.flatPrice) return 'fading';
  if (turnover < T.high) return null;
  if (priceH1 >= T.flatPrice && pace >= 1) return 'attention';
  if (priceH1 < T.flatPrice) return 'distribution';
  return null;
}

/**
 * @typedef {Object} ReplayRow
 * @property {TurnoverLabel|'all'} label  'all' is every reading with a turnover, for comparison.
 * @property {number} readings  Readings counted (spaced out per coin).
 * @property {number} coins     Different coins among them.
 * @property {number} up        Readings where the price was higher an hour later.
 * @property {number|null} medianMove  Median price change an hour later.
 */

/**
 * Lifecycle replay for turnover: for every saved reading that got a label,
 * what the price did about an hour later. Readings without a price an hour
 * later (Paper Lab was off, the coin left the list) are skipped.
 *
 * @param {(each: (pool: string, rows: Snapshot[]) => void) => void} eachPool  Calls back with each pool's trusted readings, oldest first.
 * @returns {ReplayRow[]}
 */
export function replayTurnover(eachPool) {
  const T = TURNOVER;
  /** @type {Record<string, {moves: number[], coins: Set<string>}>} */
  const acc = {};
  const add = (/** @type {string} */ label, /** @type {string} */ pool, /** @type {number} */ move) => {
    const a = (acc[label] ??= { moves: [], coins: new Set() });
    a.moves.push(move);
    a.coins.add(pool);
  };
  eachPool((pool, rows) => {
    /** @type {Record<string, number>} */
    const lastCounted = {};
    let j = 0;
    for (const s of rows) {
      const r = readTurnover(s);
      if (r.turnover === null) continue;
      const target = s.ts + T.afterMin * 60_000;
      while (j < rows.length && rows[j].ts < target - T.slackMin * 60_000) j++;
      // The first reading at or after the target, within the slack.
      let k = j;
      while (k < rows.length && rows[k].ts < target) k++;
      const later = rows[k] ?? null;
      if (!later || later.ts > target + T.slackMin * 60_000) continue;
      const move = later.priceUsd / s.priceUsd - 1;
      for (const label of r.label ? ['all', r.label] : ['all']) {
        if (s.ts - (lastCounted[label] ?? -Infinity) < T.spacingMin * 60_000) continue;
        lastCounted[label] = s.ts;
        add(label, pool, move);
      }
    }
  });
  return /** @type {const} */ (['attention', 'distribution', 'fading', 'all']).map((label) => {
    const a = acc[label];
    if (!a) return { label, readings: 0, coins: 0, up: 0, medianMove: null };
    const sorted = a.moves.slice().sort((x, y) => x - y);
    const mid = sorted.length >> 1;
    return {
      label,
      readings: sorted.length,
      coins: a.coins.size,
      up: a.moves.filter((m) => m > 0).length,
      medianMove: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    };
  });
}
