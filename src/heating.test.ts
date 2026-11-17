import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Collector } from './collector.ts';
import { HeatingError } from './heating.ts';
import type { HeatingReader } from './heating.ts';
import { Store } from './store.ts';
import { Viessmann } from './viessmann.ts';
import type { TokenStore } from './viessmann.ts';

const first = { installationId: '1', gatewaySerial: 'a', deviceId: '0', name: 'First' };
const second = { installationId: '2', gatewaySerial: 'b', deviceId: '0', name: 'Second' };
const temperature = { sensor: 'flow', label: 'Vorlauf', kind: 'flow' as const, value: 42 };

function memoryTokens(initial: unknown): TokenStore {
  let value = initial;
  return {
    hasSecret: () => value !== undefined,
    loadSecret: () => value,
    saveSecret: tokens => { value = tokens; },
    clearSecret: () => { value = undefined; },
  };
}

test('Viessmann client works with an independent token store and retries an unauthorized request once', async () => {
  const saved = memoryTokens({ accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 });
  let requests = 0;
  let refreshes = 0;
  const client = new Viessmann({ clientId: 'client', redirectUri: 'http://localhost/callback' }, saved, async (input, init) => {
    if (String(input).endsWith('/token')) {
      refreshes++;
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'refresh');
      return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
    }
    requests++;
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${requests === 1 ? 'old' : 'new'}`);
    return requests === 1 ? new Response(null, { status: 401 }) : Response.json({ data: [] });
  });
  assert.deepEqual(await client.devices(), []);
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
  assert.equal(client.connected(), true);
  assert.deepEqual(saved.loadSecret(), {
    accessToken: 'new', refreshToken: 'rotated',
    expiresAt: (saved.loadSecret() as { expiresAt: number }).expiresAt,
  });
});

test('Viessmann API errors include a bounded response detail without exposing other fields', async () => {
  const saved = memoryTokens({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 });
  const client = new Viessmann({ clientId: 'client', redirectUri: 'http://localhost/callback' }, saved, async () =>
    Response.json({
      error: { code: 'invalid_device', message: 'Feature endpoint unavailable' },
      access_token: 'must-not-be-shown',
    }, { status: 400 }));
  await assert.rejects(client.read(first), (error: unknown) =>
    error instanceof HeatingError
    && error.status === 400
    && error.message.includes('invalid_device')
    && error.message.includes('Feature endpoint unavailable')
    && !error.message.includes('must-not-be-shown'));
});

test('collector depends on the heating reader and respects rate limits across devices', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-reader-test-'));
  const store = new Store(directory);
  const config = loadConfig({ DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test', DATA_DIR: directory });
  store.setDevices([first, second]);
  const calls: string[] = [];
  let limited = false;
  const reader: HeatingReader = {
    connected: () => true,
    read: async device => {
      calls.push(device.installationId);
      if (limited) throw new HeatingError('Abfragelimit erreicht', 429, 7200);
      return { temperatures: [temperature], schedules: [], scheduleError: null };
    },
  };
  const now = 1800000000000;
  const collector = new Collector(config, store, reader, () => now);
  t.after(() => { collector.stop(); store.close(); rmSync(directory, { recursive: true }); });
  await collector.start();
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(store.sensors(first)[0]?.value, 42);
  assert.equal(store.sensors(second)[0]?.value, 42);
  calls.length = 0;
  limited = true;
  await collector.restart();
  assert.deepEqual(calls, ['1']);
  assert.match(collector.error ?? '', /Abfragelimit/);
  assert.equal(collector.nextPollAt, now + 7200_000);
});

test('collector retries transient Viessmann device communication errors with bounded backoff', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-communication-retry-'));
  const store = new Store(directory);
  const config = loadConfig({ DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test', DATA_DIR: directory });
  store.setDevices([first]);
  let attempts = 0;
  const delays: number[] = [];
  const reader: HeatingReader = {
    connected: () => true,
    read: async () => {
      attempts++;
      if (attempts < 3) throw new HeatingError('Viessmann-API: HTTP 400: DEVICE_COMMUNICATION_ERROR.', 400);
      return { temperatures: [temperature], schedules: [], scheduleError: null };
    },
  };
  const collector = new Collector(config, store, reader, () => 1800000000000, async delay => { delays.push(delay); });
  t.after(() => { collector.stop(); store.close(); rmSync(directory, { recursive: true }); });
  await collector.start();
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10_000, 30_000]);
  assert.equal(collector.error, null);
  assert.equal(store.sensors(first)[0]?.value, 42);
});

test('collector stops retrying after three communication failures and schedules the next poll', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-communication-failure-'));
  const store = new Store(directory);
  const config = loadConfig({ DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test', DATA_DIR: directory });
  store.setDevices([first]);
  let attempts = 0;
  const delays: number[] = [];
  const reader: HeatingReader = {
    connected: () => true,
    read: async () => {
      attempts++;
      throw new HeatingError('Viessmann-API: HTTP 400: DEVICE_COMMUNICATION_ERROR.', 400);
    },
  };
  const now = 1800000000000;
  const collector = new Collector(config, store, reader, () => now, async delay => { delays.push(delay); });
  t.after(() => { collector.stop(); store.close(); rmSync(directory, { recursive: true }); });
  await collector.start();
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10_000, 30_000]);
  assert.match(collector.error ?? '', /DEVICE_COMMUNICATION_ERROR/);
  assert.equal(collector.nextPollAt, now + config.pollSeconds * 2 * 1000);
});
