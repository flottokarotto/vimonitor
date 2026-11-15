import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAYS, localNightBoundary, parseSchedules, waterScheduledOn } from './schedules.ts';
import type { Schedule, ScheduleSnapshot } from './schedules.ts';
import { buildInsights, evaluateNight } from './insights.ts';
import { Store } from './store.ts';
import { loadConfig } from './config.ts';
import { Collector } from './collector.ts';
import { Viessmann } from './viessmann.ts';

const HOUR = 3600_000;
const STEP = 300_000;
const device = { installationId: 'test', gatewaySerial: 'test', deviceId: '0', name: 'Test' };
const sensor = 'heating.dhw.sensors.temperature.hotWaterStorage:value';
const start = Date.parse('2026-11-14T21:00:00Z');
const end = Date.parse('2026-11-15T04:00:00Z');
function feature(start = '05:00', end = '22:00', mode = 'on', name = 'heating.dhw.schedule') {
  return { feature: name, properties: {
    active: { value: true },
    entries: { value: Object.fromEntries(DAYS.map(day => [day, [{ start, end, mode }]])) },
  } };
}
function schedule(): Schedule {
  const parsed = parseSchedules([feature()])[0];
  assert.ok(parsed);
  return parsed;
}
function snapshots(program = schedule(), from = start, to = end): ScheduleSnapshot[] {
  const result: ScheduleSnapshot[] = [];
  for (let timestamp = from; timestamp <= to; timestamp += STEP) {
    result.push({ timestamp, pollSeconds: 300, schedules: [program], error: null });
  }
  return result;
}
function readings(rate: number, from = start, to = end) {
  const result = [];
  for (let timestamp = from; timestamp <= to; timestamp += STEP) {
    result.push({ timestamp, value: 55 - rate * (timestamp - from) / HOUR });
  }
  return result;
}
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'vimonitor-insights-test-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  store.setDevice(device);
  return { store, directory };
}

test('parses heating/water weekly programs and ignores disabled or unrelated features', () => {
  const parsed = parseSchedules([
    feature(), feature('05:00', '22:30', 'normal', 'heating.circuits.1.heating.schedule'),
    { ...feature(), isEnabled: false },
    { feature: 'heating.dhw.pumps.circulation.schedule' },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]?.label, 'Heizkreis 2');
  assert.equal(parsed[0]?.entries.sun[0]?.end, '22:00');
  assert.equal(parseSchedules([{ ...feature(), isReady: false }]).length, 0);
  const disabled = feature();
  disabled.properties.active.value = false;
  assert.equal(parseSchedules([disabled])[0]?.active, false);
});

test('invalid, missing, overlapping and unknown water schedules are rejected explicitly', () => {
  assert.throws(() => parseSchedules([feature('25:00')]), /Zeiteintrag/);
  assert.throws(() => parseSchedules([feature('22:00', '22:00')]), /Dauer/);
  assert.throws(() => parseSchedules([feature('05:00', '22:00', 'unknown')]), /Betriebsmodus/);
  const missing = feature();
  Reflect.deleteProperty(missing.properties.entries.value, 'sun');
  assert.throws(() => parseSchedules([missing]), /sun fehlt/);
  const overlap = feature();
  overlap.properties.entries.value.mon?.push({ start: '21:00', end: '23:00', mode: 'on' });
  assert.throws(() => parseSchedules([overlap]), /ueberlappende/);
  const midnightOverlap = feature('22:00', '06:00');
  midnightOverlap.properties.entries.value.mon?.push({ start: '05:00', end: '07:00', mode: 'on' });
  assert.throws(() => parseSchedules([midnightOverlap]), /ueberlappende/);
  assert.throws(() => parseSchedules([{ feature: 'heating.dhw.schedule', properties: {} }]));
});

test('water schedules respect local weekdays, midnight, 24:00 and exact boundaries', () => {
  const program = schedule();
  assert.equal(waterScheduledOn(program, Date.parse('2026-11-15T03:59:00Z')), false);
  assert.equal(waterScheduledOn(program, Date.parse('2026-11-15T04:00:00Z')), true);
  assert.equal(waterScheduledOn(program, Date.parse('2026-11-15T21:00:00Z')), false);
  const overnight = parseSchedules([feature('22:00', '05:00')])[0]!;
  assert.equal(waterScheduledOn(overnight, Date.parse('2026-11-15T02:00:00Z')), true);
  assert.equal(waterScheduledOn(overnight, Date.parse('2026-11-15T12:00:00Z')), false);
  const allDay = parseSchedules([feature('00:00', '24:00')])[0]!;
  assert.equal(waterScheduledOn(allDay, Date.parse('2026-11-15T22:59:00Z')), true);
});

test('DST night durations reflect elapsed time, not an assumed seven hours', () => {
  const springStart = Date.parse('2026-03-28T21:00:00Z');
  const springEnd = Date.parse('2026-03-29T03:00:00Z');
  const fallStart = Date.parse('2026-10-24T20:00:00Z');
  const fallEnd = Date.parse('2026-10-25T04:00:00Z');
  assert.equal(localNightBoundary(Date.UTC(2026, 2, 28), 18), Date.parse('2026-03-28T17:00:00Z'));
  assert.equal(localNightBoundary(Date.UTC(2026, 2, 29), 10), Date.parse('2026-03-29T08:00:00Z'));
  for (const [from, to, hours] of [[springStart, springEnd, 6], [fallStart, fallEnd, 8]] as const) {
    assert.equal((to - from) / HOUR, hours);
    const result = evaluateNight({ start: from, end: to, schedule: schedule() }, readings(0.7, from, to), snapshots(schedule(), from, to));
    assert.equal(result.status, 'ok');
    assert.ok(Math.abs((result.rate ?? 0) - 0.7) < 1e-8);
  }
});

test('cooling uses raw timestamps and exact documented orientation thresholds', () => {
  for (const [rate, level] of [[0, 'low'], [0.5, 'low'], [0.5001, 'moderate'], [1.5, 'moderate'], [1.5001, 'high']] as const) {
    const result = evaluateNight({ start, end, schedule: schedule() }, readings(rate), snapshots());
    assert.equal(result.status, 'ok');
    assert.equal(result.level, level);
    assert.ok(Math.abs((result.rate ?? -1) - rate) < 1e-8);
    assert.equal(result.measuredStart, start + 30 * 60_000);
    assert.equal(result.measuredEnd, end - 10 * 60_000);
    assert.ok(Math.abs((result.drop ?? 0) - rate * (7 - 40 / 60)) < 1e-8);
  }
});

test('no historical program assumptions, missing readings or schedule changes are rated', () => {
  const pause = { start, end, schedule: schedule() };
  assert.equal(evaluateNight(pause, readings(1), []).status, 'insufficient');
  assert.equal(evaluateNight(pause, [], snapshots()).rate, null);
  assert.equal(evaluateNight(pause, readings(1).filter((_, index) => index < 20 || index > 30), snapshots()).status, 'insufficient');
  assert.equal(evaluateNight(pause, readings(1), snapshots().filter((_, index) => index < 20 || index > 30)).status, 'insufficient');
  const changed = snapshots();
  const point = changed[20]!;
  point.schedules = [{ ...schedule(), active: false }];
  assert.equal(evaluateNight(pause, readings(1), changed).status, 'schedule-changed');
  point.error = 'API-Format geaendert';
  assert.equal(evaluateNight(pause, readings(1), changed).status, 'insufficient');
});

test('reheating, abrupt draw-off and overall warming do not receive a cooling assessment', () => {
  const pause = { start, end, schedule: schedule() };
  const rising = readings(-0.2);
  assert.equal(evaluateNight(pause, rising, snapshots()).status, 'disturbed');
  const reheated = readings(0.5);
  for (let index = 30; index < reheated.length; index++) reheated[index]!.value += 3;
  assert.equal(evaluateNight(pause, reheated, snapshots()).rate, null);
  const abrupt = readings(0.5);
  for (let index = 30; index < abrupt.length; index++) abrupt[index]!.value -= 4;
  assert.equal(evaluateNight(pause, abrupt, snapshots()).status, 'disturbed');
});

test('snapshots persist per device and cannot be applied retrospectively', t => {
  const { store, directory } = fixture(t);
  const now = Date.parse('2026-11-15T10:00:00Z');
  store.saveSchedules(device, { timestamp: now, pollSeconds: 300, schedules: [schedule()], error: null });
  for (const point of readings(0.7)) store.saveReadings(device, point.timestamp, [{ sensor, label: 'Water', kind: 'water', value: point.value }]);
  const result = buildInsights(store, device, now);
  assert.equal(result.lastNight?.status, 'insufficient');
  assert.equal(result.lastNight?.rate, null);
  assert.equal(result.comparison, null);
  const reopened = new Store(directory);
  assert.equal(reopened.scheduleSnapshots(device, 0, now).length, 1);
  assert.equal(reopened.scheduleSnapshots({ ...device, deviceId: 'other' }, 0, now).length, 0);
  reopened.close();
});

test('automatic last-night selection and personal median comparison require three suitable nights', t => {
  const { store } = fixture(t);
  const now = Date.parse('2026-11-15T10:00:00Z');
  for (let day = 0; day < 5; day++) {
    const from = start - day * 24 * HOUR;
    const to = end - day * 24 * HOUR;
    for (const snapshot of snapshots(schedule(), from, to)) store.saveSchedules(device, snapshot);
    for (const point of readings(day === 0 ? 1.3 : 0.7, from, to)) {
      store.saveReadings(device, point.timestamp, [{ sensor, label: 'Water', kind: 'water', value: point.value }]);
    }
  }
  store.saveSchedules(device, { timestamp: now, pollSeconds: 300, schedules: [schedule()], error: null });
  const result = buildInsights(store, device, now);
  assert.equal(result.lastNight?.status, 'ok');
  assert.equal(result.lastNight?.start, start);
  assert.equal(result.lastNight?.level, 'moderate');
  assert.equal(result.comparison?.nights, 4);
  assert.equal(result.comparison?.trend, 'faster');
  assert.ok(Math.abs((result.comparison?.medianRate ?? 0) - 0.7) < 1e-8);
  assert.equal(result.timeZone, 'Europe/Berlin');
});

test('missing, disabled, stale and all-day programs produce explanations, never a diagnosis', t => {
  const { store } = fixture(t);
  const now = Date.parse('2026-11-15T10:00:00Z');
  assert.match(buildInsights(store, undefined, now).message, /verbinden/);
  store.saveSchedules(device, { timestamp: now, pollSeconds: 300, schedules: [], error: null });
  assert.match(buildInsights(store, device, now).message, /kein auswertbares/);
  store.saveSchedules(device, { timestamp: now, pollSeconds: 300, schedules: [{ ...schedule(), active: false }], error: null });
  assert.match(buildInsights(store, device, now).message, /nicht aktiv/);
  assert.equal(buildInsights(store, device, now + HOUR).stale, true);
  store.saveReadings(device, now, [{ sensor, label: 'Water', kind: 'water', value: 50 }]);
  store.saveSchedules(device, { timestamp: now, pollSeconds: 300, schedules: parseSchedules([feature('00:00', '24:00')]), error: null });
  assert.equal(buildInsights(store, device, now).lastNight, null);
  assert.match(buildInsights(store, device, now).message, /keine abgeschlossene/);
});

test('collector records schedules alongside temperatures from the same API request', async t => {
  const { store, directory } = fixture(t);
  const config = loadConfig({ DEMO_MODE: 'false', VIESSMANN_CLIENT_ID: 'test', DATA_DIR: directory });
  store.saveSecret({ accessToken: 'test', refreshToken: 'test', expiresAt: Date.now() + HOUR });
  let requests = 0;
  let invalid = false;
  const api = new Viessmann(config, store, async () => {
    requests++;
    return Response.json({ data: [
      { feature: 'heating.dhw.sensors.temperature.hotWaterStorage', properties: { value: { value: 50, unit: 'celsius' } } },
      feature('05:00', '22:00', invalid ? 'unknown' : 'on'),
    ] });
  });
  let now = start;
  const collector = new Collector(config, store, api, () => now);
  t.after(() => collector.stop());
  await collector.start();
  assert.equal(requests, 1);
  assert.equal(store.scheduleSnapshots(device, 0, now)[0]?.schedules.length, 1);
  assert.equal(store.sensors(device).length, 1);
  invalid = true;
  now += STEP;
  await collector.restart();
  const snapshot = store.scheduleSnapshots(device, 0, now).at(-1);
  assert.match(snapshot?.error ?? '', /unbekannter Betriebsmodus/);
  assert.equal(snapshot?.schedules.length, 0);
  assert.equal(store.readings(device, sensor, start, now).length, 2);
});

test('new demo data exercises a complete cooling assessment and personal baseline', async t => {
  const { directory } = fixture(t);
  const store = new Store(directory, true);
  const config = loadConfig({ DATA_DIR: directory });
  const now = Date.parse('2026-11-15T10:00:00Z');
  const collector = new Collector(config, store, new Viessmann(config, store), () => now);
  try {
    await collector.start();
    const result = buildInsights(store, store.getDevice(), now);
    assert.equal(result.lastNight?.status, 'ok');
    assert.ok(Math.abs((result.lastNight?.rate ?? 0) - 0.7) < 1e-8);
    assert.equal(result.lastNight?.level, 'moderate');
    assert.ok((result.comparison?.nights ?? 0) >= 3);
    assert.equal(result.comparison?.trend, 'similar');
  } finally { collector.stop(); store.close(); }
});
