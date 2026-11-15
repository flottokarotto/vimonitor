import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Viessmann } from './viessmann.ts';
import { Collector } from './collector.ts';
import { createApp } from './app.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, mock?: typeof fetch, demo = false) {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-http-'));
  const config = loadConfig({ DEMO_MODE: String(demo), VIESSMANN_CLIENT_ID: 'test' });
  const store = new Store(directory, demo);
  const api = new Viessmann(config, store, mock);
  const collector = new Collector(config, store, api);
  const server = createApp(config, store, api, collector).listen(0, '127.0.0.1');
  t.after(async () => {
    collector.stop();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return { store, api, collector, base };
}

test('HTTP status, history validation, local-host protection and OAuth state checking', async t => {
  const { base } = await fixture(t);
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).connected, false);
  assert.match(status.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/api/history?hours=1&sensor=x`)).status, 400);
  assert.equal((await fetch(`${base}/api/history?hours=24&sensor=x`)).status, 404);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(`${base}/api/status`, { headers: { Host: 'attacker.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/api/device`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/device`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"index":0}',
  })).status, 400);
  assert.equal((await fetch(`${base}/api/device`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{',
  })).status, 400);
  assert.equal((await fetch(`${base}/api/device`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(5000) }),
  })).status, 413);
  const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const url = new URL(login.headers.get('location') ?? '');
  const state = url.searchParams.get('state');
  assert.ok(state);
  assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.equal((await fetch(`${base}/auth/callback?state=${state}&code=x`)).status, 400);
  assert.equal((await fetch(`${base}/auth/callback?state=${state}&error=denied`, {
    headers: { Cookie: `oauth_state=${state}` },
  })).status, 400);
});

test('complete OAuth callback, equipment discovery, selection and temperature recording', async t => {
  const calls: string[] = [];
  const mock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/token')) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('code'), 'valid-code');
      assert.ok((body.get('code_verifier')?.length ?? 0) >= 43);
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    if (url.includes('/installations?')) return Response.json({
      data: [{ id: 1, description: 'Testanlage', gateways: [{ serial: '1234' }] }],
    });
    if (url.endsWith('/devices')) return Response.json({ data: [
      { id: '1', modelId: 'E3_TCU19_x05' },
      { id: '2', modelId: 'E3_RoomControl_One_19_04' },
      { id: '0', modelId: 'Vitocal Test' },
    ] });
    if (url.endsWith('/features')) return Response.json({ data: [
      { feature: 'heating.primaryCircuit.sensors.temperature.supply', properties: { value: { value: 38.5, unit: 'celsius' } } },
      { feature: 'heating.dhw.sensors.temperature.main', properties: { value: { value: 51.2, unit: 'celsius' } } },
    ] });
    throw new Error(`Unexpected mock request: ${url}`);
  };
  const { base, api, store } = await fixture(t, mock);
  const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const authorize = new URL(login.headers.get('location') ?? '');
  const state = authorize.searchParams.get('state');
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const callback = await fetch(`${base}/auth/callback?state=${state}&code=valid-code`, {
    headers: { Cookie: cookie }, redirect: 'manual',
  });
  assert.equal(callback.status, 302);
  assert.equal(api.connected(), true);
  assert.equal(store.getDevice(), undefined);
  const devices = await (await fetch(`${base}/api/devices`)).json();
  assert.equal(devices.devices.length, 1);
  assert.match(devices.devices[0].name, /Vitocal Test/);
  const select = await fetch(`${base}/api/device`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"index":0}',
  });
  assert.equal(select.status, 200);
  assert.deepEqual(await select.json(), { ok: true });
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.sensors.length, 2);
  assert.equal(status.sensors.find((sensor: { kind: string }) => sensor.kind === 'flow').value, 38.5);
  const history = await (await fetch(`${base}/api/history?hours=24&sensor=${encodeURIComponent('heating.dhw.sensors.temperature.main:value')}`)).json();
  assert.equal(history.points[0].value, 51.2);
  assert.equal(calls.length, 4);
  assert.equal((await fetch(`${base}/auth/callback?state=${state}&code=valid-code`, {
    headers: { Cookie: cookie },
  })).status, 400);
});

test('demo serves local dashboard assets and rejects live authentication', async t => {
  const { base, collector } = await fixture(t, undefined, true);
  await collector.start();
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.demo, true);
  assert.equal(status.sensors.length, 3);
  for (const [path, contentType] of [
    ['/', 'text/html'], ['/app.js', 'javascript'], ['/style.css', 'text/css'],
    ['/favicon.svg', 'image/svg+xml'], ['/vendor/chart.js', 'javascript'],
  ] as const) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes(contentType));
    await response.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/auth/login`, { redirect: 'manual' })).status, 400);
  assert.equal((await fetch(`${base}/api/devices`)).status, 400);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/data/token.key`)).status, 404);
});

test('a failed initial measurement returns an explicit error and no fake readings', async t => {
  const { base, store } = await fixture(t, async input => {
    const url = String(input);
    if (url.includes('/installations?')) return Response.json({ data: [{ id: 1, gateways: [{ serial: '1234' }] }] });
    if (url.endsWith('/devices')) return Response.json({ data: [{ id: '0' }] });
    return Response.json({ data: [] });
  });
  store.saveSecret({ accessToken: 'test', refreshToken: 'test', expiresAt: Date.now() + 3600_000 });
  await fetch(`${base}/api/devices`);
  const response = await fetch(`${base}/api/device`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"index":0}',
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /erste Messung fehlgeschlagen/);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.ok(status.device);
  assert.equal(status.sensors.length, 0);
  assert.match(status.error, /Keine freigegebenen Celsius-Sensoren/);
});
