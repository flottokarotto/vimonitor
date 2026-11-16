/* global Chart */
const $ = id => document.getElementById(id);
const formatNumber = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const formatAxis = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, signDisplay: 'negative' });
const formatTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const formatDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const state = { hours: 24, status: null, request: 0, charts: {}, discovered: false, refreshing: false, comparison: new Set(), comparisonInitialized: new Set() };
const lineColors = ['#e6744a', '#279c9d', '#7961b5', '#b08624', '#3277bd', '#c64e83', '#628c3c', '#64748b'];
const weekDays = [['mon', 'Montag'], ['tue', 'Dienstag'], ['wed', 'Mittwoch'], ['thu', 'Donnerstag'], ['fri', 'Freitag'], ['sat', 'Samstag'], ['sun', 'Sonntag']];

function scheduleEntriesText(entries) {
  const modes = { on: 'Warmwasser freigegeben', off: 'Warmwasser aus', normal: 'Normalbetrieb', comfort: 'Komfortbetrieb', reduced: 'Absenkbetrieb', standby: 'Bereitschaft' };
  return entries.length ? entries.map(entry => `${entry.start}–${entry.end} Uhr · ${modes[entry.mode] ?? entry.mode}`).join('; ') : 'Keine Zeitfenster eingetragen';
}

function renderInsights(insights) {
  const { lastNight: night, comparison } = insights;
  const valid = night?.status === 'ok';
  const levels = { low: 'Geringer Temperaturabfall', moderate: 'Mittlerer Temperaturabfall', high: 'Stärkerer Temperaturabfall' };
  $('cooling-badge').textContent = valid ? levels[night.level] : night?.status === 'disturbed' || night?.status === 'schedule-changed' ? 'Nicht bewertbar' : 'Noch keine Auswertung';
  $('cooling-badge').classList.toggle('caution', valid && night.level === 'high');
  $('cooling-message').textContent = valid
    ? 'Beobachteter Temperaturabfall während einer planmäßigen Warmwasser-Pause. Die Einordnung ist eine grobe Orientierung.'
    : insights.message;
  $('cooling-values').hidden = !valid;
  $('cooling-rate').textContent = valid ? formatNumber.format(night.rate) : '—';
  $('cooling-drop').textContent = valid ? formatNumber.format(night.drop) : '—';
  const date = new Intl.DateTimeFormat('de-DE', { timeZone: insights.timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  $('cooling-window').textContent = night
    ? `Planmäßige Pause: ${date.format(night.start)}–${date.format(night.end)} Uhr (${insights.timeZone}).${valid ? ` Ausgewertet: ${date.format(night.measuredStart)}–${date.format(night.measuredEnd)} Uhr, von ${formatNumber.format(night.startTemperature)} auf ${formatNumber.format(night.endTemperature)} °C.` : ''}`
    : '';
  $('cooling-comparison').textContent = comparison
    ? `Vergleich mit ${comparison.nights} früheren Nächten: ${comparison.trend === 'faster' ? 'schnellerer' : comparison.trend === 'slower' ? 'langsamerer' : 'ähnlicher'} Temperaturabfall. Bisheriger Median: ${formatNumber.format(comparison.medianRate)} °C/h.`
    : 'Der Vergleich mit eigenen früheren Nächten erscheint automatisch, sobald mindestens drei vergleichbare Nächte vorliegen.';
  $('schedule-status').textContent = insights.observedAt
    ? `${insights.stale ? 'Veraltet · ' : ''}Stand ${date.format(insights.observedAt)} Uhr · ${insights.timeZone}`
    : 'Noch keine Zeitprogramme aufgezeichnet. Sie werden bei der nächsten Messabfrage mitgelesen.';
  const todayName = new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: insights.timeZone }).format(Date.now());
  const day = weekDays.find(([, label]) => label === todayName)?.[0];
  const today = $('schedule-today');
  const weekly = $('schedule-week-content');
  today.replaceChildren();
  weekly.replaceChildren();
  $('schedule-week').hidden = insights.schedules.length === 0;
  if (!insights.schedules.length) {
    const message = document.createElement('p');
    message.className = 'insight-detail';
    message.textContent = insights.message;
    today.append(message);
  }
  for (const schedule of insights.schedules) {
    const item = document.createElement('div');
    item.className = 'schedule-item';
    const title = document.createElement('strong');
    title.textContent = `${schedule.label} · heute (${todayName})${schedule.active ? '' : ' · Zeitprogramm nicht aktiv'}`;
    const text = document.createElement('p');
    text.textContent = day ? scheduleEntriesText(schedule.entries[day]) : 'Wochentag konnte nicht bestimmt werden.';
    item.append(title, text);
    today.append(item);
    const table = document.createElement('table');
    table.className = 'schedule-week-table';
    const caption = table.createCaption();
    caption.textContent = `${schedule.label}${schedule.active ? '' : ' (nicht aktiv)'}`;
    const body = table.createTBody();
    for (const [key, name] of weekDays) {
      const row = body.insertRow();
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = name;
      row.append(heading);
      row.insertCell().textContent = scheduleEntriesText(schedule.entries[key]);
    }
    weekly.append(table);
  }
}

function insightsError(message) {
  $('cooling-badge').textContent = 'Ladefehler';
  $('cooling-values').hidden = true;
  $('cooling-window').textContent = '';
  $('cooling-comparison').textContent = '';
  $('cooling-message').textContent = `Auswertung nicht verfügbar: ${message}`;
  $('schedule-status').textContent = 'Zeitprogramme konnten nicht geladen werden.';
  $('schedule-today').replaceChildren();
  $('schedule-week-content').replaceChildren();
  $('schedule-week').hidden = true;
}

async function loadInsights() {
  try {
    renderInsights(await api('/api/insights'));
  } catch (error) {
    insightsError(error.message);
    showError(`Auswertung konnte nicht geladen werden: ${error.message}`);
  }
}

const seriesKey = (device, sensor) => JSON.stringify([device, sensor]);
function comparisonSensors(status) {
  return status.devices.flatMap(device => device.sensors.map(sensor => ({
    ...sensor, device: device.id, key: seriesKey(device.id, sensor.sensor),
    display: status.devices.length > 1 ? `${device.name} · ${sensor.label}` : sensor.label,
  })));
}

function updateComparisonSensors(sensors) {
  const devices = new Set(state.status.devices.map(device => device.id));
  state.comparisonInitialized = new Set([...state.comparisonInitialized].filter(id => devices.has(id)));
  const available = new Set(sensors.map(sensor => sensor.key));
  state.comparison = new Set([...state.comparison].filter(sensor => available.has(sensor)));
  for (const device of state.status.devices) {
    const deviceSensors = sensors.filter(sensor => sensor.device === device.id);
    if (!deviceSensors.length || state.comparisonInitialized.has(device.id)) continue;
    for (const kind of ['flow', 'water']) {
      const sensor = deviceSensors.find(item => item.kind === kind);
      if (sensor) state.comparison.add(sensor.key);
    }
    state.comparisonInitialized.add(device.id);
  }
  const picker = $('compare-sensors');
  picker.replaceChildren();
  for (const [index, sensor] of sensors.entries()) {
    const label = document.createElement('label');
    label.className = `compare-choice color-${index % lineColors.length}${index >= lineColors.length ? (index >= lineColors.length * 2 ? ' dotted' : ' dashed') : ''}`;
    label.title = sensor.sensor;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = sensor.key;
    input.checked = state.comparison.has(sensor.key);
    input.addEventListener('change', () => {
      if (input.checked) state.comparison.add(sensor.key);
      else state.comparison.delete(sensor.key);
      void loadHistories();
    });
    const text = document.createElement('span');
    text.textContent = sensor.display;
    label.append(input, text);
    picker.append(label);
  }
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Anfrage fehlgeschlagen (${response.status}).`);
  return body;
}

function setupVisible(visible) {
  $('setup').hidden = !visible;
  $('settings-toggle').setAttribute('aria-expanded', String(visible));
}

function updateSensor(kind, sensors) {
  const select = $(`${kind}-sensor`);
  const previous = select.value;
  const candidates = sensors.filter(sensor => sensor.kind === kind);
  const sensorOption = sensor => {
    const option = new Option(sensor.label, sensor.sensor);
    option.title = sensor.sensor;
    return option;
  };
  select.replaceChildren();
  if (!candidates.length) {
    select.add(new Option('Kein passender Sensor verfügbar', ''));
  } else {
    for (const sensor of candidates) select.add(sensorOption(sensor));
  }
  const others = sensors.filter(sensor => sensor.kind !== kind);
  if (others.length) {
    const group = document.createElement('optgroup');
    group.label = 'Weitere Celsius-Sensoren (manuelle Auswahl)';
    for (const sensor of others) group.append(sensorOption(sensor));
    select.append(group);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  updateValue(kind);
}

function updateValue(kind) {
  const selected = $(`${kind}-sensor`).value;
  const sensor = state.status?.sensors.find(item => item.sensor === selected);
  $(`${kind}-sensor`).title = sensor?.sensor ?? '';
  const manual = sensor && sensor.kind !== kind;
  $(`${kind}-title`).textContent = manual ? sensor.label : kind === 'flow' ? 'Vorlauftemperatur' : 'Warmwassertemperatur';
  $(`${kind}-description`).textContent = manual ? 'Manuell gewählter Temperatursensor'
    : kind === 'flow' ? 'Temperatur des Heizwassers im Vorlauf' : 'Temperatur des Warmwassers';
  $(`${kind}-chart`).setAttribute('aria-label', `Zeitverlauf: ${sensor?.label ?? (kind === 'flow' ? 'Vorlauftemperatur' : 'Warmwassertemperatur')}`);
  $(`${kind}-value`).textContent = sensor ? formatNumber.format(sensor.value) : '—';
  const age = $(`${kind}-age`);
  age.classList.remove('stale');
  if (!sensor) {
    age.textContent = 'Sensor nicht verfügbar';
    return;
  }
  const stale = Date.now() - sensor.timestamp > state.status.pollSeconds * 2500;
  age.classList.toggle('stale', stale);
  age.textContent = `${stale ? 'Veraltet · ' : 'Stand '}${formatDate.format(sensor.timestamp)}`;
}

function renderStatus(status) {
  state.status = status;
  $('mode').textContent = status.demo ? 'Demo-Modus' : 'ViCare API';
  $('mode').classList.toggle('demo', status.demo);
  $('demo-notice').hidden = !status.demo;
  $('login').hidden = status.demo;
  $('login').textContent = status.connected ? 'Erneut bei Viessmann anmelden ↗' : 'Mit Viessmann verbinden ↗';
  $('load-devices').hidden = status.demo || !status.connected;
  $('redirect-uri').textContent = `http://localhost:${location.port}/auth/callback`;
  $('device-name').textContent = status.device?.name ?? 'Viessmann · ViCare API';
  $('active-device-label').hidden = status.devices.length < 2;
  $('active-device').replaceChildren(...status.devices.map(device => new Option(device.name, device.id)));
  $('active-device').value = status.activeDevice ?? '';
  $('poll-label').textContent = `Alle ${Math.round(status.pollSeconds / 60)} Minuten`;
  const latest = Math.max(0, ...status.sensors.map(sensor => sensor.timestamp));
  const stale = latest && Date.now() - latest > status.pollSeconds * 2500;
  $('connection').textContent = status.error ? 'Erfassung gestört'
    : !status.connected ? 'Noch nicht verbunden'
      : !status.device ? 'Bitte Gerät auswählen'
        : !latest ? 'Warte auf erste Messung'
        : stale ? 'Messwerte veraltet'
          : status.demo ? 'Demo ist bereit' : 'Mit Heizung verbunden';
  $('status-dot').className = `dot ${status.error || stale || !status.device ? 'warning' : 'good'}`;
  $('updated').textContent = latest ? `Letzte Messung: ${formatDate.format(latest)}` : 'Noch keine Messung';
  showError(status.error ?? '');
  for (const kind of ['flow', 'water']) updateSensor(kind, status.sensors);
  updateComparisonSensors(comparisonSensors(status));
  if (!status.demo && (!status.connected || !status.device)) setupVisible(true);
}

function createChart(kind) {
  const color = kind === 'flow' ? '#e6744a' : '#279c9d';
  return new Chart($(`${kind}-chart`), {
    type: 'line',
    data: { datasets: [{
      label: kind === 'flow' ? 'Vorlauf' : 'Warmwasser',
      data: [], borderColor: color, backgroundColor: `${color}12`,
      fill: true, tension: 0.22, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: false,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
      interaction: { intersect: false, mode: 'nearest', axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#253440', padding: 12, displayColors: false,
          callbacks: {
            title: entries => entries[0] ? formatDate.format(entries[0].parsed.x) : '',
            label: context => {
              const point = context.raw;
              if (point.y === null) return 'Keine Messung';
              const lines = [`${kind === 'compare' ? `${context.dataset.label}: ` : ''}${formatNumber.format(point.y)} °C`];
              if (point.count > 1) lines.push(`Min ${formatNumber.format(point.min)} · Max ${formatNumber.format(point.max)} °C`, `${point.count} Messungen`);
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear', grid: { display: false }, border: { display: false },
          ticks: { maxTicksLimit: 5, maxRotation: 0, color: '#a0a9b2', font: { size: 10 },
            callback: value => state.hours === 24 ? formatTime.format(value) : new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(value) },
        },
        y: {
          grace: '18%', border: { display: false }, grid: { color: '#f0f2f4', drawTicks: false },
          ticks: { precision: 1, maxTicksLimit: 5, padding: 12, color: '#a0a9b2', font: { size: 10 }, callback: value => `${formatAxis.format(Number(value))}°` },
        },
      },
    },
  });
}

function historyData(points) {
  const data = [];
  const bucket = Math.max(300_000, Math.ceil(state.hours * 3600_000 / 600));
  let previous;
  for (const point of points) {
    if (previous !== undefined && point.timestamp - previous > Math.max(bucket * 1.5, state.status.pollSeconds * 1500)) {
      data.push({ x: previous + bucket, y: null });
    }
    data.push({ x: point.timestamp, y: point.value, min: point.min, max: point.max, count: point.count });
    previous = point.timestamp;
  }
  return data;
}

function updateChart(chart) {
  const now = Date.now();
  chart.options.scales.x.min = now - state.hours * 3600_000;
  chart.options.scales.x.max = now;
  chart.update();
}

function renderComparison(histories) {
  const chart = state.charts.compare;
  const sensors = comparisonSensors(state.status);
  const selected = sensors.filter(sensor => state.comparison.has(sensor.key));
  chart.data.datasets = selected.map(sensor => {
    const index = sensors.indexOf(sensor);
    return {
      label: sensor.display, data: historyData(histories.get(sensor.key) ?? []),
      borderColor: lineColors[index % lineColors.length],
      borderDash: index >= lineColors.length ? (index >= lineColors.length * 2 ? [2, 3] : [7, 4]) : [],
      fill: false, tension: 0.22, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: false,
    };
  });
  updateChart(chart);
  const empty = selected.filter(sensor => !histories.get(sensor.key)?.length);
  $('compare-empty').hidden = selected.length > 0 && empty.length !== selected.length;
  $('compare-empty').textContent = selected.length ? 'Für diesen Zeitraum liegen keine Messwerte vor.' : 'Bitte mindestens eine Temperatur auswählen.';
  $('compare-summary').textContent = `${selected.length} von ${sensors.length} Temperaturen ausgewählt${empty.length ? ` · Keine Messwerte: ${empty.map(sensor => sensor.display).join(', ')}` : ''}`;
}

function renderHistory(kind, points) {
  const chart = state.charts[kind];
  chart.data.datasets[0].data = historyData(points);
  updateChart(chart);
  $(`${kind}-empty`).hidden = points.length > 0;
  const stats = $(`${kind}-stats`).querySelectorAll('strong');
  stats[0].textContent = points.length ? `${formatNumber.format(Math.min(...points.map(point => point.min)))} °C` : '—';
  stats[1].textContent = points.length ? `${formatNumber.format(Math.max(...points.map(point => point.max)))} °C` : '—';
  stats[2].textContent = new Intl.NumberFormat('de-DE').format(points.reduce((sum, point) => sum + point.count, 0));
}

async function loadHistories() {
  const version = ++state.request;
  try {
    const sensors = new Set(state.comparison);
    for (const kind of ['flow', 'water']) {
      const sensor = $(`${kind}-sensor`).value;
      if (sensor && state.status.activeDevice) sensors.add(seriesKey(state.status.activeDevice, sensor));
    }
    const results = await Promise.all([...sensors].map(async key => {
      const [device, sensor] = JSON.parse(key);
      const data = await api(`/api/history?hours=${state.hours}&sensor=${encodeURIComponent(sensor)}&device=${encodeURIComponent(device)}`);
      return [key, data.points];
    }));
    if (version !== state.request) return;
    const histories = new Map(results);
    for (const kind of ['flow', 'water']) renderHistory(kind, histories.get(seriesKey(state.status.activeDevice, $(`${kind}-sensor`).value)) ?? []);
    renderComparison(histories);
  } catch (error) {
    if (version === state.request) {
      for (const kind of ['flow', 'water']) renderHistory(kind, []);
      renderComparison(new Map());
      showError(`Verlauf konnte nicht geladen werden: ${error.message}`);
    }
  }
}

async function loadDevices() {
  $('load-devices').disabled = true;
  $('setup-message').textContent = 'Verfügbare Geräte werden bei Viessmann abgefragt …';
  try {
    const result = await api('/api/devices');
    const options = $('device-options');
    options.replaceChildren(...result.devices.map(device => {
      const label = document.createElement('label');
      label.className = 'device-choice';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(device.index);
      input.checked = device.selected;
      const text = document.createElement('span');
      text.textContent = `${device.name} · Gerät ${device.deviceId}`;
      label.append(input, text);
      return label;
    }));
    $('device-form').hidden = result.devices.length === 0;
    $('setup-message').textContent = result.devices.length ? 'Bitte mindestens ein Heizgerät auswählen.' : 'Keine Geräte gefunden. ViCare-Konto, Gateway und API-Freigabe prüfen.';
    state.discovered = true;
  } catch (error) {
    $('setup-message').textContent = error.message;
    showError(error.message);
  } finally {
    $('load-devices').disabled = false;
  }
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('refresh').disabled = true;
  $('active-device').disabled = true;
  try {
    const status = await api('/api/status');
    renderStatus(status);
    await loadHistories();
    await loadInsights();
    if (status.connected && !status.demo && !status.device && !state.discovered) await loadDevices();
  } catch (error) {
    showError(`Lokaler Server nicht erreichbar: ${error.message}`);
    insightsError(error.message);
    $('connection').textContent = 'Verbindung unterbrochen';
    $('status-dot').className = 'dot warning';
    for (const kind of ['flow', 'water']) updateValue(kind);
  } finally {
    state.refreshing = false;
    $('refresh').disabled = false;
    $('active-device').disabled = false;
  }
}

async function initialize() {
  $('settings-toggle').addEventListener('click', () => setupVisible($('setup').hidden));
  $('setup-close').addEventListener('click', () => setupVisible(false));
  $('demo-setup').addEventListener('click', () => { setupVisible(true); $('setup').scrollIntoView({ block: 'center' }); });
  $('refresh').addEventListener('click', refresh);
  $('load-devices').addEventListener('click', loadDevices);
  $('active-device').addEventListener('change', async event => {
    try {
      await api('/api/active-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: event.target.value }) });
      await refresh();
    } catch (error) {
      showError(error.message);
      event.target.value = state.status.activeDevice;
    }
  });
  for (const button of document.querySelectorAll('[data-hours]')) {
    button.addEventListener('click', () => {
      state.hours = Number(button.dataset.hours);
      for (const option of document.querySelectorAll('[data-hours]')) {
        const active = option === button;
        option.classList.toggle('active', active);
        option.setAttribute('aria-pressed', String(active));
      }
      void loadHistories();
    });
  }
  for (const kind of ['flow', 'water']) {
    state.charts[kind] = createChart(kind);
    $(`${kind}-sensor`).addEventListener('change', () => { updateValue(kind); void loadHistories(); });
  }
  state.charts.compare = createChart('compare');
  state.charts.compare.data.datasets = [];
  state.charts.compare.options.normalized = false;
  state.charts.compare.options.plugins.tooltip.displayColors = true;
  $('device-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('device-form').querySelector('button');
    button.disabled = true;
    try {
      await api('/api/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indexes: [...$('device-options').querySelectorAll('input:checked')].map(input => Number(input.value)) }),
      });
      $('setup-message').textContent = 'Auswahl gespeichert. Die automatische Erfassung ist aktiv.';
      setupVisible(false);
      await refresh();
    } catch (error) {
      $('setup-message').textContent = error.message;
      await refresh();
      showError(error.message);
    } finally { button.disabled = false; }
  });
  await refresh();
  setInterval(() => { void refresh(); }, 60_000);
}

initialize().catch(error => showError(`Dashboard konnte nicht gestartet werden: ${error.message}`));
