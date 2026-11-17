import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export function checkDatabase(db: DatabaseSync) {
  const results = db.prepare('PRAGMA integrity_check').all();
  if (results.length !== 1 || results[0]?.integrity_check !== 'ok') {
    throw new Error('SQLite-Integritaetspruefung fehlgeschlagen.');
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) {
    throw new Error('SQLite-Fremdschluesselpruefung fehlgeschlagen.');
  }
}

export function backupDatabase(source: string, destination: string): string {
  const target = resolve(destination);
  const key = readFileSync(join(dirname(source), 'token.key'));
  if (key.length !== 32) throw new Error('Ungueltiger lokaler Token-Schluessel; Backup abgebrochen.');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    mkdirSync(target, { mode: 0o700 });
    const snapshot = join(target, basename(source));
    db.prepare('VACUUM INTO ?').run(snapshot);
    const verification = new DatabaseSync(snapshot, { readOnly: true });
    try { checkDatabase(verification); }
    finally { verification.close(); }
    writeFileSync(join(target, 'token.key'), key, { flag: 'wx', mode: 0o600 });
    return target;
  } finally { db.close(); }
}
