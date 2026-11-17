import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig } from './config.ts';
import { logger } from './logger.ts';
import { createRuntime } from './runtime.ts';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('shared runtime serves the local API and shuts down cleanly', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-runtime-'));
  const port = await unusedPort();
  const config = loadConfig({
    DEMO_MODE: 'false',
    VIESSMANN_CLIENT_ID: 'test',
    DATA_DIR: directory,
    PORT: String(port),
  });
  const entries: string[] = [];
  const unsubscribe = logger.subscribe(entry => entries.push(`${entry.level} ${entry.message}`), true);
  const runtime = createRuntime(config);
  assert.equal(runtime.config, config);
  assert.ok(runtime.store);
  assert.ok(runtime.api);
  assert.ok(runtime.collector);
  t.after(async () => {
    await runtime.close();
    unsubscribe();
    rmSync(directory, { recursive: true });
  });

  await runtime.listen();
  const status = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).connected, false);
  assert.ok(entries.some(entry => entry.includes('ViMonitor gestartet')));

  await runtime.close();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`));
  assert.ok(entries.some(entry => entry.includes('ViMonitor sauber beendet')));
});
