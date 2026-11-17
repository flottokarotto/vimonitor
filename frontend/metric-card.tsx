import { HistoryChart, colors } from './chart';
import type { Line } from './chart';
import type { Kind, Point, Status } from './types';

const number = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function MetricCard({ kind, status, selected, onSelect, points, hours }: {
  kind: Kind;
  status: Status | null;
  selected: string;
  onSelect: (value: string) => void;
  points: Point[];
  hours: number;
}) {
  const sensors = status?.sensors ?? [];
  const sensor = sensors.find(item => item.sensor === selected);
  const manual = sensor && sensor.kind !== kind;
  const title = manual ? sensor.label : kind === 'flow' ? 'Vorlauftemperatur' : 'Warmwassertemperatur';
  const stale = sensor && status && Date.now() - sensor.timestamp > status.pollSeconds * 2500;
  const candidates = sensors.filter(item => item.kind === kind);
  const others = sensors.filter(item => item.kind !== kind);
  const lines: Line[] = [{
    label: title,
    points,
    color: kind === 'flow' ? colors[0]! : colors[1]!,
    fill: true,
  }];
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
