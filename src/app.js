// @ts-check
import { EventEmitter } from 'node:events';
import { runCycle } from './engine/cycle.js';

/** @typedef {import('./types.js').PaperTrade} PaperTrade */

/**
 * The polling loop plus background AI scoring. Emits "cycle" after each poll.
 */
export class App extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {import('./db.js').Store} deps.store
   * @param {import('./providers/provider.js').MarketProvider} deps.provider
   * @param {import('./types.js').SignalModule[]} deps.signals
   * @param {import('./config.js').Config} deps.config
   * @param {import('./ai/scorer.js').Scorer} deps.scorer
   * @param {(msg: string) => void} [deps.log]
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.log = deps.log ?? ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    this.running = false;
    /** @type {{ts: number, ok: boolean, error: string|null, snapshots: number, opened: number, closed: number}|null} */
    this.lastCycle = null;
    /** @type {Promise<void>} */
    this.scoring = Promise.resolve();
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    const started = Date.now();
    try {
      const r = await runCycle({ ...this.deps, log: this.log });
      this.lastCycle = {
        ts: started,
        ok: r.ok,
        error: r.error,
        snapshots: r.snapshots,
        opened: r.opened.length,
        closed: r.closed.length,
      };
      this.log(
        `poll ${r.ok ? 'ok' : 'FAILED'}: ${r.snapshots} snapshots, ${r.signalEvents} signal fires, ` +
          `${r.opened.length} opened, ${r.closed.length} closed${r.error ? ` (${r.error})` : ''}`,
      );
      if (this.deps.scorer.enabled) for (const t of r.opened) this.queueScore(t);
    } catch (err) {
      this.log(`cycle crashed: ${err instanceof Error ? err.stack : err}`);
      this.lastCycle = { ts: started, ok: false, error: String(err), snapshots: 0, opened: 0, closed: 0 };
    }
    this.emit('cycle', this.lastCycle);
    if (!this.running) return;
    const wait = Math.max(1000, this.deps.config.pollIntervalSec * 1000 - (Date.now() - started));
    this.timer = setTimeout(() => void this.tick(), wait);
  }

  /** Score trades one at a time so a slow model never blocks polling. @param {PaperTrade} trade */
  queueScore(trade) {
    const { store, scorer } = this.deps;
    this.scoring = this.scoring.then(async () => {
      try {
        const snap = store.snapshotById(trade.entrySnapshotId);
        if (!snap || trade.id === undefined) return;
        const history = store.poolHistory(trade.poolAddress, { beforeId: snap.id, limit: 30 });
        const score = await scorer.score(trade, snap, history);
        if (score) store.setAiScore(trade.id, score);
      } catch (err) {
        this.log(`AI scoring failed for trade ${trade.id}: ${err instanceof Error ? err.message : err}`);
      }
    });
  }
}
