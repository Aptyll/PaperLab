// @ts-check
// The strategies ("bots") that paper-trade side by side. Each one is a name, one
// rule (a file in src/signals/), and optionally its own rule settings and exits.
// Anything left out uses the defaults in config.js.
//
// Every strategy gets its own pretend $1,000 and its own random picker that
// trades with the same exits, so each comparison stays fair.
//
// Settings are fixed per id: to try different settings, add a new bot with a
// new id and the next number. To stop one, set `retired: true` (it stops
// buying, its open trades finish, and its history stays). Never reuse or edit
// an id that has trades. Names are only for show; trades are stored by id.

/** @type {import('./types.js').StrategyDef[]} */
export default [
  // The original three. Their ids match the rule ids, so earlier trades stay with them.
  { id: 'buyer-seller-ratio', codeName: 'Bot 1', formerly: 'Falcon', signal: 'buyer-seller-ratio' },
  { id: 'liquidity-mcap-ratio', codeName: 'Bot 2', formerly: 'Badger', signal: 'liquidity-mcap-ratio' },
  { id: 'volume-spike', codeName: 'Bot 3', formerly: 'Cobra', signal: 'volume-spike' },

  // Faster versions: tighter exits, so trades finish sooner.
  { id: 'hawk', codeName: 'Bot 4', formerly: 'Hawk', signal: 'buyer-seller-ratio', exits: { stopLossPct: 0.1, takeProfitPct: 0.2, timeLimitMin: 20 } },
  { id: 'otter', codeName: 'Bot 5', formerly: 'Otter', signal: 'liquidity-mcap-ratio', exits: { stopLossPct: 0.1, takeProfitPct: 0.2, timeLimitMin: 20 } },
  { id: 'viper', codeName: 'Bot 6', formerly: 'Viper', signal: 'volume-spike', exits: { stopLossPct: 0.1, takeProfitPct: 0.2, timeLimitMin: 20 } },

  // Bigger and slower: $250 a trade, a wider stop, a higher target and a longer
  // hold, to see whether letting trades run pays for the bigger swings.
  { id: 'eagle', codeName: 'Bot 7', formerly: 'Eagle', signal: 'buyer-seller-ratio', exits: { sizeUsd: 250, stopLossPct: 0.25, takeProfitPct: 0.6, timeLimitMin: 120 } },
  { id: 'bison', codeName: 'Bot 8', formerly: 'Bison', signal: 'liquidity-mcap-ratio', exits: { sizeUsd: 250, stopLossPct: 0.25, takeProfitPct: 0.6, timeLimitMin: 120 } },
  { id: 'mamba', codeName: 'Bot 9', formerly: 'Mamba', signal: 'volume-spike', exits: { sizeUsd: 250, stopLossPct: 0.25, takeProfitPct: 0.6, timeLimitMin: 120 } },

  // Bot 1 (Falcon), but it skips copycats: a coin whose ticker another token was
  // already trading under. Both rug pulls on 2026-10-04 were copycat "HIGGS"
  // pools. Same rule and exits as Bot 1, so the two compare directly.
  { id: 'kestrel', codeName: 'Bot 10', formerly: 'Kestrel', signal: 'buyer-seller-ratio', skipCopycats: true },
];
