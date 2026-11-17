import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartSeries, terminalLog } from './tui-model.ts';

test('terminal chart series preserve values and bound rendered samples', () => {
  const points = Array.from({ length: 601 }, (_, index) => ({
    timestamp: 1800000000000 + index * 300_000,
    value: 30 + index / 10,
  }));
  const series = chartSeries('Vorlauf', points, 48);
  assert.equal(series.title, 'Vorlauf');
  assert.equal(series.x.length, series.y.length);
  assert.ok(series.y.length <= 48);
  assert.ok(Math.abs((series.y[0] ?? 0) - 30.6) < 1e-10);
  assert.ok(Math.abs((series.y.at(-1) ?? 0) - 89.9) < 1e-10);
});

test('terminal chart rejects a non-useful point limit', () => {
  assert.throws(() => chartSeries('Vorlauf', [], 1), RangeError);
});

test('terminal logs color the level without changing message details', () => {
  assert.equal(terminalLog({ timestamp: '2026-11-17 20:25:00 CET', level: 'ERROR', message: 'Gerät offline' }),
    '2026-11-17 20:25:00 CET {red-fg}[ERROR]{/} Gerät offline');
});
