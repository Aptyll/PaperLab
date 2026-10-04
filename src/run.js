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
import { runSettings } from './engine/runs.js';
import { resolveStrategies } from './engine/strategies.js';
import strategyDefs from './strategies.js';
import { createServer } from './server.js';
import { checkSavedPrices } from './engine/sanity.js';

const config = loadConfig();
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  throw new Error(`Refusing to bind to ${config.host}: this dashboard is localhost only.`);
}

const store = new Store(config.dbPath);
const signals = await loadSignals(config.signalParams);
const strategies = resolveStrategies(strategyDefs, signals, config.trade);
const provider =
  config.provider === 'simulated'
    ? createSimulated()
    : createGeckoTerminal({
        maxCallsPerMinute: config.maxCallsPerMinute,
        trendingPages: config.trendingPages,
        trendingDuration: config.trendingDuration,
      });
if (store.backupPath) console.log(`Upgraded the database to the new format. A full copy of the old one is at ${store.backupPath}`);
for (const i of store.imported) {
  console.log(i.error ? `Could not merge ${i.file}: ${i.error}` : `Merged earlier results from ${i.file} as a past run.`);
}
// Readings saved before the price sanity check existed get checked once too.
const held = checkSavedPrices(store, Date.now());
if (held) console.log(`Price check: ${held} saved price reading${held === 1 ? '' : 's'} held back as unreliable; trades made on them are left out of results.`);
// Same rules as last time: keep adding to that run. Different rules: start a new one.
const runId = store.beginRun(runSettings(config, strategies), Date.now());
if (store.rejoined) console.log(`Joined a paper run that an earlier update had split in two. Copy saved first: ${store.backupPath}`);
const scorer = config.ai.enabled ? await createClaudeScorer(config.ai) : disabledScorer;

const app = new App({ store, provider, strategies, config, scorer, runId });
let shutdown = () => {};
const server = createServer({ store, config, signals, strategies, provider, app, aiEnabled: scorer.enabled, runId, onQuit: () => shutdown() });

server.listen(config.port, config.host, () => {
  console.log(`Paper lab on http://localhost:${config.port}  (data: ${provider.id}, db: ${config.dbPath})`);
  console.log(`Strategies: ${strategies.filter((s) => !s.retired).map((s) => s.codeName).join(', ')}. AI scoring: ${scorer.enabled ? 'on' : 'off'}.`);
  if (config.startLive) app.start();
  else console.log('Live data is off. Press "Turn On Live Data" on the page to start.');
});

// Stop polling, let a poll in progress finish writing, then exit.
shutdown = () => {
  void app.stop().finally(() => {
    server.close();
    store.close();
    console.log('Paper Lab stopped.');
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
