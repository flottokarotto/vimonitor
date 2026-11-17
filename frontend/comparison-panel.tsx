import { HistoryChart, colors } from './chart';
import type { Line } from './chart';
import type { Series, Status } from './types';

export function ComparisonPanel({ series, selected, empty, lines, hours, status, onToggle }: {
  series: Series[];
  selected: Series[];
  empty: Series[];
  lines: Line[];
  hours: number;
  status: Status | null;
  onToggle: (key: string, checked: boolean) => void;
}) {
  return <article className="card chart-card comparison" aria-labelledby="compare-title"><div className="metric-heading"><span className="metric-symbol" aria-hidden="true">≋</span><div><h3 id="compare-title">Temperaturen vergleichen</h3><span className="metric-description">Mehrere Verläufe auf einer gemeinsamen Celsius-Achse</span></div><span className="unit-tag">°C</span></div>
    <fieldset className="compare-picker"><legend>Temperaturen für den Vergleich auswählen</legend><div id="compare-sensors" className="compare-sensors">{series.map(sensor => <label key={sensor.key} title={sensor.sensor} className={`compare-choice color-${sensor.index % colors.length}${sensor.index >= colors.length ? sensor.index >= colors.length * 2 ? ' dotted' : ' dashed' : ''}`}><input type="checkbox" checked={selected.some(item => item.key === sensor.key)} onChange={event => onToggle(sensor.key, event.target.checked)}/><span>{sensor.display}</span></label>)}</div></fieldset>
    <div className="chart-container compare-container"><HistoryChart id="compare-chart" label="Gemeinsamer Zeitverlauf der ausgewählten Temperaturen" hours={hours} pollSeconds={status?.pollSeconds ?? 300} lines={lines} comparison/><p id="compare-empty" className="chart-empty" hidden={selected.length > 0 && empty.length !== selected.length}>{selected.length ? 'Für diesen Zeitraum liegen keine Messwerte vor.' : 'Bitte mindestens eine Temperatur auswählen.'}</p></div>
    <p id="compare-summary" className="compare-summary" role="status">{selected.length} von {series.length} Temperaturen ausgewählt{empty.length ? ` · Keine Messwerte: ${empty.map(sensor => sensor.display).join(', ')}` : ''}</p>
  </article>;
}
