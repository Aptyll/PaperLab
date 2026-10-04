// @ts-check
// Optional AI scoring. Off by default. When enabled, each newly opened paper
// trade (signal and random alike) gets a probability estimate stored with it,
// so the Results view can check calibration later.
//
// Turning it on costs money per call. To enable:
//   1. npm install            (installs the optional @anthropic-ai/sdk package)
//   2. export ANTHROPIC_API_KEY=...
//   3. set "ai": { "enabled": true } in config.local.json

/** @typedef {import('../types.js').Snapshot} Snapshot */
/** @typedef {import('../types.js').PaperTrade} PaperTrade */

/**
 * @typedef {Object} AiScore
 * @property {number} probability  0..1
 * @property {string} rationale
 * @property {string} model
 */

/**
 * @typedef {Object} Scorer
 * @property {boolean} enabled
 * @property {(trade: PaperTrade, snapshot: Snapshot, history: Snapshot[]) => Promise<AiScore|null>} score
 */

/** @type {Scorer} */
export const disabledScorer = { enabled: false, score: async () => null };

/**
 * Compact, model-friendly description of the trade and its recent market data.
 * Exported for tests and so the prompt is easy to inspect.
 *
 * @param {PaperTrade} trade
 * @param {Snapshot} s
 * @param {Snapshot[]} history
 */
export function buildPrompt(trade, s, history) {
  const ageMin = s.poolCreatedAt ? Math.round((s.ts - s.poolCreatedAt) / 60_000) : null;
  const recent = history.slice(-12).map((h) => ({
    minutesAgo: Math.round((s.ts - h.ts) / 60_000),
    priceUsd: h.priceUsd,
    liquidityUsd: h.liquidityUsd,
    volM5: h.volM5,
    buyersM5: h.buyersM5,
    sellersM5: h.sellersM5,
  }));
  const data = {
    token: s.symbol,
    tokenAgeMinutes: ageMin,
    priceUsd: s.priceUsd,
    marketCapUsd: s.marketCapUsd,
    fdvUsd: s.fdvUsd,
    liquidityUsd: s.liquidityUsd,
    volumeUsd: { m5: s.volM5, h1: s.volH1, h6: s.volH6, h24: s.volH24 },
    txns5m: { buys: s.buysM5, sells: s.sellsM5, buyers: s.buyersM5, sellers: s.sellersM5 },
    txns1h: { buys: s.buysH1, sells: s.sellsH1, buyers: s.buyersH1, sellers: s.sellersH1 },
    priceChangePct: { m5: s.priceChangeM5, h1: s.priceChangeH1 },
    recentSnapshots: recent,
  };
  const rules =
    `A simulated long position was just opened at the current price. ` +
    `Entry costs ${(trade.slippageRate * 100).toFixed(1)}% slippage and ${(trade.feeRate * 100).toFixed(1)}% fee; ` +
    `exit costs the same. It closes at the first of: price down ${(trade.stopLossPct * 100).toFixed(0)}% ` +
    `(stop loss), price up ${(trade.takeProfitPct * 100).toFixed(0)}% (take profit), or ` +
    `${Math.round(trade.timeLimitMs / 60_000)} minutes elapsed.`;
  return (
    `${rules}\n\nEstimate the probability that this trade closes with a profit after all costs. ` +
    `Most such trades on new Solana memecoins lose money, so be calibrated rather than optimistic. ` +
    `Market data (JSON):\n${JSON.stringify(data)}`
  );
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    probability: { type: 'number', description: 'Probability from 0 to 1.' },
    rationale: { type: 'string', description: 'One or two sentences.' },
  },
  required: ['probability', 'rationale'],
  additionalProperties: false,
};

/**
 * @param {{model: string, effort: 'low'|'medium'|'high'}} cfg
 * @returns {Promise<Scorer>}
 */
export async function createClaudeScorer(cfg) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('AI scoring is enabled but ANTHROPIC_API_KEY is not set.');
  }
  /** @type {any} */
  let sdk;
  try {
    sdk = await import('@anthropic-ai/sdk');
  } catch {
    throw new Error('AI scoring is enabled but @anthropic-ai/sdk is not installed. Run: npm install');
  }
  const Anthropic = sdk.default;
  const client = new Anthropic();

  return {
    enabled: true,
    async score(trade, snapshot, history) {
      const response = await client.beta.messages.create({
        model: cfg.model,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: cfg.effort,
          format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
        },
        messages: [{ role: 'user', content: buildPrompt(trade, snapshot, history) }],
      });
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
      const text = response.content
        .filter((/** @type {any} */ b) => b.type === 'text')
        .map((/** @type {any} */ b) => b.text)
        .join('');
      const parsed = JSON.parse(text);
      const p = Number(parsed.probability);
      if (!Number.isFinite(p)) return null;
      return {
        probability: Math.min(1, Math.max(0, p)),
        rationale: String(parsed.rationale ?? '').slice(0, 500),
        model: response.model ?? cfg.model,
      };
    },
  };
}
