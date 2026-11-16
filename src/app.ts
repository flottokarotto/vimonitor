import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { Collector } from './collector.ts';
import { ApiError, type Viessmann } from './viessmann.ts';
import type { Device } from './model.ts';
import { deviceKey } from './model.ts';
import { buildInsights } from './insights.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

export function createApp(config: Config, store: Store, api: Viessmann, collector: Collector) {
  const app = express();
  const pending = new Map<string, { verifier: string; expires: number }>();
  let devices: Device[] = [];
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hosts = [`localhost:${req.socket.localPort}`, `127.0.0.1:${req.socket.localPort}`];
    if (!hosts.includes(req.headers.host ?? '')) {
      res.status(403).json({ error: 'Ungueltiger Host. Bitte localhost verwenden.' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && !hosts.some(host => req.headers.origin === `http://${host}`)) {
      res.status(403).json({ error: 'Anfrage aus fremdem Ursprung abgelehnt.' });
      return;
    }
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '4kb' }));

  app.get('/api/status', (_req, res) => {
    const device = store.getDevice();
    res.json({
      demo: config.demo, connected: config.demo || api.connected(),
      device: device ? { name: device.name } : null,
      sensors: device ? store.sensors(device) : [],
      error: collector.error, nextPollAt: collector.nextPollAt,
      pollSeconds: config.pollSeconds, collecting: collector.running,
      devices: store.getDevices().map(item => ({
        id: deviceKey(item), name: item.name, sensors: store.sensors(item),
      })),
      activeDevice: device ? deviceKey(device) : null,
    });
  });

  app.get('/api/history', (req, res) => {
    const hours = Number(req.query.hours);
    const sensor = req.query.sensor;
    if (![24, 168, 720].includes(hours) || typeof sensor !== 'string' || sensor.length > 256) {
      throw new ApiError('Ungueltiger Zeitraum oder Sensor.', 400);
    }
    const requested = req.query.device;
    if (requested !== undefined && typeof requested !== 'string') throw new ApiError('Ungueltige Geraeteauswahl.', 400);
    const device = requested === undefined ? store.getDevice() : store.getDevices().find(item => deviceKey(item) === requested);
    if (!device || !store.sensors(device).some(item => item.sensor === sensor)) {
      throw new ApiError('Sensor nicht vorhanden. Zuerst ein Geraet verbinden.', 404);
    }
    const to = Date.now();
    res.json({ points: store.history(device, sensor, to - hours * 3600_000, to) });
  });

  app.get('/api/insights', (_req, res) => {
    res.json(buildInsights(store, store.getDevice()));
  });

  app.get('/auth/login', (_req, res) => {
    if (config.demo) throw new ApiError('Anmeldung ist im Demo-Modus deaktiviert.', 400);
    for (const [state, flow] of pending) if (flow.expires < Date.now()) pending.delete(state);
    if (pending.size >= 20) throw new ApiError('Zu viele offene Anmeldungen. Bitte spaeter erneut versuchen.', 429);
    const flow = api.authorization();
    pending.set(flow.state, { verifier: flow.verifier, expires: Date.now() + 600_000 });
    res.cookie('oauth_state', flow.state, { httpOnly: true, sameSite: 'lax', maxAge: 600_000, path: '/auth/callback' });
    res.redirect(flow.url);
  });

  app.get('/auth/callback', async (req, res) => {
    const state = req.query.state;
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('oauth_state='))?.slice(12);
    const flow = typeof state === 'string' ? pending.get(state) : undefined;
    if (!flow || state !== cookie || flow.expires < Date.now() || config.demo) {
      throw new ApiError('Anmeldung ungueltig oder abgelaufen. Bitte erneut im Dashboard starten.', 400);
    }
    pending.delete(String(state));
    res.clearCookie('oauth_state', { path: '/auth/callback' });
    if (req.query.error) throw new ApiError('Anmeldung bei Viessmann abgebrochen oder abgelehnt.', 400);
    if (typeof req.query.code !== 'string') throw new ApiError('Autorisierungscode fehlt.', 400);
    await api.exchange(req.query.code, flow.verifier);
    store.clearDevice();
    devices = [];
    res.redirect('/');
  });

  app.get('/api/devices', async (_req, res) => {
    if (config.demo) throw new ApiError('Geraeteauswahl ist im Demo-Modus deaktiviert.', 400);
    devices = await api.devices();
    const selected = new Set(store.getDevices().map(deviceKey));
    res.json({ devices: devices.map((device, index) => ({ index, name: device.name, deviceId: device.deviceId, selected: selected.has(deviceKey(device)) })) });
  });

  app.post('/api/devices', async (req, res) => {
    const indexes: unknown = req.body?.indexes;
    if (config.demo || !Array.isArray(indexes) || !indexes.length
      || indexes.some(index => typeof index !== 'number' || !Number.isInteger(index) || !devices[index])
      || new Set(indexes).size !== indexes.length) {
      throw new ApiError('Ungueltige Geraeteauswahl. Bitte Geraeteliste neu laden und mindestens ein Geraet auswaehlen.', 400);
    }
    if (collector.running) throw new ApiError('Messabfrage laeuft. Bitte kurz warten.', 409);
    store.setDevices(indexes.map(index => devices[index]!));
    await collector.restart();
    if (collector.error) throw new ApiError(`Auswahl gespeichert, aber Messung fehlgeschlagen: ${collector.error}`, 502);
    res.json({ ok: true });
  });

  app.post('/api/active-device', (req, res) => {
    const id: unknown = req.body?.id;
    const device = typeof id === 'string' ? store.getDevices().find(item => deviceKey(item) === id) : undefined;
    if (!device) throw new ApiError('Geraet ist nicht ausgewaehlt.', 400);
    store.setDevice(device);
    res.json({ ok: true });
  });

  app.post('/api/device', async (req, res) => {
    const index: unknown = req.body?.index;
    if (config.demo || typeof index !== 'number' || !Number.isInteger(index) || !devices[index]) {
      throw new ApiError('Ungueltige Geraeteauswahl. Bitte Geraeteliste neu laden.', 400);
    }
    if (collector.running) throw new ApiError('Messabfrage laeuft. Bitte kurz warten.', 409);
    store.setDevices([devices[index]]);
    await collector.restart();
    if (collector.error) throw new ApiError(`Geraet ausgewaehlt, aber erste Messung fehlgeschlagen: ${collector.error}`, 502);
    res.json({ ok: true });
  });

  app.get('/vendor/chart.js', (_req, res) => {
    res.sendFile(join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  });
  app.use(express.static(join(root, 'public'), { etag: false }));
  app.use((_req, res) => { res.status(404).json({ error: 'Nicht gefunden.' }); });
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const bodyError = error instanceof Error && 'type' in error ? error.type : undefined;
    const status = error instanceof ApiError ? error.status
      : bodyError === 'entity.parse.failed' ? 400 : bodyError === 'entity.too.large' ? 413 : 500;
    const message = bodyError === 'entity.parse.failed' ? 'Ungueltiges JSON.'
      : bodyError === 'entity.too.large' ? 'Anfrage zu gross.'
        : error instanceof Error ? error.message : 'Unbekannter Serverfehler.';
    console.error(`HTTP ${status}: ${message}`);
    res.status(status >= 400 && status <= 599 ? status : 500).json({ error: message });
  };
  app.use(handleError);
  return app;
}
