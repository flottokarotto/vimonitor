import type { Config } from './config.ts';
import { deviceKey, deviceLabels } from './model.ts';
import type { Store } from './store.ts';
import { HeatingError } from './heating.ts';
import type { HeatingReader } from './heating.ts';
import { HttpError } from './http-error.ts';
import { DAYS, localParts, parseSchedules } from './schedules.ts';
import { logger } from './logger.ts';

const communicationError = (error: unknown): error is HeatingError => error instanceof HeatingError
  && error.status === 400 && error.message.includes('DEVICE_COMMUNICATION_ERROR');

class CollectionError extends Error {
  retrySeconds: number;
  failedDevices: string[];
  communicationOnly: boolean;
  constructor(message: string, retrySeconds: number, failedDevices: string[], communicationOnly: boolean) {
    super(message);
    this.retrySeconds = retrySeconds;
    this.failedDevices = failedDevices;
    this.communicationOnly = communicationOnly;
  }
}

export class Collector {
  error: string | null = null;
  nextPollAt: number | null = null;
  running = false;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = true;
  private store: Store;
  private api: HeatingReader;
  private config: Config;
  private now: () => number;
  private finished: Promise<void> = Promise.resolve();
  private resolveFinished: (() => void) | undefined;

  constructor(config: Config, store: Store, api: HeatingReader, now = Date.now) {
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
    let collectedDevices = 0;
    let collectedSensors = 0;
    try {
      if (this.config.demo) {
        this.demo();
      } else {
        const failures: string[] = [];
        const failedDevices: string[] = [];
        let retrySeconds = 0;
        let communicationOnly = true;
        const selected = this.store.getDevices();
        const labels = deviceLabels(selected);
        if (this.api.connected()) {
          for (const device of selected) {
            if (this.stopped) break;
            try {
              const { temperatures, schedules, scheduleError } = await this.api.read(device);
              if (!temperatures.length) throw new Error('Keine freigegebenen Celsius-Sensoren gefunden. API-Paket und Geraet pruefen.');
              const timestamp = this.now();
              this.store.saveSnapshot(device, temperatures, {
                timestamp, pollSeconds: this.config.pollSeconds, schedules, error: scheduleError,
              });
              collectedDevices++;
              collectedSensors += temperatures.length;
              if (scheduleError) logger.warn(`Zeitprogramme · ${device.name} · ${scheduleError}`);
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unbekannter Fehler bei der Datenerfassung.';
              const label = labels.get(deviceKey(device)) ?? device.name;
              failures.push(`${label}: ${message}`);
              failedDevices.push(label);
              communicationOnly = communicationOnly && communicationError(error);
              if (error instanceof HeatingError) retrySeconds = Math.max(retrySeconds, error.retrySeconds);
              if (error instanceof HeatingError && (error.status === 429 || error.status === 401)) {
                break;
              }
            }
          }
        }
        if (collectedDevices > 0) {
          logger.info(`Messwerte erfasst · ${collectedDevices} Heizgerät(e) · ${collectedSensors} Sensorwerte.`);
        }
        if (failures.length) throw new CollectionError(failures.join(' | '), retrySeconds, failedDevices, communicationOnly);
      }
      this.error = null;
      this.failures = 0;
      if (this.config.demo) logger.info('Demo-Daten aktualisiert.');
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Unbekannter Fehler bei der Datenerfassung.';
      if (error instanceof CollectionError) {
        logger.error(`Datenerfassung fehlgeschlagen · ${error.failedDevices.length} Gerät(e) betroffen · ${this.error}`);
      } else {
        logger.error(`Datenerfassung fehlgeschlagen · ${this.error}`);
      }
      this.failures++;
      delay = Math.min(3600, this.config.pollSeconds * 2 ** Math.min(this.failures, 5));
      if (error instanceof CollectionError && error.communicationOnly) delay = 300;
      if (error instanceof CollectionError) delay = Math.max(delay, error.retrySeconds);
    } finally {
      this.running = false;
      this.resolveFinished?.();
      if (!this.stopped) {
        this.nextPollAt = this.now() + delay * 1000;
        if (this.error) logger.info(`Nächster Messversuch um ${new Date(this.nextPollAt).toLocaleString('de-DE')} (in ${Math.ceil(delay / 60)} Min.).`);
        this.timer = setTimeout(() => { void this.poll(); }, delay * 1000);
        this.timer.unref();
      }
    }
  }

  async restart() {
    if (this.running) throw new HttpError('Messabfrage laeuft bereits. Bitte kurz warten.', 409);
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
      this.store.saveSnapshot(device, [
        { sensor: 'demo.flow', label: 'Vorlauf', kind: 'flow', value: 38 + 7 * Math.sin(hour / 3) + 2 * Math.sin(hour * 4) },
        { sensor: 'demo.water', label: 'Warmwasser', kind: 'water', value: water },
        { sensor: 'demo.outside', label: 'Aussentemperatur', kind: 'other', value: 7 + 4 * Math.sin(hour / 4) },
      ], { timestamp: time, pollSeconds: 300, schedules, error: null });
    }
    this.store.saveSchedules(device, { timestamp: this.now(), pollSeconds: this.config.pollSeconds, schedules, error: null });
  }
}
