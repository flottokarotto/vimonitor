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
import { DAYS } from './schedules.ts';

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
  const insights = await (await fetch(`${base}/api/insights`)).json();
  assert.equal(insights.lastNight, null);
  assert.equal(insights.schedules.length, 0);
  assert.match(insights.message, /verbinden/);
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
      { feature: 'heating.dhw.schedule', properties: {
        active: { value: true },
        entries: { value: Object.fromEntries(DAYS.map(day => [day, [{ start: '05:00', end: '22:00', mode: 'on' }]])) },
      } },
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
  const insights = await (await fetch(`${base}/api/insights`)).json();
  assert.equal(insights.schedules.length, 1);
  assert.equal(insights.schedules[0].entries.mon[0].start, '05:00');
  assert.equal(insights.timeZone, 'Europe/Berlin');
  assert.equal(insights.sensor, 'heating.dhw.sensors.temperature.main:value');
  assert.equal(insights.lastNight?.rate ?? null, null);
  assert.equal(calls.length, 4);
  assert.equal((await fetch(`${base}/auth/callback?state=${state}&code=valid-code`, {
    headers: { Cookie: cookie },
  })).status, 400);
});

test('multiple heaters collect independently and expose device-specific history', async t => {
  const calls: string[] = [];
  let failure: 'none' | 'server' | 'limit' = 'none';
  const mock: typeof fetch = async input => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/installations?')) return Response.json({ data: [
      { id: 1, description: 'Haus', gateways: [{ serial: 'A1234' }] },
      { id: 2, description: 'Haus', gateways: [{ serial: 'B1234' }] },
    ] });
    if (url.endsWith('/devices')) return Response.json({ data: [{ id: '0', modelId: 'Vitodens' }] });
    if (url.endsWith('/features')) {
      if (failure !== 'none' && url.includes('/installations/1/')) {
        return new Response('', { status: failure === 'limit' ? 429 : 500, headers: { 'Retry-After': '1800' } });
      }
      return Response.json({ data: [{
        feature: 'heating.primaryCircuit.sensors.temperature.supply',
        properties: { value: { value: url.includes('/installations/1/') ? 38 : 51, unit: 'celsius' } },
      }] });
    }
    throw new Error(`Unexpected mock request: ${url}`);
  };
  const { base, store, collector } = await fixture(t, mock);
  store.saveSecret({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 });
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  const post = (path: string, value: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(value) });
  const discovered = await (await fetch(`${base}/api/devices`)).json();
  assert.equal(discovered.devices.length, 2);
  assert.notEqual(discovered.devices[0].name, discovered.devices[1].name);
  assert.match(discovered.devices[0].name, /Kennung [0-9a-f]{8}$/);
  assert.match(discovered.devices[1].name, /Kennung [0-9a-f]{8}$/);
  assert.equal((await post('/api/devices', { indexes: [] })).status, 400);
  assert.equal((await post('/api/devices', { indexes: [0, 0] })).status, 400);
  assert.equal((await post('/api/devices', { indexes: [0, 2] })).status, 400);
  assert.equal((await post('/api/devices', { indexes: [0, 1] })).status, 200);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.devices.length, 2);
  assert.deepEqual(status.devices.map((item: { name: string }) => item.name), discovered.devices.map((item: { name: string }) => item.name));
  assert.equal(status.device.name, status.devices[0].name);
  assert.deepEqual(status.devices.map((item: { sensors: { value: number }[] }) => item.sensors[0]?.value), [38, 51]);
  assert.equal(status.sensors[0].value, 38);
  const sensor = encodeURIComponent('heating.primaryCircuit.sensors.temperature.supply:value');
  for (const [index, expected] of [38, 51].entries()) {
    const history = await (await fetch(`${base}/api/history?hours=24&sensor=${sensor}&device=${encodeURIComponent(status.devices[index].id)}`)).json();
    assert.equal(history.points[0].value, expected);
  }
  assert.equal((await fetch(`${base}/api/history?hours=24&sensor=${sensor}&device=missing`)).status, 404);
  assert.equal((await post('/api/active-device', { id: status.devices[1].id })).status, 200);
  assert.equal((await (await fetch(`${base}/api/status`)).json()).sensors[0].value, 51);
  assert.equal((await (await fetch(`${base}/api/history?hours=24&sensor=${sensor}`)).json()).points[0].value, 51);
  assert.equal((await post('/api/active-device', { id: 'missing' })).status, 400);
  assert.equal((await (await fetch(`${base}/api/devices`)).json()).devices.filter((device: { selected: boolean }) => device.selected).length, 2);
  failure = 'server';
  const before = calls.length;
  await collector.restart();
  assert.ok(collector.error?.includes(status.devices[0].name));
  assert.match(collector.error ?? '', /HTTP 500/);
  assert.equal(calls.slice(before).filter(url => url.endsWith('/features')).length, 2);
  assert.equal((await (await fetch(`${base}/api/status`)).json()).devices[1].sensors[0].value, 51);
  failure = 'limit';
  const beforeLimit = calls.length;
  await collector.restart();
  assert.match(collector.error ?? '', /Abfragelimit/);
  assert.equal(calls.slice(beforeLimit).filter(url => url.endsWith('/features')).length, 1);
  assert.ok((collector.nextPollAt ?? 0) >= Date.now() + 1790_000);
});

test('demo serves local dashboard assets and rejects live authentication', async t => {
  const { base, collector } = await fixture(t, undefined, true);
  await collector.start();
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.demo, true);
  assert.equal(status.sensors.length, 3);
  const insights = await (await fetch(`${base}/api/insights`)).json();
  assert.equal(insights.schedules.length, 2);
  assert.ok(insights.lastNight);
  assert.ok(['ok', 'disturbed'].includes(insights.lastNight.status));
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
