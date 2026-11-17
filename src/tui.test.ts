import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { render } from 'ink-testing-library';
import { TerminalChooser, TerminalDashboard } from './tui-view.ts';
import { seriesKey } from './tui-model.ts';
import type { TerminalSnapshot } from './tui-model.ts';
import type { TerminalActions } from './tui.ts';
import { logger } from './logger.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './runtime.ts';
import { loadConfig } from './config.ts';
import { readTerminalSnapshot, terminalActions } from './tui.ts';
import { deviceKey } from './model.ts';

const pause = () => new Promise(resolve => setTimeout(resolve, 50));
function snapshot(): TerminalSnapshot {
  return {
    demo: false, connected: true, activeDevice: 'one', collecting: false,
    nextPollAt: 1800000300000, pollSeconds: 300, error: null, from: 1800000000000, to: 1800000600000,
    devices: ['one', 'two'].map(id => ({
      id, name: `Heizung ${id}`, sensors: [
        { sensor: 'flow', label: 'Vorlaufsensor', kind: 'flow', value: 35, timestamp: 1800000000000 },
        { sensor: 'water', label: 'Warmwassersensor', kind: 'water', value: 52, timestamp: 1800000000000 },
      ],
    })),
    histories: new Map(['one', 'two'].flatMap(id => ['flow', 'water'].map(sensor => [
      seriesKey(id, sensor), [{ timestamp: 1800000000000, value: sensor === 'flow' ? 35 : 52 },
        { timestamp: 1800000300000, value: sensor === 'flow' ? 36 : 51 }],
    ] as const))),
    insights: {
      timeZone: 'Europe/Berlin', observedAt: 1800000000000, stale: false,
      message: 'Noch keine vollständige Nacht', lastNight: null, schedules: [], sensor: null,
      comparison: null, comparableNights: 0, orientation: { lowMax: 0.5, moderateMax: 1.5 },
    },
  };
}

test('Ink chooser scrolls both axes, saves selected keys and keeps failed saves visible', async t => {
  const choices = Array.from({ length: 60 }, (_, index) => ({
    key: String(index), label: `${'Heizungsname '.repeat(12)}Sensor-${index}-Ende`, selected: index === 0,
  }));
  let saved: string[] = [];
  let closed = 0;
  let fail = true;
  const ui = render(h(TerminalChooser, {
    title: 'Temperaturen vergleichen', choices, size: { columns: 80, rows: 24 },
    onSave: async keys => { if (fail) throw new Error('Messabfrage läuft'); saved = keys; },
    onClose: () => { closed++; },
  }));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  const unsubscribe = logger.subscribe(() => {}, true);
  t.after(() => { unsubscribe(); });
  await pause();
  assert.match(ui.lastFrame() ?? '', /Temperaturen vergleichen/);
  ui.stdin.write('\u001b[F');
  await pause();
  assert.match(ui.lastFrame() ?? '', /60\/60/);
  for (let index = 0; index < 25; index++) { ui.stdin.write('\u001b[C'); await pause(); }
  assert.match(ui.lastFrame() ?? '', /Sensor-59-Ende/);
  ui.stdin.write(' '); await pause();
  ui.stdin.write('s'); await pause();
  assert.equal(closed, 0);
  assert.match(ui.lastFrame() ?? '', /Messabfrage läuft/);
  fail = false;
  ui.stdin.write('s'); await pause();
  assert.deepEqual(saved, ['0', '59']);
  assert.equal(closed, 1);
});

test('Ink dashboard preserves shared-backend controls, logs, full legend and resizing', async t => {
  const data = snapshot();
  const requests: number[] = [];
  let login = 0; let quit = 0; let closed = 0; let discovered = 0;
  const actions: TerminalActions = {
    read: hours => { requests.push(hours); return { ...data }; },
    discover: async () => { discovered++; return [{ key: 'one', label: 'Heizung one', selected: true }]; },
    selectDevices: async keys => { assert.deepEqual(keys, ['one']); },
    activate: id => { data.activeDevice = id; },
    login: () => { login++; },
  };
  const props = { actions, onClose: () => { closed++; }, onQuit: () => { quit++; }, size: { columns: 120, rows: 40 } };
  const ui = render(h(TerminalDashboard, props));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  await pause(); await pause();
  assert.match(ui.lastFrame() ?? '', /Ink\/React/);
  assert.match(ui.lastFrame() ?? '', /Status · 24 Stunden/);
  assert.match(ui.lastFrame() ?? '', /Vorlaufsensor/);
  assert.match(ui.lastFrame() ?? '', /Warmwassersensor/);
  assert.match(ui.lastFrame() ?? '', /Heizung one/);
  assert.doesNotMatch(ui.lastFrame() ?? '', /null|undefined|NaN/);
  logger.warn('TEST Live-Protokoll');
  await pause();
  assert.match(ui.lastFrame() ?? '', /TEST Live-Protokoll/);
  ui.stdin.write('2'); await pause();
  assert.equal(requests.at(-1), 168);
  assert.match(ui.lastFrame() ?? '', /Status · 7 Tage/);
  ui.stdin.write('a'); await pause();
  assert.equal(data.activeDevice, 'two');
  ui.stdin.write('l'); await pause();
  assert.equal(login, 1);
  ui.stdin.write('d'); await pause();
  assert.equal(discovered, 1);
  assert.match(ui.lastFrame() ?? '', /Heizgeräte für die Erfassung/);
  ui.stdin.write('s'); await pause(); await pause();
  ui.stdin.write('c'); await pause();
  assert.match(ui.lastFrame() ?? '', /Temperaturen vergleichen/);
  ui.stdin.write('\u001b'); await pause();
  ui.rerender(h(TerminalDashboard, { ...props, size: { columns: 160, rows: 55 } }));
  await pause();
  assert.ok((ui.lastFrame() ?? '').split('\n').length <= 55);
  assert.match(ui.lastFrame() ?? '', /Heizung two/);
  ui.stdin.write('\u0003'); await pause();
  assert.equal(quit, 1);
  ui.stdin.write('q'); await pause();
  assert.equal(closed, 1);
});

test('dashboard panels and axes fit the available space including the minimum terminal size', async t => {
  const data = snapshot();
  const actions: TerminalActions = {
    read: () => data, discover: async () => [], selectDevices: async () => {}, activate: () => {}, login: () => {},
  };
  const props = { actions, onClose: () => {}, onQuit: () => {} };
  const ui = render(h(TerminalDashboard, { ...props, size: { columns: 60, rows: 24 } }));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  for (const size of [{ columns: 60, rows: 24 }, { columns: 80, rows: 30 }, { columns: 160, rows: 50 }]) {
    ui.rerender(h(TerminalDashboard, { ...props, size }));
    await pause(); await pause();
    const frame = ui.lastFrame() ?? '';
    assert.ok(frame.split('\n').length <= size.rows);
    assert.ok(frame.split('\n').every(line => Array.from(line).length <= size.columns));
    assert.match(frame, /Status · 24 Stunden/);
    assert.match(frame, /Live-Protokoll/);
    assert.match(frame, /Auswertung/);
    assert.match(frame, /Vorlauf/);
    assert.match(frame, /Warmwasser/);
    assert.doesNotMatch(frame, /null|undefined|NaN/);
  }
});

test('comparison legend makes the complete long sensor names reachable by scrolling', async t => {
  const data = snapshot();
  for (const device of data.devices) {
    for (const sensor of device.sensors) sensor.label = `${'Temperatur '.repeat(60)}VOLLSTAENDIGER SENSORNAME`;
  }
  const actions: TerminalActions = {
    read: () => data, discover: async () => [], selectDevices: async () => {}, activate: () => {}, login: () => {},
  };
  const ui = render(h(TerminalDashboard, {
    actions, onClose: () => {}, onQuit: () => {}, size: { columns: 120, rows: 40 },
  }));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  await pause(); await pause();
  assert.doesNotMatch(ui.lastFrame() ?? '', /SENSORNAME/);
  ui.stdin.write('g'); await pause();
  ui.stdin.write('\u001b[F'); await pause();
  assert.match(ui.lastFrame() ?? '', /SENSORNAME/);
  ui.stdin.write('\u001b[H'); await pause();
  assert.doesNotMatch(ui.lastFrame() ?? '', /SENSORNAME/);
});

test('small terminals show a resize instruction without losing exit controls', async t => {
  const data = snapshot();
  let closed = 0;
  const actions: TerminalActions = {
    read: () => data, discover: async () => [], selectDevices: async () => {}, activate: () => {}, login: () => {},
  };
  const ui = render(h(TerminalDashboard, {
    actions, onClose: () => { closed++; }, onQuit: () => {}, size: { columns: 40, rows: 15 },
  }));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  await pause();
  assert.match(ui.lastFrame() ?? '', /mindestens 60 Spalten/);
  ui.stdin.write('q'); await pause();
  assert.equal(closed, 1);
});

test('Ink lifecycle restores terminal input while the shared web backend remains available', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-ink-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { startTerminal } from './src/tui.ts';
    import { createRuntime } from './src/runtime.ts';
    import { loadConfig } from './src/config.ts';
    import { logger } from './src/logger.ts';
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperties(process.stdout, {
      isTTY: { value: true }, columns: { value: 100 }, rows: { value: 32 },
    });
    let raw = false;
    process.stdin.setRawMode = value => { raw = value; return process.stdin; };
    const listeners = process.stdin.listenerCount('readable');
    const runtime = createRuntime({ ...loadConfig({
      DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test', DATA_DIR: process.argv[1],
    }), port: 0 });
    try {
      const server = await runtime.listen();
      const terminal = await startTerminal(runtime, () => { throw new Error('Backend must stay alive'); });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(raw, true);
      process.stdin.push('q');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(raw, false);
      terminal.close();
      terminal.close();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(raw, false);
      assert.equal(process.stdin.listenerCount('readable'), listeners);
      const status = await fetch('http://127.0.0.1:' + server.address().port + '/api/status');
      assert.equal(status.status, 200);
      logger.info('INK_CLOSED_BACKEND_ALIVE');
    } finally { await runtime.close(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, directory], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, CI: 'false', FORCE_COLOR: '0' }, timeout: 15_000,
  });
  assert.match(stdout, /INK_CLOSED_BACKEND_ALIVE/);
  assert.match(stdout, /\u001b\[\?1049h/);
  assert.match(stdout, /\u001b\[\?1049l/);
});

test('failed dashboard actions remain visible and logs scroll toward older entries', async t => {
  const data = snapshot();
  const actions: TerminalActions = {
    read: () => data, discover: async () => { throw new Error('Geräte nicht erreichbar'); },
    selectDevices: async () => {}, activate: () => {}, login: () => {},
  };
  const ui = render(h(TerminalDashboard, {
    actions, onClose: () => {}, onQuit: () => {}, size: { columns: 120, rows: 40 },
  }));
  t.after(() => { ui.unmount(); ui.cleanup(); });
  await pause(); await pause();
  ui.stdin.write('d'); await pause();
  assert.match(ui.lastFrame() ?? '', /Geräte nicht erreichbar/);
  for (let index = 0; index < 15; index++) logger.info(`Eintrag-${String(index).padStart(2, '0')}`);
  await pause();
  assert.match(ui.lastFrame() ?? '', /Eintrag-14/);
  assert.doesNotMatch(ui.lastFrame() ?? '', /Eintrag-00/);
  ui.stdin.write('p'); await pause();
  ui.stdin.write('\u001b[A'); await pause();
  assert.doesNotMatch(ui.lastFrame() ?? '', /Eintrag-14/);
  ui.stdin.write('\u001b[H'); await pause();
  assert.match(ui.lastFrame() ?? '', /Eintrag-00/);
  ui.stdin.write('\u001b[F'); await pause();
  assert.match(ui.lastFrame() ?? '', /Eintrag-14/);
});

test('terminal adapter uses shared SQLite data and selects discovered devices by stable key', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-terminal-adapter-'));
  const unsubscribe = logger.subscribe(() => {}, true);
  const runtime = createRuntime(loadConfig({
    DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test', DATA_DIR: directory,
  }));
  t.after(async () => { await runtime.close(); unsubscribe(); rmSync(directory, { recursive: true }); });
  const devices = [
    { installationId: '1', gatewaySerial: '2', deviceId: '0', name: 'Erdgeschoss' },
    { installationId: '1', gatewaySerial: '2', deviceId: '1', name: 'Obergeschoss' },
  ];
  runtime.store.setDevices(devices);
  const now = 1800000000000;
  for (const [index, device] of devices.entries()) {
    runtime.store.saveReadings(device, now, [{ sensor: 'flow', label: 'Vorlauf', kind: 'flow', value: 35 + index }]);
  }
  const data = readTerminalSnapshot(runtime, 24, now);
  assert.equal(data.devices.length, 2);
  assert.equal(data.histories.get(seriesKey(deviceKey(devices[0]!), 'flow'))?.[0]?.value, 35);
  assert.equal(data.histories.get(seriesKey(deviceKey(devices[1]!), 'flow'))?.[0]?.value, 36);
  const actions = terminalActions(runtime);
  actions.activate(deviceKey(devices[1]!));
  assert.deepEqual(runtime.store.getDevice(), devices[1]);
  assert.throws(() => actions.activate('not-selected'), /nicht mehr ausgewählt/);
  await assert.rejects(actions.selectDevices([]), /mindestens ein/);
  await assert.rejects(actions.selectDevices(['invalid']), /Ungültige Geräteauswahl/);
  t.mock.method(runtime.api, 'devices', async () => [...devices].reverse());
  const restart = t.mock.method(runtime.collector, 'restart', async () => {});
  const choices = await actions.discover();
  assert.equal(choices[0]?.key, deviceKey(devices[1]!));
  await actions.selectDevices([deviceKey(devices[0]!)]);
  assert.deepEqual(runtime.store.getDevices(), [devices[0]]);
  assert.equal(restart.mock.callCount(), 1);
});
