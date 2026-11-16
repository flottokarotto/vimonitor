import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { chartPoints } from './chart';
import { InsightCards } from './insights';
import type { Insights } from './types';

const insight: Insights = {
  timeZone: 'Europe/Berlin', observedAt: 1800000000000, stale: false,
  schedules: [{ feature: 'heating.dhw.schedule', label: 'Warmwasser', kind: 'water', active: true,
    entries: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } }],
  message: 'Test', sensor: 'water', comparison: null, comparableNights: 0,
  orientation: { lowMax: 0.5, moderateMax: 1.5 },
  lastNight: { start: 1800000000000, end: 1800025200000, status: 'ok', reason: 'ok',
    measuredStart: 1800001800000, measuredEnd: 1800024600000, startTemperature: 52,
    endTemperature: 48, drop: 4, rate: 0.63, level: 'moderate' },
};

test('React insight card renders measured cooling and weekly schedule', () => {
  const html = renderToStaticMarkup(<InsightCards data={insight} error={null}/>);
  assert.match(html, /Mittlerer Temperaturabfall/);
  assert.match(html, /0,6/);
  assert.match(html, /4,0/);
  assert.match(html, /Warmwasser/);
  assert.match(html, /Montag/);
  assert.match(html, /keine Diagnose/);
});

test('React insight error does not retain previous assessment or schedule', () => {
  const html = renderToStaticMarkup(<InsightCards data={null} error="Testfehler"/>);
  assert.match(html, /Ladefehler/);
  assert.match(html, /Testfehler/);
  assert.match(html, /id="cooling-values"[^>]*hidden/);
  assert.doesNotMatch(html, /Mittlerer Temperaturabfall/);
  assert.doesNotMatch(html, /schedule-week-table/);
});

test('chart data marks missing polling intervals while preserving measurement extrema', () => {
  const points = [
    { timestamp: 0, value: 42, min: 41, max: 43, count: 2 },
    { timestamp: 1_200_000, value: 40, min: 40, max: 40, count: 1 },
  ];
  assert.deepEqual(chartPoints(points, 24, 300), [
    { x: 0, y: 42, min: 41, max: 43, count: 2 },
    { x: 300_000, y: null },
    { x: 1_200_000, y: 40, min: 40, max: 40, count: 1 },
  ]);
});
