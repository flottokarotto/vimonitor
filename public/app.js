/* global Chart */
const $ = id => document.getElementById(id);
const formatNumber = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const formatAxis = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, signDisplay: 'negative' });
const formatTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const formatDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const state = { hours: 24, status: null, request: 0, charts: {}, discovered: false, refreshing: false };

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
  select.replaceChildren();
  if (!candidates.length) {
    select.add(new Option('Kein passender Sensor verfügbar', ''));
  } else {
    for (const sensor of candidates) select.add(new Option(sensor.label, sensor.sensor));
  }
  const others = sensors.filter(sensor => sensor.kind !== kind);
  if (others.length) {
    const group = document.createElement('optgroup');
    group.label = 'Weitere Celsius-Sensoren (manuelle Auswahl)';
    for (const sensor of others) group.append(new Option(sensor.label, sensor.sensor));
    select.append(group);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  updateValue(kind);
}

function updateValue(kind) {
  const selected = $(`${kind}-sensor`).value;
  const sensor = state.status?.sensors.find(item => item.sensor === selected);
  const manual = sensor && sensor.kind !== kind;
  $(`${kind}-title`).textContent = manual ? sensor.label : kind === 'flow' ? 'Vorlauftemperatur' : 'Warmwassertemperatur';
  $(`${kind}-description`).textContent = manual ? 'Manuell gewählter Temperatursensor'
    : kind === 'flow' ? 'Wärme auf dem Weg in dein Zuhause' : 'Dein Warmwasserspeicher im Blick';
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
              const lines = [`${formatNumber.format(point.y)} °C`];
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

function renderHistory(kind, points) {
  const chart = state.charts[kind];
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
  const now = Date.now();
  chart.options.scales.x.min = now - state.hours * 3600_000;
  chart.options.scales.x.max = now;
  chart.data.datasets[0].data = data;
  chart.update();
  $(`${kind}-empty`).hidden = points.length > 0;
  const stats = $(`${kind}-stats`).querySelectorAll('strong');
  stats[0].textContent = points.length ? `${formatNumber.format(Math.min(...points.map(point => point.min)))} °C` : '—';
  stats[1].textContent = points.length ? `${formatNumber.format(Math.max(...points.map(point => point.max)))} °C` : '—';
  stats[2].textContent = new Intl.NumberFormat('de-DE').format(points.reduce((sum, point) => sum + point.count, 0));
}

async function loadHistories() {
  const version = ++state.request;
  try {
    const results = await Promise.all(['flow', 'water'].map(async kind => {
      const sensor = $(`${kind}-sensor`).value;
      const data = sensor ? await api(`/api/history?hours=${state.hours}&sensor=${encodeURIComponent(sensor)}`) : { points: [] };
      return { kind, points: data.points };
    }));
    if (version !== state.request) return;
    for (const result of results) renderHistory(result.kind, result.points);
  } catch (error) {
    if (version === state.request) {
      for (const kind of ['flow', 'water']) renderHistory(kind, []);
      showError(`Verlauf konnte nicht geladen werden: ${error.message}`);
    }
  }
}

async function loadDevices() {
  $('load-devices').disabled = true;
  $('setup-message').textContent = 'Verfügbare Geräte werden bei Viessmann abgefragt …';
  try {
    const result = await api('/api/devices');
    const select = $('device-select');
    select.replaceChildren(...result.devices.map(device => new Option(`${device.name} · Gerät ${device.deviceId} · Auswahl ${device.index + 1}`, String(device.index))));
    $('device-form').hidden = result.devices.length === 0;
    $('setup-message').textContent = result.devices.length ? 'Bitte das gewünschte Heizgerät auswählen.' : 'Keine Geräte gefunden. ViCare-Konto, Gateway und API-Freigabe prüfen.';
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
  try {
    const status = await api('/api/status');
    renderStatus(status);
    await loadHistories();
    if (status.connected && !status.demo && !status.device && !state.discovered) await loadDevices();
  } catch (error) {
    showError(`Lokaler Server nicht erreichbar: ${error.message}`);
    $('connection').textContent = 'Verbindung unterbrochen';
    $('status-dot').className = 'dot warning';
    for (const kind of ['flow', 'water']) updateValue(kind);
  } finally {
    state.refreshing = false;
    $('refresh').disabled = false;
  }
}

async function initialize() {
  $('settings-toggle').addEventListener('click', () => setupVisible($('setup').hidden));
  $('setup-close').addEventListener('click', () => setupVisible(false));
  $('demo-setup').addEventListener('click', () => { setupVisible(true); $('setup').scrollIntoView({ block: 'center' }); });
  $('refresh').addEventListener('click', refresh);
  $('load-devices').addEventListener('click', loadDevices);
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
  $('device-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('device-form').querySelector('button');
    button.disabled = true;
    try {
      await api('/api/device', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: Number($('device-select').value) }),
      });
      $('setup-message').textContent = 'Gerät ausgewählt. Die automatische Erfassung ist aktiv.';
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
