import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { createTerminalChooser } from './tui.ts';
import { chartSeries } from './tui-model.ts';

function terminal() {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), {
    columns: 80, rows: 24, isTTY: true,
  });
  output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm', warnings: false });
  return { screen, close() { screen.destroy(); input.destroy(); output.destroy(); } };
}

test('terminal chooser scrolls long labels horizontally and the complete list vertically', async t => {
  const { screen, close } = terminal();
  t.after(close);
  const choices = Array.from({ length: 60 }, (_, index) => ({
    key: String(index),
    label: `${'Heizungsname '.repeat(12)}Temperatursensor ${index}`,
    selected: index === 0,
  }));
  let saved: typeof choices = [];
  let closed = 0;
  const chooser = createTerminalChooser(screen, 'Temperaturen', choices,
    async selected => { saved = selected; }, () => { closed++; });
  let selectedIndex = 0;
  chooser.list.on('select item', (_item, index) => { selectedIndex = index; });
  const key = (name: string) => screen.program.emit('keypress', undefined, { name, full: name });
  const visibleText = () => {
    const frame: unknown = screen.screenshot();
    assert.ok(typeof frame === 'string');
    return frame;
  };
  const original = chooser.list.getItem(0).getContent();
  assert.match(original, /^\[x\]/);
  key('right');
  assert.notEqual(chooser.list.getItem(0).getContent(), original);
  for (let index = 0; index < 40; index++) key('right');
  assert.ok(chooser.list.getItem(0).getContent().endsWith('Temperatursensor 0'));
  assert.match(visibleText(), /Temperatursensor 0/);
  for (let index = 0; index < 40; index++) key('left');
  assert.equal(chooser.list.getItem(0).getContent(), original);
  key('pagedown');
  assert.ok(selectedIndex > 0);
  key('end');
  assert.equal(selectedIndex, choices.length - 1);
  assert.ok(chooser.list.getScroll() > 0);
  for (let index = 0; index < 40; index++) key('right');
  assert.match(visibleText(), /Temperatursensor 59/);
  key('space');
  assert.match(chooser.list.getItem(choices.length - 1).getContent(), /^\[x\]/);
  key('s');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved.map(item => item.key), ['0', '59']);
  assert.equal(closed, 1);
  chooser.close();
  assert.equal(closed, 1);
});

test('terminal chart baseline renders without undefined ANSI colors', t => {
  const { screen, close } = terminal();
  t.after(close);
  const chart = contrib.line({
    width: 70, height: 15,
    style: { line: 'cyan', text: 'white', baseline: 'white' },
  });
  screen.append(chart);
  chart.setData([{ title: 'Vorlauf', x: ['10:00', '10:05'], y: [35, 36] }]);
  screen.render();
  assert.doesNotMatch(chart.getContent(), /undefined/);
  assert.match(chart.getContent(), /35|36/);
});

test('terminal time axes render real history labels without null text', t => {
  const { screen, close } = terminal();
  t.after(close);
  const chart = contrib.line({
    width: 70, height: 15,
    style: { line: 'cyan', text: 'white', baseline: 'white' },
  });
  screen.append(chart);
  for (const count of [26, 601]) {
    const points = Array.from({ length: count }, (_, index) => ({
      timestamp: 1800000000000 + index * 300_000,
      value: 35 + index / count,
    }));
    const series = chartSeries('Vorlauf', points);
    chart.setData([series]);
    screen.render();
    assert.doesNotMatch(chart.getContent(), /null|undefined/);
    assert.match(chart.getContent(), /\d{2}:\d{2}/);
  }
});
