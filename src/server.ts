import { loadConfig } from './config.ts';
import { logger } from './logger.ts';
import { createRuntime } from './runtime.ts';

const config = loadConfig();
const runtime = createRuntime(config);
void runtime.listen().catch(() => {
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Beende ViMonitor und warte auf laufende Messabfrage …');
  try {
    await runtime.close();
    process.exitCode = 0;
  } catch (error) {
    logger.error(`Sauberes Beenden fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
