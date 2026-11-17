import { plot } from 'asciichart';
import type { Temperature } from './model.ts';
import type { buildInsights } from './insights.ts';
import type { LogEntry } from './logger.ts';

export const terminalColors = ['cyan', 'yellow', 'green', 'magenta', 'blueBright', 'red', 'white', 'yellowBright'] as const;
export const periods = [24, 168, 720] as const;
export const periodLabels = ['24 Stunden', '7 Tage', '30 Tage'] as const;

export interface TerminalPoint { timestamp: number; value: number }
export interface TerminalSensor extends Temperature { timestamp: number }
export interface TerminalDevice { id: string; name: string; sensors: TerminalSensor[] }
export interface TerminalSeries {
  key: string;
  title: string;
  points: TerminalPoint[];
}
export interface TerminalSnapshot {
  demo: boolean;
  connected: boolean;
  devices: TerminalDevice[];
  activeDevice: string | null;
  error: string | null;
  collecting: boolean;
  nextPollAt: number | null;
  pollSeconds: number;
  from: number;
  to: number;
  histories: Map<string, TerminalPoint[]>;
  insights: ReturnType<typeof buildInsights>;
}

export const seriesKey = (device: string, sensor: string) => JSON.stringify([device, sensor]);
export const terminalLog = (entry: LogEntry) => `${entry.timestamp} [${entry.level}] ${entry.message}`;
export const logColor = (level: LogEntry['level']) => level === 'ERROR' ? 'red'
  : level === 'WARN' ? 'yellow' : level === 'OK' ? 'green' : 'cyan';

export function wrapTerminalText(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  return text.split('\n').flatMap(line => {
    const characters = Array.from(line);
    if (!characters.length) return [''];
    const result: string[] = [];
    for (let index = 0; index < characters.length; index += columns) {
      result.push(characters.slice(index, index + columns).join(''));
    }
    return result;
  });
}

export interface ChartRun { text: string; color: string }

export function terminalChart(
  series: TerminalSeries[], width: number, height: number, from: number, to: number, pollSeconds: number,
): ChartRun[][] {
  if (!Number.isInteger(width) || width < 12 || !Number.isInteger(height) || height < 2
    || !Number.isFinite(from) || !Number.isFinite(to) || to <= from
    || !Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new RangeError('Ungueltige Terminal-Chartabmessungen oder Zeitbasis.');
  }
  const columns = width - 8;
  const values = series.flatMap(item => item.points)
    .filter(point => point.timestamp >= from && point.timestamp <= to && Number.isFinite(point.value));
  if (!values.length) return [[{ text: 'Keine Messwerte'.slice(0, width), color: 'gray' }]];
  let min = Infinity;
  let max = -Infinity;
  for (const point of values) { min = Math.min(min, point.value); max = Math.max(max, point.value); }
  const padding = Math.max(0.5, (max - min) * 0.1);
  min = Math.floor(min - padding);
  max = Math.ceil(max + padding);
  const config = {
    min, max, height: Math.max(1, height - 2), offset: 2,
    format: (value: number) => value.toFixed(1).padStart(7),
  };
  const axis = plot([min, max], config).split('\n');
  const grid = axis.map(line => Array.from({ length: width }, (_, index) => ({
    text: index < 8 ? (line[index] ?? ' ') : ' ', color: 'gray' as string,
  })));
  series.forEach((item, seriesIndex) => {
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const point of item.points) {
      if (point.timestamp < from || point.timestamp > to || !Number.isFinite(point.value)) continue;
      const column = Math.min(columns - 1, Math.floor((point.timestamp - from) / (to - from) * columns));
      const bucket = buckets.get(column);
      if (bucket) {
        bucket.sum += point.value; bucket.count++;
      } else buckets.set(column, { sum: point.value, count: 1 });
    }
    const segment: number[] = [];
    let start = 0;
    let previousColumn = -1;
    let previousValue = 0;
    for (const [column, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
      const value = bucket.sum / bucket.count;
      if (!segment.length) {
        start = column;
      } else {
        for (let gap = previousColumn + 1; gap < column; gap++) {
          segment.push(previousValue + (value - previousValue) * (gap - previousColumn) / (column - previousColumn));
        }
      }
      segment.push(value);
      previousColumn = column;
      previousValue = value;
    }
    if (!segment.length) return;
    const lines = plot(segment, config).split('\n');
    lines.forEach((line, row) => {
      for (let index = 0; index < segment.length; index++) {
        const glyph = line[7 + index];
        const cell = grid[row]?.[8 + start + index];
        if (cell && glyph && glyph !== ' ' && glyph !== '┤') {
          cell.text = glyph;
          cell.color = terminalColors[seriesIndex % terminalColors.length]!;
        }
      }
    });
  });
  return grid.map(row => {
    const runs: ChartRun[] = [];
    for (const cell of row) {
      const last = runs.at(-1);
      if (last?.color === cell.color) last.text += cell.text;
      else runs.push({ ...cell });
    }
    return runs;
  });
}
