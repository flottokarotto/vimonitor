import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FormEvent } from 'react';
import { HistoryChart, colors } from './chart';
import type { Line } from './chart';
import { InsightCards } from './insights';
import type { DiscoveredDevice, Insights, Kind, Point, Sensor, Series, Status } from './types';

const number = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const key = (device: string, sensor: string) => JSON.stringify([device, sensor]);
const message = (error: unknown) => error instanceof Error ? error.message : 'Unbekannter Fehler.';
const post = (body: object): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body: unknown = await response.json();
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `Anfrage fehlgeschlagen (${response.status}).`;
    throw new Error(detail);
  }
  return body as T;
}

function Metric({ kind, status, selected, onSelect, points, hours }: {
  kind: Kind; status: Status | null; selected: string; onSelect: (value: string) => void; points: Point[]; hours: number;
}) {
  const sensors = status?.sensors ?? [];
  const sensor = sensors.find(item => item.sensor === selected);
  const manual = sensor && sensor.kind !== kind;
  const title = manual ? sensor.label : kind === 'flow' ? 'Vorlauftemperatur' : 'Warmwassertemperatur';
  const stale = sensor && status && Date.now() - sensor.timestamp > status.pollSeconds * 2500;
  const candidates = sensors.filter(item => item.kind === kind);
  const others = sensors.filter(item => item.kind !== kind);
  const lines: Line[] = [{ label: title, points, color: kind === 'flow' ? colors[0]! : colors[1]!, fill: true }];
  return <article className={`card chart-card ${kind}`}>
    <div className="metric-heading"><span className="metric-symbol" aria-hidden="true">{kind === 'flow' ? '↗' : '≈'}</span><div><h3 id={`${kind}-title`}>{title}</h3><span id={`${kind}-description`} className="metric-description">{manual ? 'Manuell gewählter Temperatursensor' : kind === 'flow' ? 'Temperatur des Heizwassers im Vorlauf' : 'Temperatur des Warmwassers'}</span></div><span className="unit-tag">°C</span></div>
    <div className="reading"><strong id={`${kind}-value`}>{sensor ? number.format(sensor.value) : '—'}</strong><span>°C</span><small id={`${kind}-age`} className={stale ? 'stale' : ''}>{sensor ? `${stale ? 'Veraltet · ' : 'Stand '}${date.format(sensor.timestamp)}` : 'Sensor nicht verfügbar'}</small></div>
    <label className="sensor-label" htmlFor={`${kind}-sensor`}>Sensor<select id={`${kind}-sensor`} value={selected} title={sensor?.sensor ?? ''} onChange={event => onSelect(event.target.value)}>
      {!candidates.length && <option value="">Kein passender Sensor verfügbar</option>}
      {candidates.map(item => <option key={item.sensor} value={item.sensor} title={item.sensor}>{item.label}</option>)}
      {others.length > 0 && <optgroup label="Weitere Celsius-Sensoren (manuelle Auswahl)">{others.map(item => <option key={item.sensor} value={item.sensor} title={item.sensor}>{item.label}</option>)}</optgroup>}
    </select></label>
    <div className="chart-container"><HistoryChart id={`${kind}-chart`} label={`Zeitverlauf: ${sensor?.label ?? title}`} hours={hours} pollSeconds={status?.pollSeconds ?? 300} lines={lines}/><p id={`${kind}-empty`} className="chart-empty" hidden={points.length > 0}>Für diesen Zeitraum liegen keine Messwerte vor.</p></div>
    <div id={`${kind}-stats`} className="chart-stats"><span>MIN <strong>{points.length ? `${number.format(Math.min(...points.map(point => point.min)))} °C` : '—'}</strong></span><span>MAX <strong>{points.length ? `${number.format(Math.max(...points.map(point => point.max)))} °C` : '—'}</strong></span><span>MESSUNGEN <strong>{new Intl.NumberFormat('de-DE').format(points.reduce((sum, point) => sum + point.count, 0))}</strong></span></div>
  </article>;
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [serverDown, setServerDown] = useState(false);
  const [setup, setSetup] = useState(false);
  const [setupMessage, setSetupMessage] = useState('');
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [discovered, setDiscovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hours, setHours] = useState(24);
  const [flow, setFlow] = useState('');
  const [water, setWater] = useState('');
  const [comparison, setComparison] = useState<Set<string>>(new Set());
  const [histories, setHistories] = useState<Map<string, Point[]>>(new Map());
  const [refreshCount, setRefreshCount] = useState(0);
  const initialized = useRef<Set<string>>(new Set());
  const refreshLock = useRef(false);
  const activeVersion = useRef(0);

  const loadDevices = useCallback(async () => {
    setBusy(true);
    setSetupMessage('Verfügbare Geräte werden bei Viessmann abgefragt …');
    try {
      const result = await api<{ devices: DiscoveredDevice[] }>('/api/devices');
      setDevices(result.devices);
      setDiscovered(true);
      setSetupMessage(result.devices.length ? 'Bitte mindestens ein Heizgerät auswählen.' : 'Keine Geräte gefunden. ViCare-Konto, Gateway und API-Freigabe prüfen.');
    } catch (e) {
      setSetupMessage(message(e)); setError(message(e));
    } finally { setBusy(false); }
  }, []);

  const refresh = useCallback(async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    const version = ++activeVersion.current;
    try {
      const next = await api<Status>('/api/status');
      if (version !== activeVersion.current) return;
      setStatus(next);
      setServerDown(false);
      setError(next.error ?? '');
      setRefreshCount(count => count + 1);
      if (!next.demo && (!next.connected || !next.device)) setSetup(true);
      try {
        const result = await api<Insights>('/api/insights');
        if (version === activeVersion.current) { setInsights(result); setInsightsError(null); }
      } catch (e) {
        if (version === activeVersion.current) { setInsights(null); setInsightsError(message(e)); setError(`Auswertung konnte nicht geladen werden: ${message(e)}`); }
      }
      if (next.connected && !next.demo && !next.device && !discovered) await loadDevices();
    } catch (e) {
      if (version === activeVersion.current) {
        setError(`Lokaler Server nicht erreichbar: ${message(e)}`);
        setInsights(null); setInsightsError(message(e)); setHistories(new Map()); setServerDown(true);
      }
    } finally { refreshLock.current = false; setRefreshing(false); }
  }, [discovered, loadDevices]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!status) return;
    const choose = (kind: Kind, previous: string) => status.sensors.some(item => item.sensor === previous)
      ? previous : status.sensors.find(item => item.kind === kind)?.sensor ?? '';
    setFlow(previous => choose('flow', previous));
    setWater(previous => choose('water', previous));
    const deviceIds = new Set(status.devices.map(device => device.id));
    initialized.current = new Set([...initialized.current].filter(id => deviceIds.has(id)));
    setComparison(previous => {
      const available = new Set(status.devices.flatMap(device => device.sensors.map(sensor => key(device.id, sensor.sensor))));
      const next = new Set([...previous].filter(item => available.has(item)));
      for (const device of status.devices) {
        if (!device.sensors.length || initialized.current.has(device.id)) continue;
        for (const kind of ['flow', 'water'] as const) {
          const sensor = device.sensors.find(item => item.kind === kind);
          if (sensor) next.add(key(device.id, sensor.sensor));
        }
        initialized.current.add(device.id);
      }
      return next;
    });
  }, [status]);

  const series: Series[] = useMemo(() => {
    const result = (status?.devices ?? []).flatMap(device => device.sensors.map(sensor => ({
      ...sensor, device: device.id, key: key(device.id, sensor.sensor),
      display: (status?.devices.length ?? 0) > 1 ? `${device.name} · ${sensor.label}` : sensor.label,
    })));
    return result.map((item, index) => ({ ...item, index }));
  }, [status]);
  const requestKeys = useMemo(() => {
    const keys = new Set(comparison);
    if (status?.activeDevice) for (const sensor of [flow, water]) if (sensor) keys.add(key(status.activeDevice, sensor));
    return [...keys].sort();
  }, [comparison, flow, water, status?.activeDevice]);
  const requestSignature = JSON.stringify(requestKeys);
  useEffect(() => {
    let active = true;
    const keys: string[] = JSON.parse(requestSignature);
    if (!keys.length) { setHistories(new Map()); return; }
    void Promise.all(keys.map(async item => {
      const [device, sensor]: [string, string] = JSON.parse(item);
      const result = await api<{ points: Point[] }>(`/api/history?hours=${hours}&sensor=${encodeURIComponent(sensor)}&device=${encodeURIComponent(device)}`);
      return [item, result.points] as const;
    })).then(results => { if (active) setHistories(new Map(results)); }).catch(e => {
      if (active) { setHistories(new Map()); setError(`Verlauf konnte nicht geladen werden: ${message(e)}`); }
    });
    return () => { active = false; };
  }, [hours, requestSignature, refreshCount]);

  const setActive = async (id: string) => {
    setBusy(true);
    try {
      await api('/api/active-device', post({ id }));
      setInsights(null);
      await refresh();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const saveDevices = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      await api('/api/devices', post({ indexes: devices.filter(item => item.selected).map(item => item.index) }));
      setSetupMessage('Auswahl gespeichert. Die automatische Erfassung ist aktiv.');
      setSetup(false);
      await refresh();
    } catch (e) {
      setSetupMessage(message(e));
      await refresh();
      setError(message(e));
    } finally { setBusy(false); }
  };
  const latest = Math.max(0, ...(status?.sensors ?? []).map(sensor => sensor.timestamp));
  const stale = status && latest && Date.now() - latest > status.pollSeconds * 2500;
  const connection = serverDown ? 'Verbindung unterbrochen' : !status ? 'Verbindung wird geprüft' : status.error ? 'Erfassung gestört' : !status.connected ? 'Noch nicht verbunden' : !status.device ? 'Bitte Gerät auswählen' : !latest ? 'Warte auf erste Messung' : stale ? 'Messwerte veraltet' : status.demo ? 'Demo ist bereit' : 'Mit Heizung verbunden';
  const selectedSeries = series.filter(item => comparison.has(item.key));
  const empty = selectedSeries.filter(item => !histories.get(item.key)?.length);
  const lines: Line[] = selectedSeries.map(item => ({ label: item.display, points: histories.get(item.key) ?? [], color: colors[item.index % colors.length]!, dash: item.index >= colors.length ? item.index >= colors.length * 2 ? [2, 3] : [7, 4] : [], fill: false }));
  const toggle = (sensor: Series, checked: boolean) => setComparison(previous => { const next = new Set(previous); if (checked) next.add(sensor.key); else next.delete(sensor.key); return next; });
  return <>
    <header className="topbar"><a className="brand" href="/" aria-label="ViMonitor Startseite"><span className="brand-icon" aria-hidden="true">v<span>ı</span></span>vi<span className="brand-light">monitor</span></a><div className="topbar-right"><span id="mode" className={`badge${status?.demo ? ' demo' : ''}`}>{status ? status.demo ? 'Demo-Modus' : 'ViCare API' : 'Wird geladen'}</span><span className="local-note"><span className="lock" aria-hidden="true">▣</span> Lokal gespeichert</span></div></header>
    <main>
      <section className="intro"><div><p className="eyebrow">VIESSMANN · VICARE API</p><h1>Heizungsdaten.<br/><span>Temperaturverläufe.</span></h1><p className="subtitle">Temperaturen und Sollwerte der Heizung. Die Daten werden lokal gespeichert.</p></div>
        <div className="connection-summary"><div className="status-line"><span id="status-dot" className={`dot ${status && !serverDown && !status.error && !stale && status.device ? 'good' : 'warning'}`}></span><strong id="connection">{connection}</strong></div><p id="device-name">{status?.device?.name ?? 'Viessmann · ViCare API'}</p>
          <label id="active-device-label" className="sensor-label" hidden={(status?.devices.length ?? 0) < 2}>Heizung für Einzelansicht und Auswertung<select id="active-device" value={status?.activeDevice ?? ''} disabled={busy || refreshing} onChange={event => { void setActive(event.target.value); }}>{status?.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
          <button id="settings-toggle" className="text-button" aria-expanded={setup} aria-controls="setup" onClick={() => setSetup(!setup)}>Verbindung &amp; Einrichtung <span aria-hidden="true">↗</span></button>
        </div></section>
      <section id="demo-notice" className="notice demo-notice" hidden={!status?.demo}><span className="notice-icon" aria-hidden="true">i</span><div><strong>Demo-Modus.</strong> Angezeigt werden simulierte Messwerte, keine Daten einer Heizung.<button id="demo-setup" className="inline-button" onClick={() => setSetup(true)}>Echten Zugang einrichten</button></div></section>
      <section id="error" className="notice error-notice" role="alert" hidden={!error}>{error}</section>
      <section id="setup" className="setup card" hidden={!setup}><div className="section-title"><h2>Deine Heizung verbinden</h2><button id="setup-close" className="text-button" onClick={() => setSetup(false)}>Schließen</button></div>
        <ol><li>Im <a href="https://app.developer.viessmann-climatesolutions.com" target="_blank" rel="noreferrer">Viessmann-Developer-Portal</a> mit deinem ViCare-Konto anmelden und einen API-Client anlegen.</li><li>Redirect-URI <code id="redirect-uri">{`http://localhost:${location.port}/auth/callback`}</code> registrieren. PKCE verwenden.</li><li>Client-ID lokal in <code>.env</code> eintragen, <code>DEMO_MODE=false</code> setzen und die App neu starten.</li><li>Hier bei Viessmann anmelden und deine Heizgeräte auswählen. Das Passwort wird nur bei Viessmann eingegeben.</li></ol>
        <div className="setup-actions"><a id="login" className="button primary" href="/auth/login" hidden={!!status?.demo}>{status?.connected ? 'Erneut bei Viessmann anmelden ↗' : 'Mit Viessmann verbinden ↗'}</a><button id="load-devices" className="button secondary" hidden={status?.demo || !status?.connected} disabled={busy} onClick={() => { void loadDevices(); }}>Geräteauswahl laden</button></div>
        <form id="device-form" hidden={!devices.length} onSubmit={event => { void saveDevices(event); }}><fieldset><legend>Heizgeräte für die automatische Erfassung</legend><div id="device-options">{devices.map(device => <label className="device-choice" key={device.index}><input type="checkbox" checked={device.selected} onChange={event => setDevices(previous => previous.map(item => item.index === device.index ? { ...item, selected: event.target.checked } : item))}/><span>{device.name} · Gerät {device.deviceId}</span></label>)}</div></fieldset><button className="button primary" type="submit" disabled={busy}>Auswahl speichern</button><p>Jede Heizung benötigt eine eigene API-Abfrage pro Intervall. Bitte das API-Kontingent beachten.</p></form><p id="setup-message" role="status">{setupMessage}</p>
      </section>
      <InsightCards data={insights} error={insightsError}/>
      <section className="overview" aria-labelledby="overview-title"><div className="overview-heading"><div><p className="eyebrow">TEMPERATUREN</p><h2 id="overview-title">Aktuelle Werte und Temperaturverläufe</h2></div><button id="refresh" className="button secondary refresh-button" disabled={refreshing} onClick={() => { void refresh(); }}><span aria-hidden="true">↻</span> Anzeige aktualisieren</button></div>
        <div className="toolbar"><div className="range-control" role="group" aria-label="Zeitraum">{[[24, '24 Stunden'], [168, '7 Tage'], [720, '30 Tage']].map(([value, label]) => <button key={value} data-hours={value} className={hours === value ? 'active' : ''} aria-pressed={hours === value} onClick={() => setHours(Number(value))}>{label}</button>)}</div><span id="updated" className="updated">{latest ? `Letzte Messung: ${date.format(latest)}` : 'Noch keine Messung'}</span></div>
        <div className="chart-grid">{(['flow', 'water'] as const).map(kind => <Metric key={kind} kind={kind} status={status} selected={kind === 'flow' ? flow : water} onSelect={kind === 'flow' ? setFlow : setWater} hours={hours} points={status?.activeDevice ? histories.get(key(status.activeDevice, kind === 'flow' ? flow : water)) ?? [] : []}/>)}</div>
      </section>
      <article className="card chart-card comparison" aria-labelledby="compare-title"><div className="metric-heading"><span className="metric-symbol" aria-hidden="true">≋</span><div><h3 id="compare-title">Temperaturen vergleichen</h3><span className="metric-description">Mehrere Verläufe auf einer gemeinsamen Celsius-Achse</span></div><span className="unit-tag">°C</span></div>
        <fieldset className="compare-picker"><legend>Temperaturen für den Vergleich auswählen</legend><div id="compare-sensors" className="compare-sensors">{series.map(sensor => <label key={sensor.key} title={sensor.sensor} className={`compare-choice color-${sensor.index % colors.length}${sensor.index >= colors.length ? sensor.index >= colors.length * 2 ? ' dotted' : ' dashed' : ''}`}><input type="checkbox" checked={comparison.has(sensor.key)} onChange={event => toggle(sensor, event.target.checked)}/><span>{sensor.display}</span></label>)}</div></fieldset>
        <div className="chart-container compare-container"><HistoryChart id="compare-chart" label="Gemeinsamer Zeitverlauf der ausgewählten Temperaturen" hours={hours} pollSeconds={status?.pollSeconds ?? 300} lines={lines} comparison/><p id="compare-empty" className="chart-empty" hidden={selectedSeries.length > 0 && empty.length !== selectedSeries.length}>{selectedSeries.length ? 'Für diesen Zeitraum liegen keine Messwerte vor.' : 'Bitte mindestens eine Temperatur auswählen.'}</p></div>
        <p id="compare-summary" className="compare-summary" role="status">{selectedSeries.length} von {series.length} Temperaturen ausgewählt{empty.length ? ` · Keine Messwerte: ${empty.map(sensor => sensor.display).join(', ')}` : ''}</p>
      </article>
      <section className="details-strip" aria-label="Informationen zur Erfassung"><div><span className="detail-icon" aria-hidden="true">◷</span><p><strong id="poll-label">Alle {Math.round((status?.pollSeconds ?? 300) / 60)} Minuten</strong><span>Automatische Datenerfassung</span></p></div><div><span className="detail-icon" aria-hidden="true">▤</span><p><strong>Lokale SQLite-Datenbank</strong><span>Dauerhafte Speicherung der Messhistorie</span></p></div><div><span className="detail-icon" aria-hidden="true">✓</span><p><strong>Lesender API-Zugriff</strong><span>Keine Änderung der Heizungseinstellungen</span></p></div></section>
      <p className="chart-note">Lange Zeiträume zeigen zeitliche Mittelwerte. Minima und Maxima findest du im Tooltip. Messlücken werden nicht verbunden.</p>
    </main>
    <footer><span><strong>vimonitor</strong> <span className="footer-divider">/</span> Lokale Erfassung von Heizungsdaten</span><a href="https://github.com/flottokarotto/vimonitor" target="_blank" rel="noreferrer">Quellcode &amp; Anleitung ↗</a></footer>
  </>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard-Element fehlt.');
createRoot(root).render(<App/>);
