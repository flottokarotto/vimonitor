export interface Device {
  installationId: string;
  gatewaySerial: string;
  deviceId: string;
  name: string;
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
      const circuit = name.match(/circuits\.(\d+)/)?.[1];
      const label = kind === 'flow' ? `Vorlauf${circuit ? ` Heizkreis ${Number(circuit) + 1}` : ''}`
        : kind === 'water' ? 'Warmwasser' : `${name} (${property})`;
      result.push({ sensor: `${name}:${property}`, label, kind, value: field.value });
    }
  }
  return result;
}

export function deviceKey(device: Device): string {
  return JSON.stringify([device.installationId, device.gatewaySerial, device.deviceId]);
}
