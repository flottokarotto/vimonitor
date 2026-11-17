import { spawn } from 'node:child_process';
import { createElement } from 'react';
import { render } from 'ink';
import type { createRuntime } from './runtime.ts';
import { deviceKey, deviceLabels } from './model.ts';
import type { Device } from './model.ts';
import { buildInsights } from './insights.ts';
import { logger } from './logger.ts';
import { TerminalDashboard } from './tui-view.ts';
import type { TerminalSnapshot, TerminalSensor } from './tui-model.ts';
import { seriesKey } from './tui-model.ts';

export type Runtime = ReturnType<typeof createRuntime>;

export function readTerminalSnapshot(runtime: Runtime, hours: number, now = Date.now()): TerminalSnapshot {
  const { store, config, api, collector } = runtime;
  const selected = store.getDevices();
  const labels = deviceLabels(selected);
  const active = store.getDevice();
  const from = now - hours * 3600_000;
  const histories = new Map<string, { timestamp: number; value: number }[]>();
  const devices = selected.map(device => {
    const id = deviceKey(device);
    const sensors: TerminalSensor[] = store.sensors(device).map(row => ({
      sensor: String(row.sensor), label: String(row.label),
      kind: row.kind === 'flow' || row.kind === 'water' ? row.kind : 'other',
      value: Number(row.value), timestamp: Number(row.timestamp),
    }));
    for (const sensor of sensors) {
      histories.set(seriesKey(id, sensor.sensor), store.history(device, sensor.sensor, from, now)
        .map(row => ({ timestamp: Number(row.timestamp), value: Number(row.value) })));
    }
    return { id, name: labels.get(id) ?? device.name, sensors };
  });
  return {
    demo: config.demo, connected: config.demo || api.connected(), devices,
    activeDevice: active ? deviceKey(active) : null,
    collecting: collector.running, nextPollAt: collector.nextPollAt, error: collector.error,
    pollSeconds: config.pollSeconds, from, to: now, histories,
    insights: buildInsights(store, active, now),
  };
}

export interface TerminalActions {
  read(hours: number): TerminalSnapshot;
  discover(): Promise<{ key: string; label: string; selected: boolean }[]>;
  selectDevices(keys: string[]): Promise<void>;
  activate(id: string): void;
  login(): void;
}

export function terminalActions(runtime: Runtime): TerminalActions {
  let discovered = new Map<string, Device>();
  return {
    read: hours => readTerminalSnapshot(runtime, hours),
    async discover() {
      if (runtime.config.demo) throw new Error('Die Geräteauswahl steht nur im Echtbetrieb zur Verfügung.');
      const devices = await runtime.api.devices();
      discovered = new Map(devices.map(device => [deviceKey(device), device]));
      const selected = new Set(runtime.store.getDevices().map(deviceKey));
      const labels = deviceLabels(devices);
      return devices.map(device => ({
        key: deviceKey(device), label: labels.get(deviceKey(device)) ?? device.name,
        selected: selected.has(deviceKey(device)),
      }));
    },
    async selectDevices(keys) {
      if (!keys.length) throw new Error('Bitte mindestens ein Heizgerät auswählen.');
      if (runtime.collector.running) throw new Error('Messabfrage läuft. Bitte kurz warten.');
      const devices = keys.map(key => {
        const device = discovered.get(key);
        if (!device) throw new Error('Ungültige Geräteauswahl. Bitte Geräteliste neu laden.');
        return device;
      });
      runtime.store.setDevices(devices);
      await runtime.collector.restart();
      if (runtime.collector.error) throw new Error(`Auswahl gespeichert, aber Messung fehlgeschlagen: ${runtime.collector.error}`);
    },
    activate(id) {
      const device = runtime.store.getDevices().find(item => deviceKey(item) === id);
      if (!device) throw new Error('Gerät ist nicht mehr ausgewählt.');
      runtime.store.setDevice(device);
    },
    login() {
      if (runtime.config.demo) throw new Error('Die ViCare-Anmeldung steht im Demo-Modus nicht zur Verfügung.');
      const target = `http://localhost:${runtime.config.port}/auth/login`;
      const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
      const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
      browser.once('error', error => logger.warn(`Browser konnte nicht geöffnet werden: ${error.message} · ${target}`));
      browser.unref();
      logger.info(`Öffne ViCare-Anmeldung · ${target}`);
    },
  };
}

export async function startTerminal(runtime: Runtime, onQuit: () => void): Promise<{ close(): void }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Die Terminaloberfläche benötigt ein interaktives Terminal.');
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    instance.unmount();
    instance.cleanup();
  };
  const instance = render(createElement(TerminalDashboard, {
    actions: terminalActions(runtime), onClose: close, onQuit,
  }), { exitOnCtrlC: false, alternateScreen: true, interactive: true, patchConsole: false });
  void instance.waitUntilExit().catch(error => {
    close();
    logger.error(`Terminaloberfläche fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    onQuit();
  });
  try { await instance.waitUntilRenderFlush(); }
  catch (error) { close(); throw error; }
  return { close };
}
