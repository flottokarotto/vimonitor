import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import type { ChartDataset } from 'chart.js';
import type { Point } from './types';

export const colors = ['#e6744a', '#279c9d', '#7961b5', '#b08624', '#3277bd', '#c64e83', '#628c3c', '#64748b'];
const number = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const axis = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, signDisplay: 'negative' });
const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

interface ChartPoint { x: number; y: number | null; min?: number; max?: number; count?: number }
export interface Line { label: string; points: Point[]; color: string; dash?: number[]; fill: boolean }

function isChartPoint(value: unknown): value is ChartPoint {
  return typeof value === 'object' && value !== null && 'x' in value && typeof value.x === 'number'
    && 'y' in value && (typeof value.y === 'number' || value.y === null);
}

export function chartPoints(points: Point[], hours: number, pollSeconds: number): ChartPoint[] {
  const bucket = Math.max(300_000, Math.ceil(hours * 3600_000 / 600));
  const data: ChartPoint[] = [];
  let previous: number | undefined;
  for (const point of points) {
    if (previous !== undefined && point.timestamp - previous > Math.max(bucket * 1.5, pollSeconds * 1500)) {
      data.push({ x: previous + bucket, y: null });
    }
    data.push({ x: point.timestamp, y: point.value, min: point.min, max: point.max, count: point.count });
    previous = point.timestamp;
  }
  return data;
}

export function HistoryChart({ id, label, hours, pollSeconds, lines, comparison = false }: {
  id: string; label: string; hours: number; pollSeconds: number; lines: Line[]; comparison?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<Chart<'line', ChartPoint[]> | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const instance = new Chart<'line', ChartPoint[]>(canvas.current, {
      type: 'line', data: { datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: !comparison,
        interaction: { intersect: false, mode: 'nearest', axis: 'x' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#253440', padding: 12, displayColors: comparison,
            callbacks: {
              title: entries => entries[0]?.parsed.x != null ? date.format(entries[0].parsed.x) : '',
              label: context => {
                const point = context.raw;
                if (!isChartPoint(point)) return 'Ungültiger Messpunkt';
                if (point.y === null) return 'Keine Messung';
                const lines = [`${comparison ? `${context.dataset.label}: ` : ''}${number.format(point.y)} °C`];
                if (point.count && point.count > 1 && point.min !== undefined && point.max !== undefined) {
                  lines.push(`Min ${number.format(point.min)} · Max ${number.format(point.max)} °C`, `${point.count} Messungen`);
                }
                return lines;
              },
            },
          },
        },
        scales: {
          x: { type: 'linear', grid: { display: false }, border: { display: false },
            ticks: { maxTicksLimit: 5, maxRotation: 0, color: '#a0a9b2', font: { size: 10 } } },
          y: { grace: '18%', border: { display: false }, grid: { color: '#f0f2f4', drawTicks: false },
            ticks: { precision: 1, maxTicksLimit: 5, padding: 12, color: '#a0a9b2', font: { size: 10 },
              callback: value => `${axis.format(Number(value))}°` } },
        },
      },
    });
    chart.current = instance;
    return () => { instance.destroy(); chart.current = null; };
  }, [comparison]);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    instance.data.datasets = lines.map((line): ChartDataset<'line', ChartPoint[]> => ({
      label: line.label, data: chartPoints(line.points, hours, pollSeconds),
      borderColor: line.color, backgroundColor: `${line.color}12`,
      borderDash: line.dash ?? [], fill: line.fill, tension: 0.22, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4, spanGaps: false,
    }));
    const x = instance.options.scales?.x;
    if (x) {
      const now = Date.now();
      x.min = now - hours * 3600_000;
      x.max = now;
      if (x.ticks) x.ticks.callback = value => hours === 24 ? time.format(Number(value))
        : new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(Number(value));
    }
    instance.update();
  }, [hours, lines, pollSeconds]);
  return <canvas ref={canvas} id={id} role="img" aria-label={label} />;
}
