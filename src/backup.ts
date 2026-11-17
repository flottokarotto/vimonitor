import { join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { backupDatabase } from './database-backup.ts';
import { logger } from './logger.ts';

try {
  const config = loadConfig();
  const destination = process.argv[2];
  if (!destination) throw new Error('Aufruf: npm run backup -- <neues Zielverzeichnis>');
  const source = join(config.dataDir, config.demo ? 'demo.sqlite' : 'vimonitor.sqlite');
  logger.success(`Datenbank und Token-Schluessel gesichert: ${backupDatabase(source, resolve(destination))}`);
} catch (error) {
  logger.error(`Backup fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
