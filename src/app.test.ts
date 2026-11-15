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

test('HTTP status, history validation, local-host protection and OAuth state checking', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-http-'));
  const config = loadConfig({ DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test' });
  const store = new Store(directory);
  const api = new Viessmann(config, store);
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
