import { record } from './model.ts';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const SCHEDULE_TIME_ZONE = 'Europe/Berlin';
export type Day = typeof DAYS[number];
export interface ScheduleEntry { start: string; end: string; mode: string }
export interface Schedule {
  feature: string;
  label: string;
  kind: 'water' | 'heating';
  active: boolean;
  entries: Record<Day, ScheduleEntry[]>;
}
export interface ScheduleSnapshot {
  timestamp: number;
  pollSeconds: number;
  schedules: Schedule[];
  error: string | null;
}

function minutes(value: string) {
  const [hours, mins] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
}

export function parseSchedules(features: unknown[]): Schedule[] {
  const schedules: Schedule[] = [];
  for (const raw of features) {
    const feature = record(raw);
    if (typeof feature.feature !== 'string') continue;
    const name = feature.feature;
    const circuit = name.match(/^heating\.circuits\.(\d+)\.heating\.schedule$/);
    if (name !== 'heating.dhw.schedule' && !circuit) continue;
    if (feature.isEnabled === false || feature.isReady === false) continue;
    const properties = record(feature.properties);
    const active = record(properties.active).value;
    if (typeof active !== 'boolean') throw new Error(`Zeitprogramm ${name}: Aktivierungsstatus fehlt.`);
    const values = record(record(properties.entries).value);
    const entries: Record<Day, ScheduleEntry[]> = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    const occupied = new Set<number>();
    for (const [dayIndex, day] of DAYS.entries()) {
      const slots = values[day];
      if (!Array.isArray(slots)) throw new Error(`Zeitprogramm ${name}: ${day} fehlt.`);
      entries[day] = slots.map(rawEntry => {
        const entry = record(rawEntry);
        if (typeof entry.start !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry.start)
          || typeof entry.end !== 'string' || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(entry.end)
          || typeof entry.mode !== 'string' || !entry.mode) {
          throw new Error(`Zeitprogramm ${name}: ungueltiger Zeiteintrag.`);
        }
        const start = minutes(entry.start);
        let end = minutes(entry.end);
        if (end === start) throw new Error(`Zeitprogramm ${name}: Zeitfenster ohne eindeutige Dauer.`);
        if (end < start) end += 1440;
        for (let minute = start; minute < end; minute++) {
          const weekMinute = (dayIndex * 1440 + minute) % (7 * 1440);
          if (occupied.has(weekMinute)) throw new Error(`Zeitprogramm ${name}: ueberlappende Zeitfenster.`);
          occupied.add(weekMinute);
        }
        return { start: entry.start, end: entry.end, mode: entry.mode };
      }).sort((a, b) => a.start.localeCompare(b.start));
    }
    if (name === 'heating.dhw.schedule'
      && Object.values(entries).flat().some(entry => !['on', 'off'].includes(entry.mode))) {
      throw new Error('Warmwasser-Zeitprogramm: unbekannter Betriebsmodus; keine automatische Auswertung.');
    }
    schedules.push({
      feature: name, label: circuit ? `Heizkreis ${Number(circuit[1]) + 1}` : 'Warmwasser',
      kind: circuit ? 'heating' : 'water', active, entries,
    });
  }
  return schedules;
}

const localFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: SCHEDULE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function localParts(timestamp: number) {
  const parts = Object.fromEntries(localFormat.formatToParts(timestamp).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  };
}

// Night boundaries avoid the ambiguous or missing hour at daylight-saving changes.
export function localNightBoundary(dayUtc: number, hour: 10 | 18): number {
  const target = dayUtc + hour * 3600_000;
  let time = target;
  for (let i = 0; i < 3; i++) {
    const parts = localParts(time);
    time += target - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  }
  return time;
}

export function waterScheduledOn(schedule: Schedule, timestamp: number): boolean {
  const local = localParts(timestamp);
  const dayIndex = (new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay() + 6) % 7;
  const day = DAYS[dayIndex]!;
  const previous = DAYS[(dayIndex + 6) % 7]!;
  const minute = local.hour * 60 + local.minute;
  return schedule.entries[day].some(entry => {
    const start = minutes(entry.start);
    const end = minutes(entry.end);
    return entry.mode === 'on' && minute >= start && (end > start ? minute < end : true);
  }) || schedule.entries[previous].some(entry => {
    const start = minutes(entry.start);
    const end = minutes(entry.end);
    return entry.mode === 'on' && end < start && minute < end;
  });
}
