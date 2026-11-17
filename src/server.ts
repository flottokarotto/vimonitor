import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Viessmann } from './viessmann.ts';
import { Collector } from './collector.ts';
import { createApp } from './app.ts';
import { logger } from './logger.ts';

const config = loadConfig();
const store = new Store(config.dataDir, config.demo);
const api = new Viessmann(config, store);
const collector = new Collector(config, store, api);
const app = createApp(config, store, api, collector);
const server = app.listen(config.port, '127.0.0.1', () => {
  logger.success(`ViMonitor gestartet · http://localhost:${config.port} · ${config.demo ? 'Demo-Modus (synthetische Daten)' : 'Viessmann-API'} · Abfrageintervall ${config.pollSeconds}s`);
  void collector.start();
});
server.on('error', error => {
  logger.error(`Serverstart fehlgeschlagen: ${error.message}`);
  collector.stop();
  store.close();
  process.exitCode = 1;
});

function shutdown() {
  logger.info('Beende ViMonitor und warte auf laufende Messabfrage …');
  collector.stop();
  server.close(() => {
    void collector.waitForIdle().then(() => {
      store.close();
      logger.success('ViMonitor sauber beendet.');
      process.exitCode = 0;
    });
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
