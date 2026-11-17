import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { TerminalActions } from './tui.ts';
import { logger, type LogEntry } from './logger.ts';
import {
  logColor, periodLabels, periods, seriesKey, terminalChart, terminalColors, terminalLog, wrapTerminalText,
} from './tui-model.ts';
import type { TerminalSeries, TerminalSnapshot } from './tui-model.ts';

const number = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
type Size = { columns: number; rows: number };
type Choice = { key: string; label: string; selected: boolean };
type Focus = 'dashboard' | 'legend' | 'logs' | 'insights';
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

function useTerminalSize(override?: Size): Size {
  const { stdout } = useStdout();
  const read = useCallback(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }), [stdout]);
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = () => setSize(read());
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout, read]);
  return override ?? size;
}

function Panel({ title, width, height, active = false, children }: {
  title: string; width: number; height: number; active?: boolean; children?: ReactNode;
}) {
  return h(Box, { width, height, flexDirection: 'column', borderStyle: 'round',
    borderColor: active ? 'yellow' : 'cyan', overflow: 'hidden', flexShrink: 0 },
  h(Text, { bold: true, wrap: 'truncate-end' }, title), children);
}

export function TerminalChart({ title, series, width, height, snapshot }: {
  title: string; series: TerminalSeries[]; width: number; height: number;
  snapshot: Pick<TerminalSnapshot, 'from' | 'to' | 'pollSeconds'>;
}) {
  const chart = useMemo(() => terminalChart(series, Math.max(12, width - 2), Math.max(2, height - 4),
    snapshot.from, snapshot.to, snapshot.pollSeconds), [series, width, height, snapshot]);
  const format = snapshot.to - snapshot.from > 86400_000
    ? new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : time;
  const from = format.format(snapshot.from);
  const to = format.format(snapshot.to);
  const label = `${from}${' '.repeat(Math.max(1, width - 2 - from.length - to.length))}${to}`;
  return h(Panel, { title, width, height },
    ...chart.map((runs, index) => h(Text, { key: index, wrap: 'truncate-end' },
      ...runs.map((run, runIndex) => h(Text, { key: runIndex, color: run.color }, run.text)))),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, label));
}

export function TerminalChooser({ title, choices, size, onSave, onClose }: {
  title: string; choices: Choice[]; size: Size;
  onSave: (keys: string[]) => Promise<void>; onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => new Set(choices.filter(item => item.selected).map(item => item.key)));
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const count = Math.max(1, size.rows - 9);
  const start = Math.floor(index / count) * count;
  const width = Math.max(1, size.columns - 9);
  const maxOffset = Math.max(0, ...choices.map(item => Array.from(item.label).length - width));
  const horizontal = Math.min(offset, maxOffset);
  useInput((input, key) => {
    if (key.escape && !savingRef.current) { onClose(); return; }
    if (savingRef.current) return;
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
      setIndex(previous => Math.max(0, Math.min(choices.length - 1, key.home ? 0 : key.end ? choices.length - 1
        : previous + (key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -count : count))));
    } else if (key.leftArrow || key.rightArrow) {
      setOffset(Math.max(0, Math.min(maxOffset, horizontal + (key.leftArrow ? -8 : 8))));
    } else if (key.return || input === ' ') {
      const item = choices[index];
      if (item) setSelected(previous => {
        const next = new Set(previous);
        if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
        return next;
      });
    } else if (input === 's') {
      savingRef.current = true;
      setSaving(true); setError('');
      void onSave(choices.filter(item => selected.has(item.key)).map(item => item.key)).then(() => {
        if (mounted.current) onClose();
      }).catch(failure => {
        logger.error(`Auswahl konnte nicht gespeichert werden: ${detail(failure)}`);
        if (mounted.current) setError(detail(failure));
      }).finally(() => {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
      });
    }
  });
  return h(Panel, { title, width: size.columns, height: size.rows },
    h(Text, null, '↑/↓ Bild auf/ab: Liste · ←/→: lange Namen · Enter/Leertaste: Auswahl'),
    h(Text, null, 's: speichern · Esc: schließen'),
    h(Box, { flexDirection: 'column', height: count },
      choices.length ? choices.slice(start, start + count).map((item, row) =>
        h(Text, { key: item.key, inverse: start + row === index, wrap: 'truncate-end' },
          `${selected.has(item.key) ? '[x]' : '[ ]'} ${horizontal ? '‹' : ' '}${Array.from(item.label).slice(horizontal).join('')}`))
        : h(Text, { dimColor: true }, 'Keine Einträge verfügbar.')),
    h(Text, { dimColor: true }, `${choices.length ? index + 1 : 0}/${choices.length} · ${selected.size} ausgewählt · Spalte ${horizontal + 1}`),
    h(Text, { color: error ? 'red' : 'yellow', wrap: 'truncate-end' }, error || (saving ? 'Wird gespeichert …' : '')));
}

function insightLines(snapshot: TerminalSnapshot): string[] {
  const insights = snapshot.insights;
  const night = insights.lastNight;
  const result = [
    `${insights.stale ? 'Veraltete Daten · ' : ''}${insights.timeZone}`,
    night?.status === 'ok' && night.rate !== null
      ? `Letzte Pause: ${number.format(night.rate)} °C/h · ${night.drop === null ? '—' : number.format(night.drop)} °C Abfall (${night.startTemperature ?? '—'} → ${night.endTemperature ?? '—'} °C)`
      : insights.message,
    'Zeitprogramme heute:',
  ];
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: insights.timeZone }).format(snapshot.to).toLowerCase();
  for (const schedule of insights.schedules) {
    const day = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).find(item => item === today);
    const entries = day ? schedule.entries[day] : [];
    result.push(`${schedule.label}${schedule.active ? '' : ' (inaktiv)'}: ${entries.length
      ? entries.map(entry => `${entry.start}-${entry.end} ${entry.mode}`).join(', ') : 'keine Zeitfenster'}`);
  }
  result.push('Temperaturverlauf ist eine Orientierung, keine Diagnose.');
  return result;
}

export function TerminalDashboard({ actions, onClose, onQuit, size: override }: {
  actions: TerminalActions; onClose: () => void; onQuit: () => void; size?: Size;
}): ReactElement {
  const size = useTerminalSize(override);
  const [hours, setHours] = useState<typeof periods[number]>(24);
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [comparison, setComparison] = useState<Set<string>>(new Set());
  const initialized = useRef(new Set<string>());
  const [flow, setFlow] = useState('');
  const [water, setWater] = useState('');
  const [focus, setFocus] = useState<Focus>('dashboard');
  const [scroll, setScroll] = useState({ legend: 0, logs: 0, insights: 0 });
  const [chooser, setChooser] = useState<{ title: string; choices: Choice[]; save(keys: string[]): Promise<void> } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(() => {
    try { setSnapshot(actions.read(hours)); setError(''); }
    catch (failure) { setError(detail(failure)); logger.error(`Terminal-Aktualisierung fehlgeschlagen: ${detail(failure)}`); }
  }, [actions, hours]);
  useEffect(() => {
    const unsubscribe = logger.subscribe(entry => setEntries(previous => [...previous.slice(-499), entry]), true);
    return () => { unsubscribe(); };
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    timer.unref();
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!snapshot) return;
    setComparison(previous => {
      const available = new Set(snapshot.devices.flatMap(device => device.sensors.map(sensor => seriesKey(device.id, sensor.sensor))));
      const next = new Set([...previous].filter(key => available.has(key)));
      for (const device of snapshot.devices) {
        if (initialized.current.has(device.id) || !device.sensors.length) continue;
        for (const kind of ['flow', 'water'] as const) {
          const sensor = device.sensors.find(item => item.kind === kind);
          if (sensor) next.add(seriesKey(device.id, sensor.sensor));
        }
        initialized.current.add(device.id);
      }
      return next;
    });
  }, [snapshot]);
  const allSeries = snapshot?.devices.flatMap(device => device.sensors.map(sensor => ({
    ...sensor, device: device.id, key: seriesKey(device.id, sensor.sensor),
    title: snapshot.devices.length > 1 ? `${device.name} · ${sensor.label}` : sensor.label,
    points: snapshot.histories.get(seriesKey(device.id, sensor.sensor)) ?? [],
  }))) ?? [];
  const selected = allSeries.filter(item => comparison.has(item.key));
  const active = snapshot?.devices.find(device => device.id === snapshot.activeDevice);
  const flowSensor = active?.sensors.find(sensor => sensor.sensor === flow) ?? active?.sensors.find(sensor => sensor.kind === 'flow');
  const waterSensor = active?.sensors.find(sensor => sensor.sensor === water) ?? active?.sensors.find(sensor => sensor.kind === 'water');
  const run = (action: () => void | Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    void Promise.resolve().then(action).then(() => {
      if (mounted.current) refresh();
    }).catch(failure => {
      logger.error(detail(failure));
      if (mounted.current) setError(detail(failure));
    }).finally(() => {
      busy.current = false;
    });
  };
  const footerHeight = Math.min(8, Math.max(5, Math.floor(size.rows * 0.16)));
  const chartHeight = Math.max(6, Math.floor((size.rows - 7 - footerHeight) / 2));
  const lowerHeight = Math.max(6, size.rows - 7 - footerHeight - chartHeight);
  const half = Math.floor(size.columns / 2);
  const chartWidth = Math.floor(size.columns * 0.65);
  const legendWidth = size.columns - chartWidth;
  const legendLines = selected.flatMap((item, index) => wrapTerminalText(`${index + 1}. ${item.title}`, legendWidth - 2)
    .map(text => ({ text, color: terminalColors[index % terminalColors.length]! })));
  const logLines = entries.flatMap(entry => wrapTerminalText(terminalLog(entry), size.columns - half - 2)
    .map(text => ({ text, color: logColor(entry.level) })));
  const insights = snapshot ? insightLines(snapshot).flatMap(line => wrapTerminalText(line, half - 2)) : [];
  const legendRows = Math.max(1, lowerHeight - 3);
  const footerRows = footerHeight - 3;
  const maxScroll = {
    legend: Math.max(0, legendLines.length - legendRows),
    logs: Math.max(0, logLines.length - footerRows),
    insights: Math.max(0, insights.length - footerRows),
  };
  const logOffset = Math.min(scroll.logs, maxScroll.logs);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onQuit(); return; }
    if (chooser) return;
    if (input === 'q') { onClose(); return; }
    if (key.escape) { setFocus('dashboard'); return; }
    if (input === 'g' || input === 'p' || input === 'i') {
      setFocus(input === 'g' ? 'legend' : input === 'p' ? 'logs' : 'insights'); return;
    }
    if (focus !== 'dashboard' && (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end)) {
      const area = focus;
      const page = area === 'legend' ? legendRows : footerRows;
      setScroll(previous => {
        const current = Math.min(previous[area], maxScroll[area]);
        const direction = (key.upArrow || key.pageUp ? -1 : 1) * (area === 'logs' ? -1 : 1);
        return { ...previous, [area]: key.home ? (area === 'logs' ? maxScroll.logs : 0)
          : key.end ? (area === 'logs' ? 0 : maxScroll[area])
          : Math.max(0, Math.min(maxScroll[area], current + direction * (key.pageUp || key.pageDown ? page : 1))) };
      });
      return;
    }
    if (input === 'r') refresh();
    else if (input === '1' || input === '2' || input === '3') setHours(periods[Number(input) - 1]!);
    else if (input === 'a' || input === 'A') {
      const devices = snapshot?.devices ?? [];
      const index = devices.findIndex(device => device.id === active?.id);
      const device = devices[(index + (input === 'A' ? -1 : 1) + devices.length) % devices.length];
      if (device) run(() => actions.activate(device.id));
    } else if (input === 'f' || input === 'w') {
      const kind = input === 'f' ? 'flow' : 'water';
      const sensors = [...(active?.sensors.filter(sensor => sensor.kind === kind) ?? []),
        ...(active?.sensors.filter(sensor => sensor.kind !== kind) ?? [])];
      const index = sensors.findIndex(sensor => sensor.sensor === (kind === 'flow' ? flowSensor?.sensor : waterSensor?.sensor));
      const sensor = sensors[(index + 1) % sensors.length];
      if (sensor) (kind === 'flow' ? setFlow : setWater)(sensor.sensor);
    } else if (input === 'c') {
      setChooser({ title: 'Temperaturen vergleichen', choices: allSeries.map(item => ({
        key: item.key, label: item.title, selected: comparison.has(item.key),
      })), save: async keys => { setComparison(new Set(keys)); } });
    } else if (input === 'd') {
      run(async () => {
        const choices = await actions.discover();
        if (mounted.current) setChooser({ title: 'Heizgeräte für die Erfassung', choices,
          save: async keys => { try { await actions.selectDevices(keys); } finally { if (mounted.current) refresh(); } } });
      });
    } else if (input === 'l') run(actions.login);
  });
  if (chooser) return h(TerminalChooser, { ...chooser, size, onSave: chooser.save, onClose: () => setChooser(null) });
  if (size.columns < 60 || size.rows < 24) return h(Text, { color: 'yellow' },
    'ViMonitor benötigt mindestens 60 Spalten und 24 Zeilen. Terminal vergrößern. q: TUI schließen · Strg+C: alles beenden');
  const chartSeries = (sensor: typeof flowSensor): TerminalSeries[] => sensor && active ? [{
    key: seriesKey(active.id, sensor.sensor), title: sensor.label,
    points: snapshot?.histories.get(seriesKey(active.id, sensor.sensor)) ?? [],
  }] : [];
  const connection = snapshot?.error ? `FEHLER: ${snapshot.error}` : snapshot?.demo ? 'DEMO'
    : snapshot?.connected ? 'VERBUNDEN' : 'NICHT VERBUNDEN';
  return h(Box, { width: size.columns, height: size.rows, flexDirection: 'column', overflow: 'hidden' },
    h(Text, { bold: true }, 'ViMonitor · Ink/React'),
    h(Text, { wrap: 'truncate-end' }, 'q TUI zu · Strg+C Ende · r Neu · 1/2/3 Zeitraum · a Heizung · d Geräte · c Vergleich'),
    h(Text, { wrap: 'truncate-end' }, 'f/w Sensor · l Login · g Legende · p Protokoll · i Auswertung · Esc zurück · ↑/↓ Bild auf/ab'),
    h(Panel, { title: `Status · ${periodLabels[periods.indexOf(hours)]} · ${active?.name ?? 'Keine Heizung ausgewählt'}`, width: size.columns, height: 4 },
      h(Text, { color: snapshot?.error || error ? 'red' : snapshot?.connected ? 'green' : 'yellow', wrap: 'truncate-end' },
        `${error || connection} · ${snapshot?.collecting ? 'Messabfrage läuft' : 'Erfassung bereit'} · Nächste Abfrage: ${snapshot?.nextPollAt ? time.format(snapshot.nextPollAt) : 'nicht geplant'}`)),
    snapshot ? h(Box, { height: chartHeight, flexShrink: 0 },
      h(TerminalChart, { title: `Vorlauf · ${flowSensor?.label ?? 'Kein Sensor'}${flowSensor ? ` · ${number.format(flowSensor.value)} °C` : ''}`,
        series: chartSeries(flowSensor), width: half, height: chartHeight, snapshot }),
      h(TerminalChart, { title: `Warmwasser · ${waterSensor?.label ?? 'Kein Sensor'}${waterSensor ? ` · ${number.format(waterSensor.value)} °C` : ''}`,
        series: chartSeries(waterSensor), width: size.columns - half, height: chartHeight, snapshot })) : h(Text, null, 'Daten werden geladen …'),
    snapshot ? h(Box, { height: lowerHeight, flexShrink: 0 },
      h(TerminalChart, { title: 'Temperaturvergleich · °C', series: selected, width: chartWidth, height: lowerHeight, snapshot }),
      h(Panel, { title: `Legende · g · ${Math.min(scroll.legend, maxScroll.legend) + 1}/${maxScroll.legend + 1}`, width: legendWidth, height: lowerHeight, active: focus === 'legend' },
        ...legendLines.slice(Math.min(scroll.legend, maxScroll.legend), Math.min(scroll.legend, maxScroll.legend) + legendRows)
          .map((line, index) => h(Text, { key: index, color: line.color, wrap: 'truncate-end' }, line.text)))) : null,
    h(Box, { height: footerHeight, flexShrink: 0 },
      h(Panel, { title: 'Auswertung & Zeitprogramme · i', width: half, height: footerHeight, active: focus === 'insights' },
        ...insights.slice(Math.min(scroll.insights, maxScroll.insights), Math.min(scroll.insights, maxScroll.insights) + footerRows)
          .map((line, index) => h(Text, { key: index, wrap: 'truncate-end' }, line))),
      h(Panel, { title: 'Live-Protokoll · p', width: size.columns - half, height: footerHeight, active: focus === 'logs' },
        ...logLines.slice(Math.max(0, logLines.length - footerRows - logOffset), Math.max(0, logLines.length - logOffset))
          .map((line, index) => h(Text, { key: index, color: line.color, wrap: 'truncate-end' }, line.text)))));
}
