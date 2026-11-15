import type { Config } from './config.ts';
import { parseTemperatures } from './model.ts';
import type { Store } from './store.ts';
import { ApiError, type Viessmann } from './viessmann.ts';

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
    let delay = this.config.pollSeconds;
    try {
      if (this.config.demo) {
        this.demo();
      } else {
        const device = this.store.getDevice();
        if (device && this.api.connected()) {
          const temperatures = parseTemperatures(await this.api.features(device));
          if (!temperatures.length) throw new Error('Keine freigegebenen Celsius-Sensoren gefunden. API-Paket und Geraet pruefen.');
          this.store.saveReadings(device, this.now(), temperatures);
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

  private demo() {
    const device = { installationId: 'demo', gatewaySerial: 'demo', deviceId: '0', name: 'Demo-Heizung' };
    this.store.setDevice(device);
    const last = this.store.sensors(device)[0]?.timestamp;
    const now = Math.floor(this.now() / 300_000) * 300_000;
    const start = typeof last === 'number' ? last + 300_000 : now - 7 * 86400_000;
    for (let time = start; time <= now; time += 300_000) {
      const hour = time / 3600_000;
      this.store.saveReadings(device, time, [
        { sensor: 'demo.flow', label: 'Vorlauf', kind: 'flow', value: 38 + 7 * Math.sin(hour / 3) + 2 * Math.sin(hour * 4) },
        { sensor: 'demo.water', label: 'Warmwasser', kind: 'water', value: 49 + 4 * Math.sin(hour / 2) },
        { sensor: 'demo.outside', label: 'Aussentemperatur', kind: 'other', value: 7 + 4 * Math.sin(hour / 4) },
      ]);
    }
  }
}
