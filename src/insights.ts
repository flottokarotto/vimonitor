import type { Device } from './model.ts';
import type { Store } from './store.ts';
import { localNightBoundary, localParts, SCHEDULE_TIME_ZONE, waterScheduledOn } from './schedules.ts';
import type { Schedule, ScheduleSnapshot } from './schedules.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const COOLING_ORIENTATION = { lowMax: 0.5, moderateMax: 1.5 };
interface Reading { timestamp: number; value: number }
interface Pause { start: number; end: number; schedule: Schedule }
type NightStatus = 'ok' | 'insufficient' | 'schedule-changed' | 'disturbed';
export interface NightResult {
  start: number;
  end: number;
  status: NightStatus;
  reason: string;
  measuredStart: number | null;
  measuredEnd: number | null;
  startTemperature: number | null;
  endTemperature: number | null;
  drop: number | null;
  rate: number | null;
  level: 'low' | 'moderate' | 'high' | null;
}

function snapshotAt(snapshots: ScheduleSnapshot[], timestamp: number): ScheduleSnapshot | undefined {
  let low = 0;
  let high = snapshots.length - 1;
  let result: ScheduleSnapshot | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = snapshots[mid];
    if (!candidate) break;
    if (candidate.timestamp <= timestamp) { result = candidate; low = mid + 1; }
    else high = mid - 1;
  }
  return result;
}

function waterProgram(snapshot: ScheduleSnapshot | undefined) {
  return snapshot?.schedules.find(schedule => schedule.kind === 'water');
}

function maxGap(snapshot: ScheduleSnapshot) {
  return Math.min(15 * MINUTE, snapshot.pollSeconds * 2500);
}

function nightPauses(snapshots: ScheduleSnapshot[], current: Schedule, now: number): Pause[] {
  const local = localParts(now);
  const today = Date.UTC(local.year, local.month - 1, local.day);
  const pauses: Pause[] = [];
  for (let day = 0; day < 15; day++) {
    const date = today - day * 24 * HOUR;
    const start = localNightBoundary(date, 18);
    const end = localNightBoundary(date + 24 * HOUR, 10);
    if (start >= now) continue;
    const schedule = waterProgram(snapshotAt(snapshots, start)) ?? current;
    if (!schedule.active) continue;
    let pauseStart: number | undefined;
    const candidates: Pause[] = [];
    for (let time = start; time <= end; time += MINUTE) {
      if (time < end && !waterScheduledOn(schedule, time)) {
        pauseStart ??= time;
      } else if (pauseStart !== undefined) {
        if (time - pauseStart >= 2 * HOUR && time <= now) candidates.push({ start: pauseStart, end: time, schedule });
        pauseStart = undefined;
      }
    }
    const longest = candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (longest) pauses.push(longest);
  }
  return pauses.sort((a, b) => b.end - a.end).slice(0, 14);
}

export function evaluateNight(pause: Pause, readings: Reading[], snapshots: ScheduleSnapshot[]): NightResult {
  const result: NightResult = {
    start: pause.start, end: pause.end, status: 'insufficient', reason: '',
    measuredStart: null, measuredEnd: null, startTemperature: null, endTemperature: null,
    drop: null, rate: null, level: null,
  };
  const scheduleSignature = JSON.stringify(pause.schedule);
  for (let time = pause.start; time < pause.end; time += MINUTE) {
    const snapshot = snapshotAt(snapshots, time);
    if (!snapshot || snapshot.error || time - snapshot.timestamp > maxGap(snapshot)) {
      result.reason = 'Das Zeitprogramm ist fuer diese Nacht nicht lueckenlos aufgezeichnet. Ab der naechsten vollstaendig erfassten Nacht ist eine Auswertung moeglich.';
      return result;
    }
    const program = waterProgram(snapshot);
    if (!program?.active || JSON.stringify(program) !== scheduleSignature) {
      result.status = 'schedule-changed';
      result.reason = 'Das Warmwasser-Zeitprogramm wurde waehrend der Nacht geaendert oder deaktiviert.';
      return result;
    }
  }
  const firstSnapshot = snapshotAt(snapshots, pause.start);
  if (!firstSnapshot) return result;
  const gap = maxGap(firstSnapshot);
  // Exclude the settling period after scheduled heating and the next start boundary.
  const from = pause.start + 30 * MINUTE;
  const to = pause.end - 10 * MINUTE;
  const points = readings.filter(point => point.timestamp >= from && point.timestamp <= to);
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 6 || last.timestamp - first.timestamp < 2 * HOUR
    || first.timestamp - from > gap || to - last.timestamp > gap
    || points.some((point, index) => index > 0 && point.timestamp - points[index - 1]!.timestamp > gap)) {
    result.reason = 'Noch nicht genuegend zusammenhaengende Messwerte: mindestens zwei Stunden, sechs Werte und keine Luecke ueber 15 Minuten erforderlich.';
    return result;
  }
  let rises = 0;
  for (let index = 1; index < points.length; index++) {
    const change = points[index]!.value - points[index - 1]!.value;
    rises += Math.max(0, change);
    if (change >= 0.5 - 1e-8 || change <= -2 + 1e-8 || rises >= 1 - 1e-8) {
      result.status = 'disturbed';
      result.reason = 'Temperaturanstieg oder abrupter Abfall erkannt. Nachheizen, Entnahme oder Fuehlereffekte sind moeglich; keine belastbare Abkuehlbewertung.';
      return result;
    }
  }
  const drop = first.value - last.value;
  const rate = drop / ((last.timestamp - first.timestamp) / HOUR);
  if (drop < 0) {
    result.status = 'disturbed';
    result.reason = 'Die Temperatur ist insgesamt gestiegen. Diese Nacht eignet sich nicht zur Abkuehlbewertung.';
    return result;
  }
  result.status = 'ok';
  result.reason = 'Beobachteter Temperaturabfall in einer planmaessigen Warmwasser-Pause.';
  result.measuredStart = first.timestamp;
  result.measuredEnd = last.timestamp;
  result.startTemperature = first.value;
  result.endTemperature = last.value;
  result.drop = drop;
  result.rate = rate;
  result.level = rate <= COOLING_ORIENTATION.lowMax + 1e-8 ? 'low'
    : rate <= COOLING_ORIENTATION.moderateMax + 1e-8 ? 'moderate' : 'high';
  return result;
}

export function buildInsights(store: Store, device: Device | undefined, now = Date.now()) {
  const snapshots = device ? store.scheduleSnapshots(device, now - 16 * 24 * HOUR, now) : [];
  const latest = snapshots.at(-1);
  const stale = latest ? now - latest.timestamp > maxGap(latest) : true;
  const sensorIds = [
    'heating.dhw.sensors.temperature.hotWaterStorage:value',
    'heating.dhw.sensors.temperature.main:value',
    'heating.dhw.sensors.temperature.dhwCylinder:value',
    'demo.water',
  ];
  const sensors = device ? store.sensors(device) : [];
  const sensor = sensorIds.find(id => sensors.some(item => item.sensor === id));
  const currentWater = waterProgram(latest);
  const nights = device && currentWater?.active && !latest?.error && !stale && sensor
    ? nightPauses(snapshots, currentWater, now).map(pause =>
      evaluateNight(pause, store.readings(device, sensor, pause.start, pause.end), snapshots))
    : [];
  const lastNight = nights[0] ?? null;
  const previousRates = nights.slice(1).filter(night => night.status === 'ok' && night.rate !== null
    && night.startTemperature !== null && lastNight?.startTemperature !== null && lastNight?.startTemperature !== undefined
    && Math.abs(night.startTemperature - lastNight.startTemperature) <= 5
    && Math.abs((night.end - night.start) / (lastNight.end - lastNight.start) - 1) <= 0.25)
    .map(night => night.rate!).sort((a, b) => a - b);
  let comparison: { nights: number; medianRate: number; differencePercent: number | null; trend: 'similar' | 'faster' | 'slower' } | null = null;
  if (lastNight?.rate !== null && lastNight?.rate !== undefined && previousRates.length >= 3) {
    const middle = Math.floor(previousRates.length / 2);
    const median = previousRates.length % 2 ? previousRates[middle]! : (previousRates[middle - 1]! + previousRates[middle]!) / 2;
    const difference = lastNight.rate - median;
    const margin = Math.max(0.2, median * 0.25);
    comparison = {
      nights: previousRates.length, medianRate: median,
      differencePercent: median >= 0.1 ? difference / median * 100 : null,
      trend: difference > margin ? 'faster' : difference < -margin ? 'slower' : 'similar',
    };
  }
  let message: string;
  if (!device) message = 'Zuerst ein Heizgeraet verbinden.';
  else if (latest?.error) message = latest.error;
  else if (!latest || stale) message = 'Zeitprogramme noch nicht verfuegbar oder veraltet. Die naechste erfolgreiche Messabfrage aktualisiert sie.';
  else if (!currentWater) message = 'Die API liefert kein auswertbares Warmwasser-Zeitprogramm.';
  else if (!currentWater.active) message = 'Das Warmwasser-Zeitprogramm ist nicht aktiv. Keine automatische Nachtbewertung.';
  else if (!sensor) message = 'Kein bekannter Warmwasser-Isttemperaturfuehler verfuegbar.';
  else if (!lastNight) message = 'Noch keine abgeschlossene naechtliche Warmwasser-Pause von mindestens zwei Stunden gefunden.';
  else message = lastNight.reason;
  return {
    timeZone: SCHEDULE_TIME_ZONE, observedAt: latest?.timestamp ?? null,
    stale, schedules: latest?.schedules ?? [], message, sensor: sensor ?? null,
    lastNight, comparison, orientation: COOLING_ORIENTATION,
    comparableNights: previousRates.length,
  };
}
