import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temperatureLabel } from './model.ts';
import type { Device, Temperature } from './model.ts';
import type { Schedule, ScheduleSnapshot } from './schedules.ts';
import { normalizedSchema } from './schema.ts';
import { backupDatabase, checkDatabase } from './database-backup.ts';
import { logger } from './logger.ts';

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sensors (
      device TEXT NOT NULL, sensor TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
      PRIMARY KEY (device, sensor)
    );
    CREATE TABLE IF NOT EXISTS readings (
      device TEXT NOT NULL, sensor TEXT NOT NULL, timestamp INTEGER NOT NULL, value REAL NOT NULL,
      PRIMARY KEY (device, sensor, timestamp)
    );
    CREATE INDEX IF NOT EXISTS readings_time ON readings(device, timestamp);
    CREATE TABLE IF NOT EXISTS schedule_snapshots (
      device TEXT NOT NULL, timestamp INTEGER NOT NULL, poll_seconds INTEGER NOT NULL,
      schedules TEXT NOT NULL, error TEXT,
      PRIMARY KEY (device, timestamp)
    );
  `,
  normalizedSchema,
];

function migrate(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (!Number.isInteger(version) || version < 0 || version > migrations.length) {
      throw new Error(`Nicht unterstuetzte Datenbank-Schema-Version ${version}; diese App unterstuetzt bis ${migrations.length}. Bitte eine passende App-Version verwenden.`);
    }
    for (const [index, migration] of migrations.entries()) {
      if (index < version) continue;
      db.exec(migration);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    if (version < migrations.length) checkDatabase(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export class Store {
  private db: DatabaseSync;
  private key: Buffer;

  constructor(directory: string, demo = false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'token.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Ungueltiger lokaler Token-Schluessel.');
    const path = join(directory, demo ? 'demo.sqlite' : 'vimonitor.sqlite');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version < migrations.length && this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table'").get()) {
        const backups = join(directory, 'backups');
        mkdirSync(backups, { recursive: true, mode: 0o700 });
        const destination = join(backups, `${demo ? 'demo' : 'vimonitor'}-before-v${migrations.length}-${Date.now()}-${randomBytes(4).toString('hex')}`);
        backupDatabase(path, destination);
        logger.info(`Datenbank vor Migration gesichert: ${destination}`);
      }
      const journalMode = this.db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
      if (journalMode !== 'wal') {
        throw new Error(`SQLite-WAL-Modus konnte nicht aktiviert werden (journal_mode: ${String(journalMode)}).`);
      }
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string) {
    if (key === 'device' || key === 'devices') throw new Error('Geraete muessen ueber setDevice/setDevices gespeichert werden.');
    this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getDevice(): Device | undefined {
    const row = this.db.prepare(`SELECT d.* FROM devices d JOIN active_device a ON a.device_id = d.id`).get();
    return row ? this.device(row) : undefined;
  }

  private device(row: Record<string, SQLOutputValue>): Device {
    return { installationId: String(row.installation_id), gatewaySerial: String(row.gateway_serial),
      deviceId: String(row.device_id), name: String(row.name) };
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureDevice(device: Device): number {
    const row = this.db.prepare(`
      INSERT INTO devices(installation_id, gateway_serial, device_id, name) VALUES (?, ?, ?, ?)
      ON CONFLICT(installation_id, gateway_serial, device_id) DO UPDATE SET name = excluded.name
      RETURNING id
    `).get(device.installationId, device.gatewaySerial, device.deviceId, device.name);
    if (!row) throw new Error('Geraet konnte nicht gespeichert werden.');
    return Number(row.id);
  }

  private deviceId(device: Device): number | undefined {
    const row = this.db.prepare('SELECT id FROM devices WHERE installation_id = ? AND gateway_serial = ? AND device_id = ?')
      .get(device.installationId, device.gatewaySerial, device.deviceId);
    return row ? Number(row.id) : undefined;
  }

  setDevice(device: Device) {
    this.transaction(() => {
      const id = this.ensureDevice(device);
      this.db.prepare(`INSERT INTO selected_devices(device_id, position)
        VALUES (?, (SELECT COALESCE(MAX(position) + 1, 0) FROM selected_devices))
        ON CONFLICT(device_id) DO NOTHING`).run(id);
      this.db.prepare(`INSERT INTO active_device VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET device_id = excluded.device_id`).run(id);
    });
  }
  getDevices(): Device[] {
    return this.db.prepare(`SELECT d.* FROM devices d JOIN selected_devices s ON s.device_id = d.id
      ORDER BY s.position`).all().map(row => this.device(row));
  }
  setDevices(devices: Device[]) {
    this.transaction(() => {
      const current = this.db.prepare('SELECT device_id FROM active_device').get()?.device_id;
      this.db.exec('DELETE FROM active_device; DELETE FROM selected_devices;');
      const ids = devices.map((device, position) => {
        const id = this.ensureDevice(device);
        this.db.prepare('INSERT INTO selected_devices(device_id, position) VALUES (?, ?)').run(id, position);
        return id;
      });
      const active = ids.find(id => id === current) ?? ids[0];
      if (active !== undefined) this.db.prepare('INSERT INTO active_device VALUES (1, ?)').run(active);
    });
  }
  clearDevice() {
    this.transaction(() => { this.db.exec('DELETE FROM active_device; DELETE FROM selected_devices;'); });
  }

  hasSecret() { return this.getSetting('tokens') !== undefined; }

  saveSecret(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    this.setSetting('tokens', Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'));
  }

  loadSecret(): unknown {
    const value = this.getSetting('tokens');
    if (!value) return undefined;
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }

  clearSecret() { this.db.prepare("DELETE FROM settings WHERE key = 'tokens'").run(); }

  saveReadings(device: Device, timestamp: number, temperatures: Temperature[]) {
    this.transaction(() => this.writeReadings(this.ensureDevice(device), timestamp, temperatures));
  }

  saveSnapshot(device: Device, temperatures: Temperature[], snapshot: ScheduleSnapshot) {
    this.transaction(() => {
      const id = this.ensureDevice(device);
      this.writeReadings(id, snapshot.timestamp, temperatures);
      this.writeSchedules(id, snapshot);
    });
  }

  private writeReadings(deviceId: number, timestamp: number, temperatures: Temperature[]) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Ungueltiger Messzeitpunkt.');
    const sensorStatement = this.db.prepare(`
      INSERT INTO sensors(device_id, sensor, label, kind) VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, sensor) DO UPDATE SET label = excluded.label, kind = excluded.kind
      RETURNING id`);
    const readingStatement = this.db.prepare(`INSERT INTO readings(sensor_id, timestamp, value) VALUES (?, ?, ?)
      ON CONFLICT(sensor_id, timestamp) DO NOTHING`);
    for (const item of temperatures) {
      if (!Number.isFinite(item.value)) throw new Error(`Ungueltiger Temperaturwert: ${item.sensor}`);
      const sensor = sensorStatement.get(deviceId, item.sensor, item.label, item.kind);
      if (!sensor) throw new Error(`Sensor konnte nicht gespeichert werden: ${item.sensor}`);
      readingStatement.run(Number(sensor.id), timestamp, item.value);
    }
  }

  sensors(device: Device) {
    return this.db.prepare(`
      SELECT s.sensor, s.label, s.kind, r.value, r.timestamp
      FROM sensors s JOIN readings r ON r.sensor_id = s.id
      WHERE s.device_id = ? AND r.timestamp = (
        SELECT MAX(timestamp) FROM readings WHERE sensor_id = s.id
      ) ORDER BY s.sensor
    `).all(this.deviceId(device) ?? null).map(row => {
      const sensor = String(row.sensor);
      if (!sensor.startsWith('heating.')) return row;
      const separator = sensor.lastIndexOf(':');
      return { ...row, label: temperatureLabel(sensor.slice(0, separator), sensor.slice(separator + 1)) };
    });
  }

  history(device: Device, sensor: string, from: number, to: number) {
    const bucket = Math.max(300_000, Math.ceil((to - from) / 600));
    return this.db.prepare(`
      SELECT CAST(timestamp / ? AS INTEGER) * ? AS timestamp,
        AVG(value) AS value, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS count
      FROM readings WHERE sensor_id = (SELECT id FROM sensors WHERE device_id = ? AND sensor = ?)
        AND timestamp >= ? AND timestamp <= ?
      GROUP BY CAST(timestamp / ? AS INTEGER) ORDER BY timestamp
    `).all(bucket, bucket, this.deviceId(device) ?? null, sensor, from, to, bucket);
  }

  saveSchedules(device: Device, snapshot: ScheduleSnapshot) {
    this.transaction(() => this.writeSchedules(this.ensureDevice(device), snapshot));
  }

  private writeSchedules(deviceId: number, snapshot: ScheduleSnapshot) {
    if (!Number.isSafeInteger(snapshot.timestamp) || snapshot.timestamp < 0
      || !Number.isSafeInteger(snapshot.pollSeconds) || snapshot.pollSeconds <= 0) {
      throw new Error('Ungueltiger Zeitprogramm-Zeitpunkt oder Abfrageabstand.');
    }
    const schedules = JSON.stringify(snapshot.schedules);
    this.db.prepare(`INSERT INTO schedule_programs(device_id, schedules) VALUES (?, ?)
      ON CONFLICT(device_id, schedules) DO NOTHING`).run(deviceId, schedules);
    const program = this.db.prepare('SELECT id FROM schedule_programs WHERE device_id = ? AND schedules = ?').get(deviceId, schedules);
    if (!program) throw new Error('Zeitprogramm konnte nicht gespeichert werden.');
    this.db.prepare(`INSERT INTO schedule_snapshots(device_id, timestamp, poll_seconds, program_id, error)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id, timestamp) DO UPDATE SET
      poll_seconds = excluded.poll_seconds, program_id = excluded.program_id, error = excluded.error`)
      .run(deviceId, snapshot.timestamp, snapshot.pollSeconds, Number(program.id), snapshot.error);
  }

  scheduleSnapshots(device: Device, from: number, to: number): ScheduleSnapshot[] {
    return this.db.prepare(`
      SELECT s.timestamp, s.poll_seconds, p.schedules, s.error
      FROM schedule_snapshots s JOIN schedule_programs p ON p.id = s.program_id
      WHERE s.device_id = ? AND s.timestamp >= ? AND s.timestamp <= ? ORDER BY s.timestamp
    `).all(this.deviceId(device) ?? null, from, to).map(row => ({
      timestamp: Number(row.timestamp), pollSeconds: Number(row.poll_seconds),
      schedules: JSON.parse(String(row.schedules)) as Schedule[],
      error: row.error === null ? null : String(row.error),
    }));
  }

  readings(device: Device, sensor: string, from: number, to: number) {
    return this.db.prepare(`
      SELECT timestamp, value FROM readings
      WHERE sensor_id = (SELECT id FROM sensors WHERE device_id = ? AND sensor = ?)
        AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp
    `).all(this.deviceId(device) ?? null, sensor, from, to)
      .map(row => ({ timestamp: Number(row.timestamp), value: Number(row.value) }));
  }

  close() { this.db.close(); }
}
