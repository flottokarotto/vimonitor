type Level = 'INFO' | 'OK' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: Level;
  message: string;
}

interface Sink {
  write(entry: LogEntry): void;
  suppressOutput: boolean;
}

const colors: Record<Level, string> = {
  INFO: '\u001b[36m',
  OK: '\u001b[32m',
  WARN: '\u001b[33m',
  ERROR: '\u001b[31m',
};
const reset = '\u001b[0m';
const timestamp = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});
const sinks = new Set<Sink>();

function write(level: Level, message: string, error = false) {
  const entry = { timestamp: timestamp.format(new Date()), level, message };
  for (const sink of sinks) sink.write(entry);
  if ([...sinks].some(sink => sink.suppressOutput)) return;
  const stream = error ? process.stderr : process.stdout;
  const label = `[${level}]`;
  const color = process.env.NO_COLOR === undefined && (stream.isTTY || process.env.FORCE_COLOR)
    ? colors[level] : '';
  const prefix = color ? `${color}${label}${reset}` : label;
  stream.write(`${entry.timestamp} ${prefix} ${message}\n`);
}

export const logger = {
  subscribe(writeEntry: Sink['write'], suppressOutput = false) {
    const sink = { write: writeEntry, suppressOutput };
    sinks.add(sink);
    return () => sinks.delete(sink);
  },
  info: (message: string) => write('INFO', message),
  success: (message: string) => write('OK', message),
  warn: (message: string) => write('WARN', message, true),
  error: (message: string) => write('ERROR', message, true),
};
