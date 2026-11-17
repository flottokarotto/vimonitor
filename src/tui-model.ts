export interface TerminalPoint {
  timestamp: number;
  value: number;
}

export interface TerminalSeries {
  title: string;
  x: string[];
  y: number[];
}

export function chartSeries(title: string, points: TerminalPoint[], maxPoints = 48): TerminalSeries {
  if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new RangeError('maxPoints muss mindestens 2 sein.');
  if (points.length <= maxPoints) {
    return {
      title,
      x: points.map((point, index) => index % 8 === 0 ? new Date(point.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''),
      y: points.map(point => point.value),
    };
  }
  const bucketSize = Math.ceil(points.length / maxPoints);
  const sampled: TerminalPoint[] = [];
  for (let offset = 0; offset < points.length; offset += bucketSize) {
    const bucket = points.slice(offset, offset + bucketSize);
    const last = bucket.at(-1);
    if (!last) continue;
    sampled.push({
      timestamp: last.timestamp,
      value: bucket.reduce((sum, point) => sum + point.value, 0) / bucket.length,
    });
  }
  return {
    title,
    x: sampled.map((point, index) => index % 6 === 0 ? new Date(point.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''),
    y: sampled.map(point => point.value),
  };
}

export function terminalLog(entry: { timestamp: string; level: string; message: string }): string {
  const level = entry.level === 'ERROR' ? '{red-fg}'
    : entry.level === 'WARN' ? '{yellow-fg}'
      : entry.level === 'OK' ? '{green-fg}' : '{cyan-fg}';
  return `${entry.timestamp} ${level}[${entry.level}]{/} ${entry.message}`;
}
