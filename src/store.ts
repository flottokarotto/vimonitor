import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceKey } from './model.ts';
import type { Device, Temperature } from './model.ts';

export class Store {
  private db: DatabaseSync;
  private key: Buffer;

  constructor(directory: string, demo = false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'token.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Ungueltiger lokaler Token-Schluessel.');
    this.db = new DatabaseSync(join(directory, demo ? 'demo.sqlite' : 'vimonitor.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
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
    `);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, value);
  }

  getDevice(): Device | undefined {
    const value = this.getSetting('device');
    return value ? JSON.parse(value) as Device : undefined;
  }

  setDevice(device: Device) { this.setSetting('device', JSON.stringify(device)); }
  clearDevice() { this.db.prepare("DELETE FROM settings WHERE key = 'device'").run(); }

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
    const key = deviceKey(device);
    const sensorStatement = this.db.prepare('INSERT OR REPLACE INTO sensors VALUES (?, ?, ?, ?)');
    const readingStatement = this.db.prepare('INSERT OR IGNORE INTO readings VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const item of temperatures) {
        sensorStatement.run(key, item.sensor, item.label, item.kind);
        readingStatement.run(key, item.sensor, timestamp, item.value);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  sensors(device: Device) {
    return this.db.prepare(`
      SELECT s.sensor, s.label, s.kind, r.value, r.timestamp
      FROM sensors s JOIN readings r ON r.device = s.device AND r.sensor = s.sensor
      WHERE s.device = ? AND r.timestamp = (
        SELECT MAX(timestamp) FROM readings WHERE device = s.device AND sensor = s.sensor
      ) ORDER BY s.sensor
    `).all(deviceKey(device));
  }

  history(device: Device, sensor: string, from: number, to: number) {
    const bucket = Math.max(300_000, Math.ceil((to - from) / 600));
    return this.db.prepare(`
      SELECT CAST(timestamp / ? AS INTEGER) * ? AS timestamp,
        AVG(value) AS value, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS count
      FROM readings WHERE device = ? AND sensor = ? AND timestamp >= ? AND timestamp <= ?
      GROUP BY CAST(timestamp / ? AS INTEGER) ORDER BY timestamp
    `).all(bucket, bucket, deviceKey(device), sensor, from, to, bucket);
  }

  close() { this.db.close(); }
}
