// @ts-check
// Price sanity: a single bad reading from the data source (a glitch, a stale
// cache, a bad tick) must not open, close or value a trade.
//
// A price that moved 2x or more, either way, since the pool's last trusted
// reading is only believed when the rest of the reading moved with it:
//   - Liquidity. In a pool, price moves when people swap, and that changes
//     what the pool holds: a constant-product pool's dollar liquidity moves
//     with the square root of the price. So 4x the price comes with roughly 2x
//     the liquidity; a 4x price on unchanged liquidity can't be a real swap.
//     We ask for at least half that move (4x price: liquidity up 1.41x or more).
//   - FDV, when given. FDV is price times supply and supply doesn't change, so
//     the two move together; we allow 25% of drift.
// A reading that fails is flagged. Trades don't fill, exit, fire or get
// valued on it, and a trade that already did (before this guard existed) is
// left out of results and shown as such. Nothing is deleted or rewritten.
// After 30 minutes without a trusted reading, the next reading is trusted
// again: by then the price may really have moved.

/** @typedef {import('../types.js').Snapshot} Snapshot */
/** @typedef {Pick<Snapshot, 'ts'|'priceUsd'|'fdvUsd'|'liquidityUsd'>} Reading */

export const SANITY = {
  /** A move this big (up or down) since the last trusted reading must be backed by liquidity and FDV. */
  bigMove: 2,
  /** Share of the expected liquidity move (in log terms) that must show. */
  liquidityShare: 0.5,
  /** How far price/FDV may drift across a big move. */
  fdvTolerance: 1.25,
  /** Readings further apart than this aren't compared. */
  lookbackMs: 30 * 60_000,
};

/** @param {number} x */
const times = (x) => (x >= 1 ? `${+x.toFixed(2)}x` : `1/${+(1 / x).toFixed(1)}`);
/** @param {number} ms */
const span = (ms) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);

/**
 * Why this reading can't be trusted, or null if it can.
 * @param {Reading} s
 * @param {Reading|null} trusted  The pool's last trusted reading before it.
 * @returns {string|null}
 */
export function suspectPrice(s, trusted) {
  if (!(s.priceUsd > 0)) return 'no price';
  if (!trusted || !(trusted.priceUsd > 0) || s.ts - trusted.ts > SANITY.lookbackMs) return null;
  const move = s.priceUsd / trusted.priceUsd;
  if (move < SANITY.bigMove && move > 1 / SANITY.bigMove) return null;
  const why = [];
  if (s.liquidityUsd && trusted.liquidityUsd) {
    const liq = s.liquidityUsd / trusted.liquidityUsd;
    // Expected log move is half the price's (square root); ask for a share of it, in the same direction.
    const need = Math.log(move) * 0.5 * SANITY.liquidityShare;
    if (move > 1 ? Math.log(liq) < need : Math.log(liq) > need) why.push(`liquidity ${times(liq)}`);
  }
  if (s.fdvUsd && trusted.fdvUsd) {
    const fdv = s.fdvUsd / trusted.fdvUsd;
    const drift = move / fdv;
    if (drift > SANITY.fdvTolerance || drift < 1 / SANITY.fdvTolerance) why.push(`FDV ${times(fdv)}`);
  }
  return why.length ? `price ${times(move)} in ${span(s.ts - trusted.ts)} but ${why.join(' and ')}` : null;
}

/**
 * Flags for one pool's readings: snapshot id to reason.
 * @template {Reading & {id?: number}} R
 * @param {R[]} readings  One pool, oldest first.
 * @param {Reading|null} [before]  Last trusted reading before these, if any.
 * @returns {Map<number, string>}
 */
export function flagReadings(readings, before = null) {
  /** @type {Map<number, string>} */
  const flags = new Map();
  let trusted = before;
  for (const s of readings) {
    const why = suspectPrice(s, trusted);
    if (!why) trusted = s;
    else if (s.id !== undefined) flags.set(s.id, why);
  }
  return flags;
}

/**
 * Check every saved reading once, oldest first per pool, and flag the ones
 * this check doesn't trust. Covers data saved before the check existed.
 * @param {import('../db.js').Store} store
 * @param {number} now
 * @returns {number} Readings flagged (new or already).
 */
export function checkSavedPrices(store, now) {
  /** @type {Map<number, string>} */
  const all = new Map();
  store.eachPoolReadings((_pool, readings) => {
    for (const [id, why] of flagReadings(readings)) all.set(id, why);
  });
  if (all.size) store.flagSnapshots(all, now);
  return all.size;
}
