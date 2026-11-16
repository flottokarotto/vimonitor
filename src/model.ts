import { createHash } from 'node:crypto';

export interface Device {
  installationId: string;
  gatewaySerial: string;
  deviceId: string;
  name: string;
}

export function deviceLabels(devices: Device[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const device of devices) counts.set(device.name, (counts.get(device.name) ?? 0) + 1);
  const used = new Set(devices.map(device => device.name));
  const labels = new Map<string, string>();
  const sorted = [...devices].sort((a, b) => deviceKey(a).localeCompare(deviceKey(b), 'en'));
  for (const device of sorted) {
    const key = deviceKey(device);
    if (counts.get(device.name) === 1) {
      labels.set(key, device.name);
      continue;
    }
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 8);
    const base = `${device.name} · Kennung ${fingerprint}`;
    let label = base;
    let suffix = 2;
    while (used.has(label)) label = `${base}-${suffix++}`;
    used.add(label);
    labels.set(key, label);
  }
  return labels;
}

export interface Temperature {
  sensor: string;
  label: string;
  kind: 'flow' | 'water' | 'other';
  value: number;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Unerwartetes API-Datenformat: Objekt erwartet.');
  }
  return value as Record<string, unknown>;
}

export function dataArray(value: unknown): unknown[] {
  const data = record(value).data;
  if (!Array.isArray(data)) throw new Error('Unerwartetes API-Datenformat: data-Liste fehlt.');
  return data;
}

export function temperatureLabel(name: string, property: string): string {
  const labels: Record<string, string> = {
    'heating.boiler.sensors.temperature.commonSupply': 'Gemeinsamer Heizungsvorlauf',
    'heating.boiler.sensors.temperature.main': 'Temperatur im Heizkessel',
    'heating.boiler.temperature': 'Temperaturwert des Heizkessels',
    'heating.calculated.temperature.outside': 'Berechnete Aussentemperatur (fuer die Regelung)',
    'heating.dhw.sensors.temperature.main': 'Warmwasser',
    'heating.dhw.sensors.temperature.hotWaterStorage': 'Warmwasser im Speicher',
    'heating.dhw.sensors.temperature.dhwCylinder': 'Warmwasserspeicher (weiterer Fuehler)',
    'heating.dhw.temperature.hygiene': 'Warmwasser-Hygieneprogramm (Solltemperatur)',
    'heating.dhw.temperature.main': 'Gewuenschte Warmwassertemperatur (Sollwert)',
    'heating.sensors.temperature.outside': 'Aussentemperatur',
    'heating.sensors.temperature.hydraulicSeparator': 'Heizwasser am Verteiler (hydraulische Weiche)',
    'heating.sensors.temperature.allengra': 'Heizwasser am Durchflusssensor (Allengra)',
    'heating.primaryCircuit.sensors.temperature.supply': 'Vorlauf',
  };
  let label = labels[name];
  if (!label) {
    const circuit = name.match(/^heating\.circuits\.(\d+)\.(.+)$/);
    if (circuit) {
      const circuitLabels: Record<string, string> = {
        'sensors.temperature.supply': 'Vorlauf',
        'temperature': 'Temperaturwert',
        'configuration.summerEco.absolute': 'Aussentemperatur-Grenze fuer Sommerbetrieb',
        'operating.programs.comfort': 'Gewuenschte Raumtemperatur - Komfortbetrieb (Sollwert)',
        'operating.programs.normal': 'Gewuenschte Raumtemperatur - Normalbetrieb (Sollwert)',
        'operating.programs.reduced': 'Gewuenschte Raumtemperatur - Absenkbetrieb (Sollwert)',
        'temperature.levels': property === 'min' ? 'Untere Temperaturgrenze'
          : property === 'max' ? 'Obere Temperaturgrenze' : 'Temperaturgrenze',
      };
      const description = circuitLabels[circuit[2] ?? ''];
      if (description) label = `${description} Heizkreis ${Number(circuit[1]) + 1}`;
    }
    const burner = name.match(/^heating\.burners\.(\d+)\.demand\.temperature$/);
    if (burner) label = `Angeforderte Temperatur am Brenner ${Number(burner[1]) + 1} (Sollwert)`;
  }
  if (!label) return `${name} (${property})`;
  if (!['value', 'temperature', 'threshold'].includes(property)
    && !(name.endsWith('.temperature.levels') && ['min', 'max'].includes(property))) {
    return `${label} (${property})`;
  }
  return label;
}

export function parseTemperatures(features: unknown[]): Temperature[] {
  const result: Temperature[] = [];
  for (const raw of features) {
    const feature = record(raw);
    if (feature.isEnabled === false || feature.isReady === false) continue;
    if (typeof feature.feature !== 'string' || !feature.properties) continue;
    for (const [property, rawValue] of Object.entries(record(feature.properties))) {
      const field = record(rawValue);
      if (field.unit !== 'celsius' || typeof field.value !== 'number' || !Number.isFinite(field.value)) continue;
      const name = feature.feature;
      const kind = /heating\.(primaryCircuit|circuits\.\d+)\.sensors\.temperature\.supply$/.test(name)
        ? 'flow' : /^heating\.dhw\.sensors\.temperature\.(main|hotWaterStorage)$/.test(name)
          ? 'water' : 'other';
      const label = temperatureLabel(name, property);
      result.push({ sensor: `${name}:${property}`, label, kind, value: field.value });
    }
  }
  return result;
}

export function deviceKey(device: Device): string {
  return JSON.stringify([device.installationId, device.gatewaySerial, device.deviceId]);
}
