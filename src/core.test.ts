import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { parseTemperatures } from './model.ts';
import { Store } from './store.ts';
import { ApiError, Viessmann } from './viessmann.ts';
import { Collector } from './collector.ts';

const device = { installationId: '1', gatewaySerial: '2', deviceId: '0', name: 'Test' };
const temperature = { sensor: 'flow', label: 'Vorlauf', kind: 'flow' as const, value: 42 };
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-test-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const config = loadConfig({ DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test', DATA_DIR: directory });
  return { directory, store, config };
}
function tokens(store: Store, expiresAt = Date.now() + 3600_000) {
  store.saveSecret({ accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt });
}

test('configuration rejects invalid values instead of switching modes silently', () => {
  assert.equal(loadConfig({}).demo, true);
  assert.throws(() => loadConfig({ DEMO_MODE: 'yes' }));
  assert.throws(() => loadConfig({ DEMO_MODE: 'false' }), /CLIENT_ID/);
  assert.throws(() => loadConfig({ POLL_INTERVAL_SECONDS: '10' }));
  assert.throws(() => loadConfig({ PORT: '' }));
  assert.throws(() => loadConfig({ VIESSMANN_REDIRECT_URI: 'https://example.com' }));
});

test('sensor parsing distinguishes supply, water, other and disabled sensors', () => {
  const feature = (name: string, value: unknown, extra = {}) => ({
    feature: name, properties: { value: { value, unit: 'celsius' } }, ...extra,
  });
  const result = parseTemperatures([
    feature('heating.primaryCircuit.sensors.temperature.supply', 41),
    feature('heating.dhw.sensors.temperature.main', 50),
    feature('heating.boiler.sensors.temperature.main', 60),
    feature('heating.circuits.0.sensors.temperature.supply', 35),
    feature('disabled', 0, { isEnabled: false }),
    feature('invalid', '42'), feature('not-finite', NaN),
  ]);
  assert.deepEqual(result.map(item => item.kind), ['flow', 'water', 'other', 'flow']);
  assert.equal(result[3]?.label, 'Vorlauf Heizkreis 1');
  assert.throws(() => parseTemperatures([null]), /Datenformat/);
});

test('SQLite persists values, isolates devices, deduplicates and aggregates exact extrema', t => {
  const { directory, store } = fixture(t);
  const now = 1800000000000;
  store.setDevice(device);
  store.saveReadings(device, now, [temperature]);
  store.saveReadings(device, now, [{ ...temperature, value: 999 }]);
  store.saveReadings(device, now + 1, [{ ...temperature, value: 44 }]);
  store.saveReadings({ ...device, deviceId: 'other' }, now, [{ ...temperature, value: -10 }]);
  const history = store.history(device, 'flow', now, now + 10);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.value, 43);
  assert.equal(history[0]?.min, 42);
  assert.equal(history[0]?.max, 44);
  assert.equal(history[0]?.count, 2);
  const reopened = new Store(directory);
  assert.deepEqual(reopened.getDevice(), device);
  assert.equal(reopened.sensors(device)[0]?.value, 44);
  reopened.close();
});

test('history remains bounded to at most 601 buckets for 30 days', t => {
  const { store } = fixture(t);
  const now = 1800000000000;
  const from = now - 30 * 86400_000;
  for (let time = from; time <= now; time += 300_000) store.saveReadings(device, time, [temperature]);
  assert.ok(store.history(device, 'flow', from, now).length <= 601);
});

test('tokens are encrypted and recoverable without exposing plaintext in SQLite', t => {
  const { directory, store } = fixture(t);
  store.saveSecret({ token: 'highly-sensitive-token' });
  assert.deepEqual(store.loadSecret(), { token: 'highly-sensitive-token' });
  assert.ok(!store.getSetting('tokens')?.includes('highly-sensitive-token'));
  for (const suffix of ['', '-wal']) {
    assert.ok(!readFileSync(join(directory, `vimonitor.sqlite${suffix}`)).includes(Buffer.from('highly-sensitive-token')));
  }
});

test('PKCE uses a fresh verifier, S256 challenge and offline access', t => {
  const { config, store } = fixture(t);
  const api = new Viessmann(config, store);
  const first = api.authorization();
  const second = api.authorization();
  const url = new URL(first.url);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), first.state);
  assert.match(url.searchParams.get('scope') ?? '', /offline_access/);
});

test('concurrent requests share one token refresh and retain an unrotated refresh token', async t => {
  const { config, store } = fixture(t);
  tokens(store, 0);
  let refreshed = 0;
  const mock: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/token')) {
      refreshed++;
      assert.match(String(init?.body), /grant_type=refresh_token/);
      return Response.json({ access_token: 'new-access', expires_in: 3600 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer new-access');
    return Response.json({ data: [] });
  };
  const api = new Viessmann(config, store, mock);
  await Promise.all([api.get('/test'), api.get('/test')]);
  assert.equal(refreshed, 1);
  assert.deepEqual(store.loadSecret(), {
    accessToken: 'new-access', refreshToken: 'secret-refresh',
    expiresAt: (store.loadSecret() as { expiresAt: number }).expiresAt,
  });
});

test('401 refreshes once; revoked refresh tokens disconnect explicitly', async t => {
  const { config, store } = fixture(t);
  tokens(store);
  let calls = 0;
  const api = new Viessmann(config, store, async input => {
    if (String(input).endsWith('/token')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    calls++;
    return new Response(null, { status: 401 });
  });
  await assert.rejects(api.get('/test'), /erneut verbinden/);
  assert.equal(calls, 1);
  assert.equal(api.connected(), false);
});

test('429 preserves retry-after without storing fabricated readings', async t => {
  const { config, store } = fixture(t);
  store.setDevice(device);
  tokens(store);
  const api = new Viessmann(config, store, async () =>
    new Response(null, { status: 429, headers: { 'Retry-After': '7200' } }));
  await assert.rejects(api.features(device), (error: unknown) =>
    error instanceof ApiError && error.retrySeconds === 7200);
  const collector = new Collector(config, store, api, () => 1800000000000);
  t.after(() => collector.stop());
  await collector.start();
  assert.match(collector.error ?? '', /Abfragelimit/);
  assert.equal(collector.nextPollAt, 1800000000000 + 7200_000);
  assert.equal(store.sensors(device).length, 0);
});

test('collection never overlaps and stopping waits for an in-flight write', async t => {
  const { config, store } = fixture(t);
  store.setDevice(device);
  tokens(store);
  let release: ((response: Response) => void) | undefined;
  let requests = 0;
  const api = new Viessmann(config, store, () => {
    requests++;
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const collector = new Collector(config, store, api);
  t.after(() => collector.stop());
  const active = collector.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(collector.running, true);
  await assert.rejects(collector.restart(), /bereits/);
  await collector.poll();
  assert.equal(requests, 1);
  collector.stop();
  assert.ok(release);
  release(Response.json({ data: [{
    feature: 'heating.primaryCircuit.sensors.temperature.supply',
    properties: { value: { value: 40, unit: 'celsius' } },
  }] }));
  await collector.waitForIdle();
  await active;
  assert.equal(collector.running, false);
  assert.equal(collector.nextPollAt, null);
  assert.equal(store.sensors(device)[0]?.value, 40);
});

test('demo writes seven days to a separate SQLite database and survives restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-demo-test-'));
  const config = loadConfig({});
  const store = new Store(directory);
  const demo = new Store(directory, true);
  const demoConfig = { ...config, demo: true };
  const collector = new Collector(demoConfig, demo, new Viessmann(demoConfig, demo));
  t.after(() => {
    collector.stop();
    demo.close();
    store.close();
    rmSync(directory, { recursive: true });
  });
  await collector.start();
  const selected = demo.getDevice();
  assert.ok(selected);
  assert.equal(demo.sensors(selected).length, 3);
  assert.equal(store.getDevice(), undefined);
  assert.ok(demo.history(selected, 'demo.flow', Date.now() - 7 * 86400_000, Date.now()).length > 500);
  await collector.restart();
  assert.equal(demo.sensors(selected).length, 3);
});
