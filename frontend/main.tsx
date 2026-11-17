import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ComparisonPanel } from './comparison-panel';
import { DeviceSetup } from './device-setup';
import { InsightCards } from './insights';
import { MetricCard } from './metric-card';
import { useDashboard } from './use-dashboard';

const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function App() {
  const dashboard = useDashboard();
  const [setup, setSetup] = useState(false);
  const { status, busy, refreshing, serverDown } = dashboard;
  const latest = Math.max(0, ...(status?.sensors ?? []).map(sensor => sensor.timestamp));
  const stale = status && latest && Date.now() - latest > status.pollSeconds * 2500;
  const connection = serverDown ? 'Verbindung unterbrochen'
    : !status ? 'Verbindung wird geprüft'
      : status.error ? 'Erfassung gestört'
        : !status.connected ? 'Noch nicht verbunden'
          : !status.device ? 'Bitte Gerät auswählen'
            : !latest ? 'Warte auf erste Messung'
              : stale ? 'Messwerte veraltet'
                : status.demo ? 'Demo ist bereit' : 'Mit Heizung verbunden';

  useEffect(() => {
    if (status && !status.demo && (!status.connected || !status.device)) setSetup(true);
  }, [status]);

  const selectDevice = (id: string) => { void dashboard.setActive(id); };
  const toggleDevice = (index: number, selected: boolean) => {
    dashboard.setDevices(previous => previous.map(item => item.index === index ? { ...item, selected } : item));
  };

  return <>
    <header className="topbar"><a className="brand" href="/" aria-label="ViMonitor Startseite"><span className="brand-icon" aria-hidden="true">v<span>ı</span></span>vi<span className="brand-light">monitor</span></a><div className="topbar-right"><span id="mode" className={`badge${status?.demo ? ' demo' : ''}`}>{status ? status.demo ? 'Demo-Modus' : 'ViCare API' : 'Wird geladen'}</span><span className="local-note"><span className="lock" aria-hidden="true">▣</span> Lokal gespeichert</span></div></header>
    <main>
      <section className="intro"><div><p className="eyebrow">VIESSMANN · VICARE API</p><h1>Heizungsdaten.<br/><span>Temperaturverläufe.</span></h1><p className="subtitle">Temperaturen und Sollwerte der Heizung. Die Daten werden lokal gespeichert.</p></div>
        <div className="connection-summary"><div className="status-line"><span id="status-dot" className={`dot ${status && !serverDown && !status.error && !stale && status.device ? 'good' : 'warning'}`}></span><strong id="connection">{connection}</strong></div><p id="device-name">{status?.device?.name ?? 'Viessmann · ViCare API'}</p>
          <label id="active-device-label" className="sensor-label" hidden={(status?.devices.length ?? 0) < 2}>Heizung für Einzelansicht und Auswertung<select id="active-device" value={status?.activeDevice ?? ''} disabled={busy || refreshing} onChange={event => selectDevice(event.target.value)}>{status?.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
          <button id="settings-toggle" className="text-button" aria-expanded={setup} aria-controls="setup" onClick={() => setSetup(!setup)}>Verbindung &amp; Einrichtung <span aria-hidden="true">↗</span></button>
        </div></section>
      <section id="demo-notice" className="notice demo-notice" hidden={!status?.demo}><span className="notice-icon" aria-hidden="true">i</span><div><strong>Demo-Modus.</strong> Angezeigt werden simulierte Messwerte, keine Daten einer Heizung.<button id="demo-setup" className="inline-button" onClick={() => setSetup(true)}>Echten Zugang einrichten</button></div></section>
      <section id="error" className="notice error-notice" role="alert" hidden={!dashboard.error}>{dashboard.error}</section>
      <DeviceSetup open={setup} onClose={() => setSetup(false)} status={status} devices={dashboard.devices} busy={busy} message={dashboard.setupMessage}
        onLoadDevices={() => { void dashboard.loadDevices(); }} onToggleDevice={toggleDevice}
        onSaveDevices={dashboard.saveDevices}/>
      <InsightCards data={dashboard.insights} error={dashboard.insightsError}/>
      <section className="overview" aria-labelledby="overview-title"><div className="overview-heading"><div><p className="eyebrow">TEMPERATUREN</p><h2 id="overview-title">Aktuelle Werte und Temperaturverläufe</h2></div><button id="refresh" className="button secondary refresh-button" disabled={refreshing} onClick={() => { void dashboard.refresh(); }}><span aria-hidden="true">↻</span> Anzeige aktualisieren</button></div>
        <div className="toolbar"><div className="range-control" role="group" aria-label="Zeitraum">{[[24, '24 Stunden'], [168, '7 Tage'], [720, '30 Tage']].map(([value, label]) => <button key={value} data-hours={value} className={dashboard.hours === value ? 'active' : ''} aria-pressed={dashboard.hours === value} onClick={() => dashboard.setHours(Number(value))}>{label}</button>)}</div><span id="updated" className="updated">{latest ? `Letzte Messung: ${date.format(latest)}` : 'Noch keine Messung'}</span></div>
        <div className="chart-grid">{(['flow', 'water'] as const).map(kind => <MetricCard key={kind} kind={kind} status={status}
          selected={kind === 'flow' ? dashboard.flow : dashboard.water}
          onSelect={kind === 'flow' ? dashboard.setFlow : dashboard.setWater} hours={dashboard.hours}
          points={status?.activeDevice ? dashboard.histories.get(JSON.stringify([status.activeDevice, kind === 'flow' ? dashboard.flow : dashboard.water])) ?? [] : []}/>)}</div>
      </section>
      <ComparisonPanel series={dashboard.series} selected={dashboard.selectedSeries} empty={dashboard.emptySeries}
        lines={dashboard.comparisonLines} hours={dashboard.hours} status={status} onToggle={dashboard.toggleSeries}/>
      <section className="details-strip" aria-label="Informationen zur Erfassung"><div><span className="detail-icon" aria-hidden="true">◷</span><p><strong id="poll-label">Alle {Math.round((status?.pollSeconds ?? 300) / 60)} Minuten</strong><span>Automatische Datenerfassung</span></p></div><div><span className="detail-icon" aria-hidden="true">▤</span><p><strong>Lokale SQLite-Datenbank</strong><span>Dauerhafte Speicherung der Messhistorie</span></p></div><div><span className="detail-icon" aria-hidden="true">✓</span><p><strong>Lesender API-Zugriff</strong><span>Keine Änderung der Heizungseinstellungen</span></p></div></section>
      <p className="chart-note">Lange Zeiträume zeigen zeitliche Mittelwerte. Minima und Maxima findest du im Tooltip. Messlücken werden nicht verbunden.</p>
    </main>
    <footer><span><strong>vimonitor</strong> <span className="footer-divider">/</span> Lokale Erfassung von Heizungsdaten</span><a href="https://github.com/flottokarotto/vimonitor" target="_blank" rel="noreferrer">Quellcode &amp; Anleitung ↗</a></footer>
  </>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard-Element fehlt.');
createRoot(root).render(<App/>);
