import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalChart, terminalLog, wrapTerminalText } from './tui-model.ts';

const text = (chart: ReturnType<typeof terminalChart>) => chart.map(row => row.map(run => run.text).join(''));

test('terminal charts fit exact bounds, include negative and constant values and handle empty data', () => {
  for (const width of [25, 60, 120]) {
    for (const height of [2, 6, 20]) {
      for (const values of [[-5, 0, 5], [42, 42, 42], [0, 0, 0]]) {
        const series = [{ key: 'flow', title: 'Vorlauf', points: values.map((value, index) => ({ timestamp: index * 300_000, value })) }];
        const chart = text(terminalChart(series, width, height, 0, 600_000, 300));
        assert.ok(chart.length <= height);
        assert.ok(chart.every(line => Array.from(line).length <= width));
        assert.doesNotMatch(chart.join('\n'), /null|undefined|NaN|Infinity/);
        assert.match(chart.join('\n'), /\d+\.\d/);
      }
    }
  }
  assert.match(text(terminalChart([], 40, 10, 0, 1000, 300)).join(''), /Keine Messwerte/);
  assert.throws(() => terminalChart([], 5, 10, 0, 1000, 300), RangeError);
  const isolated = terminalChart([{ key: 'one', title: 'Vorlauf', points: [{ timestamp: 0, value: 35 }] }],
    40, 6, 0, 1000, 300);
  assert.ok(isolated.some(row => row.some(run => run.color === 'cyan' && run.text === '┼')));
  for (const row of isolated) {
    assert.match(row.map(run => run.text).join(''), /^ {0,5}\d+\.\d[┤┼]/);
    for (const run of row.filter(run => run.color !== 'gray')) assert.doesNotMatch(run.text, /\d/);
  }
  const small = text(terminalChart([{ key: 'one', title: 'Vorlauf', points: [{ timestamp: 0, value: 35 }] }],
    40, 2, 0, 1000, 300));
  assert.match(small.join('\n'), /36\.0/);
  assert.match(small.join('\n'), /34\.0/);
});

test('comparison charts align timestamps on a common axis and leave polling gaps empty', () => {
  const rows = terminalChart([
    { key: 'flow', title: 'Vorlauf', points: [{ timestamp: 0, value: 30 }, { timestamp: 300_000, value: 32 }] },
    { key: 'water', title: 'Warmwasser', points: [{ timestamp: 3_300_000, value: 50 }, { timestamp: 3_600_000, value: 52 }] },
  ], 80, 10, 0, 3_600_000, 300);
  const lines = text(rows);
  assert.ok(lines.every(line => line.slice(30, 55).trim() === ''));
  assert.ok(rows.some(row => row.some(run => run.color === 'cyan')));
  assert.ok(rows.some(row => row.some(run => run.color === 'yellow')));
  const continuous = text(terminalChart([
    { key: 'flow', title: 'Vorlauf', points: [{ timestamp: 0, value: 30 }, { timestamp: 300_000, value: 32 }] },
  ], 80, 10, 0, 300_000, 300));
  assert.ok(continuous.some(line => line.slice(35, 40).trim().length > 0));
});

test('text wrapping preserves the complete name and log formatting has no Blessed markup', () => {
  const label = 'Langer Heizungsname · Warmwassersensor im Speicher';
  const lines = wrapTerminalText(label, 15);
  assert.equal(lines.join(''), label);
  assert.ok(lines.every(line => line.length <= 15));
  assert.equal(terminalLog({ timestamp: '2026-11-17 20:25:00 CET', level: 'ERROR', message: 'Gerät offline' }),
    '2026-11-17 20:25:00 CET [ERROR] Gerät offline');
});
