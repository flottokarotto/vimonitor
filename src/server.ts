import { loadConfig } from './config.ts';
import { logger } from './logger.ts';
import { createRuntime } from './runtime.ts';
import { startTerminal } from './tui.ts';

const config = loadConfig();
const tuiEnabled = process.argv.includes('--tui');
if (tuiEnabled && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  logger.error('Die Terminaloberfläche benötigt ein interaktives Terminal.');
  process.exitCode = 1;
} else {
  const runtime = createRuntime(config);
  let shuttingDown = false;
  let terminal: { close(): void } | undefined;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Beende ViMonitor und warte auf laufende Messabfrage …');
    try {
      terminal?.close();
      await runtime.close();
      process.exitCode = 0;
    } catch (error) {
      logger.error(`Sauberes Beenden fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  void runtime.listen().then(async () => {
    if (tuiEnabled) terminal = await startTerminal(runtime, () => { void shutdown(); });
  }).catch(async error => {
    logger.error(`ViMonitor konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`);
    await shutdown();
    process.exitCode = 1;
  });
}
