import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { deviceKey } from './model.ts';

const device = { installationId: '1', gatewaySerial: '2', deviceId: '0', name: 'Test' };
const legacySchema = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sensors (
    device TEXT NOT NULL, sensor TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (device, sensor)
  );
  CREATE TABLE readings (
    device TEXT NOT NULL, sensor TEXT NOT NULL, timestamp INTEGER NOT NULL, value REAL NOT NULL,
    PRIMARY KEY (device, sensor, timestamp)
  );
  CREATE INDEX readings_time ON readings(device, timestamp);
`;

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-migration-'));
  t.after(() => rmSync(directory, { recursive: true }));
  return { directory, path: join(directory, 'vimonitor.sqlite') };
}

test('new live and demo databases have schema version 1 and reopen unchanged', t => {
  const { directory } = fixture(t);
  for (const demo of [false, true]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new Store(directory, demo);
      try {
        if (attempt === 0) store.setSetting('preserved', 'yes');
        assert.equal(store.getSetting('preserved'), 'yes');
      } finally { store.close(); }
      const db = new DatabaseSync(join(directory, demo ? 'demo.sqlite' : 'vimonitor.sqlite'));
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
        assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get()?.n, 4);
        assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'readings_time'").get());
      } finally { db.close(); }
    }
  }
});

for (const withSchedules of [false, true]) {
  test(`unversioned database ${withSchedules ? 'with' : 'without'} schedules retains all data`, t => {
    const { directory, path } = fixture(t);
    const db = new DatabaseSync(path);
    try {
      db.exec(legacySchema);
      db.prepare('INSERT INTO settings VALUES (?, ?)').run('tokens', 'existing-encrypted-token');
      db.prepare('INSERT INTO sensors VALUES (?, ?, ?, ?)').run(deviceKey(device), 'flow', 'Vorlauf', 'flow');
      db.prepare('INSERT INTO readings VALUES (?, ?, ?, ?)').run(deviceKey(device), 'flow', 1800000000000, 42);
      if (withSchedules) {
        db.exec(`CREATE TABLE schedule_snapshots (
          device TEXT NOT NULL, timestamp INTEGER NOT NULL, poll_seconds INTEGER NOT NULL,
          schedules TEXT NOT NULL, error TEXT, PRIMARY KEY (device, timestamp)
        )`);
        db.prepare('INSERT INTO schedule_snapshots VALUES (?, ?, ?, ?, ?)').run(deviceKey(device), 1800000000000, 300, '[]', null);
      }
    } finally { db.close(); }
    const store = new Store(directory);
    try {
      assert.equal(store.getSetting('tokens'), 'existing-encrypted-token');
      assert.equal(store.sensors(device)[0]?.value, 42);
      assert.deepEqual(store.readings(device, 'flow', 0, 1800000000000), [{ timestamp: 1800000000000, value: 42 }]);
      assert.equal(store.scheduleSnapshots(device, 0, 1800000000000).length, withSchedules ? 1 : 0);
    } finally { store.close(); }
    const migrated = new DatabaseSync(path);
    try { assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 1); }
    finally { migrated.close(); }
  });
}

test('newer schema version is rejected without changing schema or data', t => {
  const { directory, path } = fixture(t);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('keep'); PRAGMA user_version = 2;");
  } finally { db.close(); }
  assert.throws(() => new Store(directory), /Schema-Version 2/);
  const unchanged = new DatabaseSync(path);
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(unchanged.prepare('SELECT value FROM future').get()?.value, 'keep');
    assert.equal(unchanged.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get()?.n, 1);
  } finally { unchanged.close(); }
});

test('failed migration rolls back earlier DDL and leaves version unchanged', t => {
  const { directory, path } = fixture(t);
  const db = new DatabaseSync(path);
  try { db.exec('CREATE TABLE readings (unexpected TEXT);'); }
  finally { db.close(); }
  assert.throws(() => new Store(directory), /no such column/);
  const unchanged = new DatabaseSync(path);
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get()?.user_version, 0);
    assert.deepEqual(unchanged.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name), ['readings']);
    unchanged.exec('BEGIN IMMEDIATE; ROLLBACK;');
  } finally { unchanged.close(); }
});
