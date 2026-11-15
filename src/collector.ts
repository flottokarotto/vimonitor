import type { Config } from './config.ts';
import { parseTemperatures } from './model.ts';
import type { Store } from './store.ts';
import { ApiError, type Viessmann } from './viessmann.ts';
import { DAYS, localParts, parseSchedules } from './schedules.ts';
import type { Schedule } from './schedules.ts';

export class Collector {
  error: string | null = null;
  nextPollAt: number | null = null;
  running = false;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = true;
  private store: Store;
  private api: Viessmann;
  private config: Config;
  private now: () => number;
  private finished: Promise<void> = Promise.resolve();
  private resolveFinished: (() => void) | undefined;

  constructor(config: Config, store: Store, api: Viessmann, now = Date.now) {
    this.config = config;
    this.store = store;
    this.api = api;
    this.now = now;
  }

  async start() { this.stopped = false; await this.poll(); }

  async poll() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
    let delay = this.config.pollSeconds;
    try {
      if (this.config.demo) {
        this.demo();
      } else {
        const device = this.store.getDevice();
        if (device && this.api.connected()) {
          const features = await this.api.features(device);
          const temperatures = parseTemperatures(features);
          if (!temperatures.length) throw new Error('Keine freigegebenen Celsius-Sensoren gefunden. API-Paket und Geraet pruefen.');
          const timestamp = this.now();
          this.store.saveReadings(device, timestamp, temperatures);
          let schedules: Schedule[];
          let scheduleError: string | null = null;
          try {
            schedules = parseSchedules(features);
          } catch (error) {
            scheduleError = error instanceof Error ? error.message : 'Zeitprogramme konnten nicht gelesen werden.';
            console.error(`Zeitprogramme: ${scheduleError}`);
            schedules = [];
          }
          this.store.saveSchedules(device, { timestamp, pollSeconds: this.config.pollSeconds, schedules, error: scheduleError });
        }
      }
      this.error = null;
      this.failures = 0;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Unbekannter Fehler bei der Datenerfassung.';
      console.error(`Datenerfassung: ${this.error}`);
      this.failures++;
      delay = Math.min(3600, this.config.pollSeconds * 2 ** Math.min(this.failures, 5));
      if (error instanceof ApiError) delay = Math.max(delay, error.retrySeconds);
    } finally {
      this.running = false;
      this.resolveFinished?.();
      if (!this.stopped) {
        this.nextPollAt = this.now() + delay * 1000;
        this.timer = setTimeout(() => { void this.poll(); }, delay * 1000);
        this.timer.unref();
      }
    }
  }

  async restart() {
    if (this.running) throw new ApiError('Messabfrage laeuft bereits. Bitte kurz warten.', 409);
    if (this.timer) clearTimeout(this.timer);
    this.stopped = false;
    await this.poll();
  }

  stop() {
    this.stopped = true;
    this.nextPollAt = null;
    if (this.timer) clearTimeout(this.timer);
  }

  async waitForIdle() { await this.finished; }

  private demo() {
    const device = { installationId: 'demo', gatewaySerial: 'demo', deviceId: '0', name: 'Demo-Heizung' };
    this.store.setDevice(device);
    const last = this.store.sensors(device)[0]?.timestamp;
    const now = Math.floor(this.now() / 300_000) * 300_000;
    const start = typeof last === 'number' ? last + 300_000 : now - 7 * 86400_000;
    const schedules = parseSchedules([
      { feature: 'heating.dhw.schedule', properties: {
        active: { value: true },
        entries: { value: Object.fromEntries(DAYS.map(day => [day, [{ start: '05:00', end: '22:00', mode: 'on' }]])) },
      } },
      { feature: 'heating.circuits.0.heating.schedule', properties: {
        active: { value: true },
        entries: { value: Object.fromEntries(DAYS.map(day => [day, [{ start: '05:00', end: '22:30', mode: 'normal' }]])) },
      } },
    ]);
    for (let time = start; time <= now; time += 300_000) {
      const hour = time / 3600_000;
      const local = localParts(time);
      const localHour = local.hour + local.minute / 60;
      const water = localHour >= 22 ? 52 - (localHour - 22) * 0.7
        : localHour < 5 ? 52 - (localHour + 2) * 0.7 : 52 + 0.4 * Math.sin(hour);
      this.store.saveReadings(device, time, [
        { sensor: 'demo.flow', label: 'Vorlauf', kind: 'flow', value: 38 + 7 * Math.sin(hour / 3) + 2 * Math.sin(hour * 4) },
        { sensor: 'demo.water', label: 'Warmwasser', kind: 'water', value: water },
        { sensor: 'demo.outside', label: 'Aussentemperatur', kind: 'other', value: 7 + 4 * Math.sin(hour / 4) },
      ]);
      this.store.saveSchedules(device, { timestamp: time, pollSeconds: 300, schedules, error: null });
    }
    this.store.saveSchedules(device, { timestamp: this.now(), pollSeconds: this.config.pollSeconds, schedules, error: null });
  }
}
