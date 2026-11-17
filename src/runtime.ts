import type { Server } from 'node:http';
import type { Config } from './config.ts';
import { Store } from './store.ts';
import { Viessmann } from './viessmann.ts';
import { Collector } from './collector.ts';
import { createApp } from './app.ts';
import { logger } from './logger.ts';

export function createRuntime(config: Config) {
  const store = new Store(config.dataDir, config.demo);
  const api = new Viessmann(config, store);
  const collector = new Collector(config, store, api);
  const app = createApp(config, store, api, collector);
  let server: Server | undefined;
  let closing: Promise<void> | undefined;
  let storeClosed = false;
  const closeStore = () => {
    if (storeClosed) return;
    store.close();
    storeClosed = true;
  };

  function listen(): Promise<Server> {
    if (server) return Promise.resolve(server);
    return new Promise((resolve, reject) => {
      const current = app.listen(config.port, '127.0.0.1');
      server = current;
      let listening = false;
      const failedToStart = (error: Error) => {
        logger.error(`Serverstart fehlgeschlagen: ${error.message}`);
        if (!listening) {
          closeStore();
          reject(error);
        }
      };
      current.on('error', failedToStart);
      current.once('listening', () => {
        listening = true;
        logger.success(`ViMonitor gestartet · http://localhost:${config.port} · ${config.demo ? 'Demo-Modus (synthetische Daten)' : 'Viessmann-API'} · Abfrageintervall ${config.pollSeconds}s`);
        void collector.start();
        resolve(current);
      });
    });
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      collector.stop();
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server?.close(error => error ? reject(error) : resolve());
        });
      }
      await collector.waitForIdle();
      closeStore();
      logger.success('ViMonitor sauber beendet.');
    })();
    return closing;
  }

  return { app, collector, listen, close };
}
