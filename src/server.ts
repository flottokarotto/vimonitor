import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Viessmann } from './viessmann.ts';
import { Collector } from './collector.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const store = new Store(config.dataDir, config.demo);
const api = new Viessmann(config, store);
const collector = new Collector(config, store, api);
const app = createApp(config, store, api, collector);
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`ViMonitor: http://localhost:${config.port} (${config.demo ? 'DEMO: synthetische Daten' : 'Viessmann-API'})`);
  void collector.start();
});
server.on('error', error => {
  console.error(`Serverstart fehlgeschlagen: ${error.message}`);
  collector.stop();
  store.close();
  process.exitCode = 1;
});

function shutdown() {
  collector.stop();
  server.close(() => {
    if (!collector.running) store.close();
    process.exitCode = 0;
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
