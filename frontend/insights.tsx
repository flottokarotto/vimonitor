import type { Day, ScheduleEntry } from '../src/schedules.ts';
import type { Insights } from './types';

const days: [Day, string][] = [['mon', 'Montag'], ['tue', 'Dienstag'], ['wed', 'Mittwoch'], ['thu', 'Donnerstag'], ['fri', 'Freitag'], ['sat', 'Samstag'], ['sun', 'Sonntag']];
const number = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function entriesText(entries: ScheduleEntry[]) {
  const modes: Record<string, string> = { on: 'Warmwasser freigegeben', off: 'Warmwasser aus', normal: 'Normalbetrieb', comfort: 'Komfortbetrieb', reduced: 'Absenkbetrieb', standby: 'Bereitschaft' };
  return entries.length ? entries.map(entry => `${entry.start}–${entry.end} Uhr · ${modes[entry.mode] ?? entry.mode}`).join('; ') : 'Keine Zeitfenster eingetragen';
}

export function InsightCards({ data, error }: { data: Insights | null; error: string | null }) {
  const night = data?.lastNight;
  const valid = night?.status === 'ok' && night.rate !== null && night.drop !== null
    && night.measuredStart !== null && night.measuredEnd !== null && night.startTemperature !== null && night.endTemperature !== null && night.level !== null;
  const levels = { low: 'Geringer Temperaturabfall', moderate: 'Mittlerer Temperaturabfall', high: 'Stärkerer Temperaturabfall' };
  const date = data ? new Intl.DateTimeFormat('de-DE', { timeZone: data.timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
  const todayName = data ? new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: data.timeZone }).format(Date.now()) : '';
  const day = days.find(([, label]) => label === todayName)?.[0];
  const comparison = data?.comparison;
  const badge = error ? 'Ladefehler' : valid ? levels[night.level!] : night?.status === 'disturbed' || night?.status === 'schedule-changed' ? 'Nicht bewertbar' : data ? 'Noch keine Auswertung' : 'Wird geladen';
  return <section className="insights" aria-labelledby="insights-title">
    <div className="overview-heading"><div><p className="eyebrow">AUTOMATISCHE AUSWERTUNG</p><h2 id="insights-title">Warmwasser nachts und eingestellte Zeiten</h2></div></div>
    <div className="insight-grid">
      <article className="card insight-card">
        <div className="section-title"><h3>Abkühlung in der letzten Nachtpause</h3><span id="cooling-badge" className={`badge${valid && night.level === 'high' ? ' caution' : ''}`}>{badge}</span></div>
        <p id="cooling-message" className="insight-message" role="status">{error ? `Auswertung nicht verfügbar: ${error}` : valid ? 'Beobachteter Temperaturabfall während einer planmäßigen Warmwasser-Pause. Die Einordnung ist eine grobe Orientierung.' : data?.message ?? 'Die Auswertung wird geladen.'}</p>
        <div id="cooling-values" className="cooling-values" hidden={!valid}>
          <div><strong id="cooling-rate">{valid ? number.format(night.rate!) : '—'}</strong><span>°C pro Stunde</span></div>
          <div><strong id="cooling-drop">{valid ? number.format(night.drop!) : '—'}</strong><span>°C Abfall insgesamt</span></div>
        </div>
        <p id="cooling-window" className="insight-detail">{night && date && data ? `Planmäßige Pause: ${date.format(night.start)}–${date.format(night.end)} Uhr (${data.timeZone}).${valid ? ` Ausgewertet: ${date.format(night.measuredStart!)}–${date.format(night.measuredEnd!)} Uhr, von ${number.format(night.startTemperature!)} auf ${number.format(night.endTemperature!)} °C.` : ''}` : ''}</p>
        <p id="cooling-comparison" className="insight-detail">{error ? '' : comparison ? `Vergleich mit ${comparison.nights} früheren Nächten: ${comparison.trend === 'faster' ? 'schnellerer' : comparison.trend === 'slower' ? 'langsamerer' : 'ähnlicher'} Temperaturabfall. Bisheriger Median: ${number.format(comparison.medianRate)} °C/h.` : 'Der Vergleich mit eigenen früheren Nächten erscheint automatisch, sobald mindestens drei vergleichbare Nächte vorliegen.'}</p>
        <p className="insight-caution">Grobe Orientierung, keine Diagnose: Wasserentnahme, Zirkulation und die Position des Fühlers beeinflussen den Verlauf. Ein Zeitprogramm beweist nicht, dass nicht nachgeheizt wurde.</p>
        <details className="insight-method"><summary>Wie wird das eingeordnet?</summary>
          <p>Projektinterne Orientierungsstufen, keine technischen Norm- oder Hygienegrenzwerte: bis 0,5 °C/h geringer, über 0,5 bis 1,5 °C/h mittlerer, über 1,5 °C/h stärkerer beobachteter Temperaturabfall. Ein stärkerer Abfall allein belegt keinen Defekt oder unnötigen Energieverbrauch.</p>
          <p>Ausgewertet wird automatisch die längste abgeschlossene Warmwasser-Pause je Nacht im Abschnitt 18–10 Uhr, höchstens die letzten 14 Nächte. Die ersten 30 Minuten nach Ende der Freigabe und die letzten 10 Minuten vor ihrem Beginn bleiben unberücksichtigt.</p>
          <p>Mindestens zwei Stunden Messdauer, sechs Messwerte und durchgehend aufgezeichnete Zeitprogramme sind erforderlich. Größere Lücken, Programmänderungen sowie erkennbare Temperaturanstiege oder abrupte Abfälle verhindern eine Bewertung. Berechnet wird die Differenz zwischen erstem und letztem Messwert geteilt durch die tatsächlich verstrichene Zeit.</p>
          <p>Ab drei früheren auswertbaren Nächten mit ähnlicher Starttemperatur (±5 °C) und Pausendauer (±25 %) wird mit deren Median verglichen. Das ist ebenfalls nur ein Anhaltspunkt. Warmwasser-Sollwerte nicht allein anhand dieser Anzeige absenken; Anforderungen an die Trinkwasserhygiene beachten.</p>
        </details>
      </article>
      <article className="card insight-card">
        <h3>Zeitprogramme</h3>
        <p id="schedule-status" className="insight-detail" role="status">{error ? 'Zeitprogramme konnten nicht geladen werden.' : data?.observedAt && date ? `${data.stale ? 'Veraltet · ' : ''}Stand ${date.format(data.observedAt)} Uhr · ${data.timeZone}` : 'Noch keine Zeitprogramme aufgezeichnet. Sie werden bei der nächsten Messabfrage mitgelesen.'}</p>
        <div id="schedule-today" className="schedule-today">{data?.schedules.length === 0 && <p className="insight-detail">{data.message}</p>}{data?.schedules.map(schedule => <div className="schedule-item" key={schedule.feature}><strong>{schedule.label} · heute ({todayName}){schedule.active ? '' : ' · Zeitprogramm nicht aktiv'}</strong><p>{day ? entriesText(schedule.entries[day]) : 'Wochentag konnte nicht bestimmt werden.'}</p></div>)}</div>
        <details id="schedule-week" className="insight-method" hidden={!data?.schedules.length}><summary>Alle Wochentage anzeigen</summary><div id="schedule-week-content">{data?.schedules.map(schedule => <table className="schedule-week-table" key={schedule.feature}><caption>{schedule.label}{schedule.active ? '' : ' (nicht aktiv)'}</caption><tbody>{days.map(([key, name]) => <tr key={key}><th scope="row">{name}</th><td>{entriesText(schedule.entries[key])}</td></tr>)}</tbody></table>)}</div></details>
        <p className="insight-caution">Die Zeiten sind Freigaben bzw. Betriebsprogramme, keine tatsächlichen Brennerlaufzeiten. Außerhalb der Heizzeiten kann beispielsweise Absenkbetrieb gelten.</p>
        <p className="insight-detail">Ob der Vorlauf zu warm ist, lässt sich daraus allein nicht bestimmen. Dafür sind unter anderem Außentemperatur, Raumtemperatur und Heizflächen erforderlich.</p>
      </article>
    </div>
  </section>;
}
