// @ts-check
// Entry point. Paper trading only: there is no wallet, key handling or order
// execution anywhere in this codebase.
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { loadSignals } from './engine/signal-loader.js';
import { createGeckoTerminal } from './providers/geckoterminal.js';
import { createSimulated } from './providers/simulated.js';
import { disabledScorer, createClaudeScorer } from './ai/scorer.js';
import { App } from './app.js';
import { createServer } from './server.js';

const config = loadConfig();
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  throw new Error(`Refusing to bind to ${config.host}: this dashboard is localhost only.`);
}

const store = new Store(config.dbPath);
const signals = await loadSignals(config.signalParams);
const provider =
  config.provider === 'simulated'
    ? createSimulated()
    : createGeckoTerminal({
        maxCallsPerMinute: config.maxCallsPerMinute,
        trendingPages: config.trendingPages,
        trendingDuration: config.trendingDuration,
      });
const scorer = config.ai.enabled ? await createClaudeScorer(config.ai) : disabledScorer;

const app = new App({ store, provider, signals, config, scorer });
const server = createServer({ store, config, signals, provider, app, aiEnabled: scorer.enabled });

server.listen(config.port, config.host, () => {
  console.log(`Paper lab on http://localhost:${config.port}  (data: ${provider.id}, db: ${config.dbPath})`);
  console.log(`Signals: ${signals.map((s) => s.id).join(', ')}. AI scoring: ${scorer.enabled ? 'on' : 'off'}.`);
  app.start();
});

const shutdown = () => {
  app.stop();
  server.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
