import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { spawn } from 'node:child_process';
import type { createRuntime } from './runtime.ts';
import { logger, type LogEntry } from './logger.ts';
import { chartSeries, terminalLog } from './tui-model.ts';
import { deviceKey, deviceLabels } from './model.ts';
import type { Device, Temperature } from './model.ts';
import { buildInsights } from './insights.ts';
import { HttpError } from './http-error.ts';

interface Point {
  timestamp: number;
  value: number;
  min: number;
  max: number;
  count: number;
}

interface TerminalStatus {
  demo: boolean;
  connected: boolean;
  device: { name: string } | null;
  devices: { id: string; name: string; sensors: Temperature[] }[];
  activeDevice: string | null;
  sensors: (Temperature & { timestamp: number })[];
  pollSeconds: number;
  error: string | null;
  nextPollAt: number | null;
  collecting: boolean;
}

interface TerminalSeries extends Temperature {
  device: string;
  key: string;
  display: string;
}

const periods = [24, 168, 720] as const;
const periodLabels = ['24 Stunden', '7 Tage', '30 Tage'];
const number = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

type Runtime = ReturnType<typeof createRuntime>;

function colorFor(index: number): string {
  return ['cyan', 'yellow', 'green', 'magenta', 'blue', 'red', 'white', 'yellow'][index % 8]!;
}

function launchLogin(port: number) {
  const target = `http://localhost:${port}/auth/login`;
  const command = process.platform === 'win32' ? 'rundll32.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
  browser.once('error', error => logger.warn(`Browser konnte nicht geöffnet werden: ${error.message} · ${target}`));
  browser.unref();
}

export async function startTerminal(runtime: Runtime, onQuit: () => void): Promise<{ close(): void }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Die Terminaloberfläche benötigt ein interaktives Terminal.');
  }
  const { config, store } = runtime;
  const screen = blessed.screen({ smartCSR: true, title: 'ViMonitor · Terminal' });
  const grid = new contrib.grid({ rows: 20, cols: 12, screen });
  const header = blessed.box({
    top: 0, left: 0, width: '100%', height: 3, tags: true,
    style: { fg: 'white', bg: 'blue' },
    content: ' ViMonitor | Terminal-Dashboard\n q Terminal schließen  Strg+C alles beenden  r Aktualisieren  1/2/3 Zeitraum  a Heizung  d Geräte  c Vergleich  f/w Sensor  l Login',
  });
  const statusBox = blessed.box({
    top: 3, left: 0, width: '100%', height: 4, tags: true,
    border: { type: 'line' }, label: ' Status ',
    style: { border: { fg: 'cyan' } },
  });
  const flowChart = grid.set(6, 0, 3, 6, contrib.line, {
    label: ' Vorlauf · f Sensor wechseln ',
    showLegend: false, wholeNumbersOnly: false,
    style: { line: 'cyan', text: 'white', baseline: 'gray' },
  });
  const waterChart = grid.set(6, 6, 3, 6, contrib.line, {
    label: ' Warmwasser · w Sensor wechseln ',
    showLegend: false, wholeNumbersOnly: false,
    style: { line: 'yellow', text: 'white', baseline: 'gray' },
  });
  const comparisonChart = grid.set(9, 0, 4, 12, contrib.line, {
    label: ' Temperaturvergleich · c Auswahl bearbeiten ',
    showLegend: true, wholeNumbersOnly: false,
    style: { line: 'green', text: 'white', baseline: 'gray' },
  });
  const insightsBox = blessed.box({
    top: '66%', left: 0, width: '50%', height: '33%', tags: true, scrollable: true,
    border: { type: 'line' }, label: ' Nacht-Auswertung & Zeitprogramme ',
    style: { border: { fg: 'magenta' } },
  });
  const logs = blessed.log({
    top: '66%', left: '50%', width: '50%', height: '33%', tags: true,
    scrollback: 1000, scrollOnInput: true,
    border: { type: 'line' }, label: ' Live-Protokoll ',
    style: { border: { fg: 'yellow' } },
  });
  screen.append(header);
  screen.append(statusBox);
  screen.append(insightsBox);
  screen.append(logs);
  const removeLogSink = logger.subscribe((entry: LogEntry) => {
    logs.log(terminalLog(entry));
    screen.render();
  }, true);

  let status: TerminalStatus | null = null;
  let insights: ReturnType<typeof buildInsights> | null = null;
  let hours: typeof periods[number] = 24;
  let flowSensor = '';
  let waterSensor = '';
  let comparison = new Set<string>();
  const initializedDevices = new Set<string>();
  const histories = new Map<string, Point[]>();
  let modal: { box: blessed.Widgets.BoxElement; list: blessed.Widgets.ListElement; close: () => void } | undefined;
  let refreshBusy = false;
  let refreshQueued = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const allSeries = (): TerminalSeries[] => (status?.devices ?? []).flatMap(device =>
    device.sensors.map(sensor => ({
      ...sensor,
      device: device.id,
      key: JSON.stringify([device.id, sensor.sensor]),
      display: (status?.devices.length ?? 0) > 1 ? `${device.name} · ${sensor.label}` : sensor.label,
    })));

  function showStatus() {
    if (!status) {
      statusBox.setContent(' Verbindung zum lokalen ViMonitor-Server wird hergestellt …');
      return;
    }
    const active = status.devices.find(device => device.id === status?.activeDevice);
    const sensorLines = active?.sensors.slice(0, 5).map(sensor =>
      `${sensor.label}: {bold}${number.format(sensor.value)} °C{/bold}`).join('   ') ?? 'Noch keine Messwerte';
    const next = status.nextPollAt ? time.format(status.nextPollAt) : 'nicht geplant';
    const connection = status.error ? `{red-fg}FEHLER{/red-fg} ${status.error}`
      : status.demo ? '{yellow-fg}DEMO{/yellow-fg}'
        : status.connected ? '{green-fg}VERBUNDEN{/green-fg}' : '{red-fg}NICHT VERBUNDEN{/red-fg}';
    statusBox.setContent([
      ` ${connection}   Geräte: ${status.devices.length}   Aktiv: ${active?.name ?? 'keines'}   Nächste Abfrage: ${next}   ${periodLabels[periods.indexOf(hours)]}`,
      ` ${status.collecting ? 'Messabfrage läuft' : 'Erfassung bereit'} · ${Math.round(status.pollSeconds / 60)} Min.   ${sensorLines}`,
    ].join('\n'));
  }

  function showInsights() {
    if (!insights) {
      insightsBox.setContent(' Auswertung und Zeitprogramme werden geladen …');
      return;
    }
    const night = insights.lastNight;
    const nightText = night?.status === 'ok' && night.rate !== null
      ? `Letzte Pause: ${number.format(night.rate)} °C/h · ${night.drop === null ? '—' : `${number.format(night.drop)} °C`} Abfall (${night.startTemperature ?? '—'} → ${night.endTemperature ?? '—'} °C)`
      : `Letzte Nacht: ${insights.message}`;
    const scheduleText = insights.schedules.length
      ? insights.schedules.map(schedule => {
        const today = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: insights?.timeZone })
          .format(Date.now()).toLowerCase();
        const day = (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)
          .find(value => value === today);
        const entries = day ? schedule.entries[day] : [];
        return `${schedule.label}${schedule.active ? '' : ' (inaktiv)'}: ${entries.length
          ? entries.map(entry => `${entry.start}-${entry.end} ${entry.mode}`).join(', ')
          : 'keine Zeitfenster'}`;
      }).join('\n')
      : 'Keine Zeitprogramme aufgezeichnet.';
    insightsBox.setContent([
      ` ${insights.stale ? '{yellow-fg}Veraltete Daten{/yellow-fg}' : 'Zeitbasis: ' + insights.timeZone}`,
      ` ${nightText}`,
      '',
      ' Zeitprogramme heute:',
      ...scheduleText.split('\n').map(line => ` ${line}`),
      '',
      ' Hinweis: Temperaturverlauf ist eine Orientierung, keine Diagnose.',
    ].join('\n'));
  }

  function showChart(widget: ReturnType<typeof contrib.line>, title: string, points: Point[], color: string) {
    const sampled = chartSeries(title, points);
    widget.setData([{
      title,
      x: sampled.x,
      y: sampled.y,
      style: { line: color, text: color, baseline: 'gray' },
    }]);
  }

  async function loadCharts() {
    if (!status) return;
    const activeId = status.activeDevice;
    let wanted = new Set(comparison);
    if (activeId) {
      if (flowSensor) wanted.add(JSON.stringify([activeId, flowSensor]));
      if (waterSensor) wanted.add(JSON.stringify([activeId, waterSensor]));
    }
    const available = new Set(allSeries().map(item => item.key));
    wanted = new Set([...wanted].filter(item => available.has(item)));
    const results = await Promise.all([...wanted].map(async key => {
      const [device, sensor] = JSON.parse(key) as [string, string];
      const selected = store.getDevices().find(item => deviceKey(item) === device);
      if (!selected) return [key, [] as Point[]] as const;
      const to = Date.now();
      const points = store.history(selected, sensor, to - hours * 3600_000, to).map(point => ({
        timestamp: Number(point.timestamp),
        value: Number(point.value),
        min: Number(point.min),
        max: Number(point.max),
        count: Number(point.count),
      }));
      return [key, points] as const;
    }));
    histories.clear();
    for (const [key, points] of results) histories.set(key, points);

    const flowKey = activeId ? JSON.stringify([activeId, flowSensor]) : '';
    const waterKey = activeId ? JSON.stringify([activeId, waterSensor]) : '';
    showChart(flowChart, 'Vorlauf °C', histories.get(flowKey) ?? [], 'cyan');
    showChart(waterChart, 'Warmwasser °C', histories.get(waterKey) ?? [], 'yellow');
    const selected = allSeries().filter(item => comparison.has(item.key));
    comparisonChart.setData(selected.map((item, index) => {
      const sampled = chartSeries(item.display, histories.get(item.key) ?? []);
      return {
        title: item.display,
        x: sampled.x,
        y: sampled.y,
        style: { line: colorFor(index), text: colorFor(index), baseline: 'gray' },
      };
    }));
  }

  async function refresh() {
    if (stopped) return;
    if (refreshBusy) {
      refreshQueued = true;
      return;
    }
    refreshBusy = true;
    try {
      const selected = store.getDevices();
      const labels = deviceLabels(selected);
      const activeDevice = store.getDevice();
      const activeKey = activeDevice ? deviceKey(activeDevice) : null;
      const readSensors = (device: Device): (Temperature & { timestamp: number })[] => store.sensors(device).map(sensor => ({
        sensor: String(sensor.sensor),
        label: String(sensor.label),
        kind: sensor.kind === 'flow' || sensor.kind === 'water' ? sensor.kind : 'other',
        value: Number(sensor.value),
        timestamp: Number(sensor.timestamp),
      }));
      const currentStatus: TerminalStatus = {
        demo: config.demo,
        connected: config.demo || runtime.api.connected(),
        device: activeDevice ? { name: labels.get(deviceKey(activeDevice)) ?? activeDevice.name } : null,
        devices: selected.map(device => ({
          id: deviceKey(device),
          name: labels.get(deviceKey(device)) ?? device.name,
          sensors: readSensors(device),
        })),
        activeDevice: activeKey,
        sensors: activeDevice ? readSensors(activeDevice) : [],
        pollSeconds: config.pollSeconds,
        error: runtime.collector.error,
        nextPollAt: runtime.collector.nextPollAt,
        collecting: runtime.collector.running,
      };
      status = currentStatus;
      if (currentStatus.activeDevice) {
        const active = currentStatus.devices.find(device => device.id === currentStatus.activeDevice);
        const choose = (kind: 'flow' | 'water', current: string) => active?.sensors.some(sensor => sensor.sensor === current)
          ? current : active?.sensors.find(sensor => sensor.kind === kind)?.sensor ?? '';
        flowSensor = choose('flow', flowSensor);
        waterSensor = choose('water', waterSensor);
      }
      const series = allSeries();
      const available = new Set(series.map(item => item.key));
      comparison = new Set([...comparison].filter(key => available.has(key)));
      for (const device of currentStatus.devices) {
        if (initializedDevices.has(device.id) || !device.sensors.length) continue;
        for (const kind of ['flow', 'water'] as const) {
          const sensor = device.sensors.find(item => item.kind === kind);
          if (sensor) comparison.add(JSON.stringify([device.id, sensor.sensor]));
        }
        initializedDevices.add(device.id);
      }
      try {
        insights = buildInsights(store, activeDevice);
      } catch (error) {
        logger.warn(`Auswertung konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}`);
      }
      await loadCharts();
      showStatus();
      showInsights();
      screen.render();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      statusBox.setContent(` {red-fg}Verbindung fehlgeschlagen{/red-fg}: ${detail}`);
      logger.error(`Terminal-Aktualisierung fehlgeschlagen: ${detail}`);
      screen.render();
    } finally {
      refreshBusy = false;
      if (refreshQueued && !stopped) {
        refreshQueued = false;
        queueMicrotask(() => { void refresh(); });
      }
    }
  }

  function openChooser<T extends { key: string; label: string; selected: boolean }>(
    title: string,
    choices: T[],
    save: (selected: T[]) => Promise<void>,
  ) {
    if (modal) return;
    const selected = new Set(choices.filter(item => item.selected).map(item => item.key));
    const box = blessed.box({
      top: 'center', left: 'center', width: '75%', height: '75%',
      border: { type: 'line' }, label: ` ${title} `,
      style: { border: { fg: 'cyan' }, bg: 'black' },
    });
    const list = blessed.list({
      top: 1, left: 1, right: 1, bottom: 3,
      items: choices.map(item => `${selected.has(item.key) ? '[x]' : '[ ]'} ${item.label}`),
      keys: true, vi: true, mouse: true, tags: true, border: { type: 'line' },
      style: { selected: { fg: 'black', bg: 'cyan', bold: true }, border: { fg: 'gray' } },
    });
    const footer = blessed.box({
      bottom: 0, left: 1, right: 1, height: 2,
      content: ' Enter: Auswahl umschalten · s: speichern · Esc: schließen',
      style: { fg: 'white' },
    });
    box.append(list);
    box.append(footer);
    screen.append(box);
    const close = () => {
      screen.unkey('s', onSave);
      screen.unkey('escape', onClose);
      box.destroy();
      modal = undefined;
      screen.render();
    };
    const onClose = () => close();
    const onSave = () => {
      const result = choices.filter(item => selected.has(item.key));
      void save(result).then(close).catch(error => {
        logger.error(`Auswahl konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    list.on('select', (_item, index) => {
      const item = choices[index];
      if (!item) return;
      if (selected.has(item.key)) selected.delete(item.key);
      else selected.add(item.key);
      list.setItems(choices.map(choice => `${selected.has(choice.key) ? '[x]' : '[ ]'} ${choice.label}`));
      list.select(index);
      screen.render();
    });
    screen.key('s', onSave);
    screen.key('escape', onClose);
    modal = { box, list, close };
    list.focus();
    screen.render();
  }

  async function editDevices() {
    if (status?.demo) {
      logger.warn('Die Geräteauswahl steht nur im Echtbetrieb zur Verfügung.');
      return;
    }
    try {
      const devices = await runtime.api.devices();
      const selectedDevices = new Set(store.getDevices().map(deviceKey));
      const labels = deviceLabels(devices);
      openChooser('Heizgeräte für die Erfassung', devices.map((device, index) => ({
        key: String(index),
        label: `${labels.get(deviceKey(device)) ?? device.name} · Gerät ${device.deviceId}`,
        selected: selectedDevices.has(deviceKey(device)),
      })), async selected => {
        if (!selected.length) throw new HttpError('Bitte mindestens ein Heizgerät auswählen.', 400);
        if (runtime.collector.running) throw new HttpError('Messabfrage läuft. Bitte kurz warten.', 409);
        store.setDevices(selected
          .map(item => devices[Number(item.key)])
          .filter((device): device is Device => device !== undefined));
        await runtime.collector.restart();
        if (runtime.collector.error) {
          throw new HttpError(`Auswahl gespeichert, aber Messung fehlgeschlagen: ${runtime.collector.error}`, 502);
        }
        await refresh();
      });
    } catch (error) {
      logger.error(`Geräteliste konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function editComparison() {
    const series = allSeries();
    openChooser('Temperaturen vergleichen', series.map(item => ({
      key: item.key, label: item.display, selected: comparison.has(item.key),
    })), async selected => {
      comparison = new Set(selected.map(item => item.key));
      await loadCharts();
      screen.render();
    });
  }

  async function setActiveDevice(direction: number) {
    if (!status?.devices.length || !status.activeDevice) return;
    const index = status.devices.findIndex(device => device.id === status?.activeDevice);
    const next = status.devices[(index + direction + status.devices.length) % status.devices.length];
    if (!next) return;
    try {
      const device = store.getDevices().find(item => deviceKey(item) === next.id);
      if (!device) throw new HttpError('Gerät ist nicht mehr ausgewählt.', 404);
      store.setDevice(device);
      await refresh();
    } catch (error) {
      logger.error(`Aktive Heizung konnte nicht gewechselt werden: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function cycleSensor(kind: 'flow' | 'water') {
    const sensors = status?.sensors ?? [];
    const choices = [
      ...sensors.filter(sensor => sensor.kind === kind),
      ...sensors.filter(sensor => sensor.kind !== kind),
    ];
    if (!choices.length) return;
    const current = kind === 'flow' ? flowSensor : waterSensor;
    const index = choices.findIndex(sensor => sensor.sensor === current);
    const next = choices[(index + 1) % choices.length];
    if (!next) return;
    if (kind === 'flow') flowSensor = next.sensor;
    else waterSensor = next.sensor;
    void refresh();
  }

  function cyclePeriod(index: number) {
    hours = periods[index] ?? 24;
    void refresh();
  }

  function close() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    modal?.close();
    screen.destroy();
    removeLogSink();
  }

  screen.key('q', close);
  screen.key('C-c', onQuit);
  screen.key('r', () => { void refresh(); });
  screen.key('1', () => cyclePeriod(0));
  screen.key('2', () => cyclePeriod(1));
  screen.key('3', () => cyclePeriod(2));
  screen.key('a', () => { void setActiveDevice(1); });
  screen.key('A', () => { void setActiveDevice(-1); });
  screen.key('d', () => { void editDevices(); });
  screen.key('c', editComparison);
  screen.key('f', () => cycleSensor('flow'));
  screen.key('w', () => cycleSensor('water'));
  screen.key('l', () => {
    if (status?.demo) {
      logger.warn('Die ViCare-Anmeldung steht im Demo-Modus nicht zur Verfügung.');
      return;
    }
    logger.info(`Öffne ViCare-Anmeldung · http://localhost:${config.port}/auth/login`);
    launchLogin(config.port);
  });

  screen.render();
  await refresh();
  timer = setInterval(() => { void refresh(); }, 30_000);
  timer.unref();
  return { close };
}
