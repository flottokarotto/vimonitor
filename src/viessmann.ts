import { createHash, randomBytes } from 'node:crypto';
import { dataArray, parseTemperatures, record } from './model.ts';
import type { Device } from './model.ts';
import type { Config } from './config.ts';
import { HeatingError } from './heating.ts';
import type { HeatingService, HeatingSnapshot } from './heating.ts';
import { parseSchedules } from './schedules.ts';

const IDP = 'https://iam.viessmann-climatesolutions.com/idp/v3';
const API = 'https://api.viessmann-climatesolutions.com/iot/v2';

function retryAfter(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return 0;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

async function errorDetail(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return '';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return '';
  const fields = body as Record<string, unknown>;
  const details: string[] = [];
  for (const key of ['error', 'error_description', 'message', 'description', 'detail', 'errorType', 'errorCode']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) details.push(value.trim());
    else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of ['code', 'message', 'description']) {
        const nestedValue = nested[nestedKey];
        if (typeof nestedValue === 'string' && nestedValue.trim()) details.push(nestedValue.trim());
      }
    }
  }
  return [...new Set(details)].join(': ').slice(0, 300);
}

export class ApiError extends HeatingError {}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface TokenStore {
  hasSecret(): boolean;
  loadSecret(): unknown;
  saveSecret(value: Tokens): void;
  clearSecret(): void;
}

export class Viessmann implements HeatingService {
  private config: Pick<Config, 'clientId' | 'redirectUri'>;
  private store: TokenStore;
  private request: typeof fetch;
  private refresh: Promise<Tokens> | undefined;

  constructor(config: Pick<Config, 'clientId' | 'redirectUri'>, store: TokenStore, request: typeof fetch = fetch) {
    this.config = config;
    this.store = store;
    this.request = request;
  }

  connected() { return this.store.hasSecret(); }

  authorization() {
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const url = new URL(`${IDP}/authorize`);
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri,
      response_type: 'code', scope: 'IoT User offline_access', state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return { url: url.toString(), state, verifier };
  }

  async exchange(code: string, verifier: string) {
    const tokens = await this.token({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: this.config.redirectUri,
    });
    this.store.saveSecret(tokens);
  }

  private async token(fields: Record<string, string>, previousRefresh = ''): Promise<Tokens> {
    const response = await this.request(`${IDP}/token`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: this.config.clientId }),
    });
    if (!response.ok) {
      if (fields.grant_type === 'refresh_token' && [400, 401].includes(response.status)) this.store.clearSecret();
      const detail = await errorDetail(response);
      throw new ApiError(
        `Viessmann-Anmeldung fehlgeschlagen (HTTP ${response.status})${detail ? `: ${detail}` : ''}. Bitte erneut verbinden.`,
        response.status, retryAfter(response),
      );
    }
    const data = record(await response.json());
    if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
      throw new Error('Ungueltige Token-Antwort von Viessmann.');
    }
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : previousRefresh;
    if (!refreshToken) throw new Error('Kein Refresh-Token erhalten. offline_access im API-Client pruefen.');
    return { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
  }

  private async accessToken(force = false): Promise<Tokens> {
    if (this.refresh) return this.refresh;
    const raw = this.store.loadSecret();
    if (!raw) throw new ApiError('Noch nicht verbunden. Bitte mit Viessmann anmelden.', 401);
    const saved = record(raw);
    if (typeof saved.accessToken !== 'string' || typeof saved.refreshToken !== 'string' || typeof saved.expiresAt !== 'number') {
      throw new Error('Ungueltige lokal gespeicherte Tokens. Bitte erneut anmelden.');
    }
    const tokens: Tokens = { accessToken: saved.accessToken, refreshToken: saved.refreshToken, expiresAt: saved.expiresAt };
    if (!force && tokens.expiresAt > Date.now() + 60_000) return tokens;
    this.refresh = this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens.refreshToken)
      .then(value => { this.store.saveSecret(value); return value; })
      .finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  private async get(path: string): Promise<unknown[]> {
    let tokens = await this.accessToken();
    const send = () => this.request(`${API}${path}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(20_000),
    });
    let response = await send();
    if (response.status === 401) {
      tokens = await this.accessToken(true);
      response = await send();
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new ApiError(
        `Viessmann-API: HTTP ${response.status}${response.status === 429 ? ' (Abfragelimit erreicht)' : ''}${detail ? `: ${detail}` : ''}.`,
        response.status, retryAfter(response),
      );
    }
    return dataArray(await response.json());
  }

  async devices(): Promise<Device[]> {
    const result: Device[] = [];
    for (const raw of await this.get('/equipment/installations?includeGateways=true')) {
      const installation = record(raw);
      if (!Array.isArray(installation.gateways) || installation.id === undefined) {
        throw new Error('Anlagenantwort enthaelt keine Gateways oder Anlagen-ID.');
      }
      for (const rawGateway of installation.gateways) {
        const gateway = record(rawGateway);
        if (typeof gateway.serial !== 'string') throw new Error('Gateway-Seriennummer fehlt.');
        const path = `/equipment/installations/${encodeURIComponent(String(installation.id))}/gateways/${encodeURIComponent(gateway.serial)}/devices`;
        for (const rawDevice of await this.get(path)) {
          const device = record(rawDevice);
          if (device.id === undefined) throw new Error('Geraete-ID fehlt.');
          if (typeof device.modelId === 'string' && /^E3_(?:TCU|RoomControl)(?:_|\d)/i.test(device.modelId)) continue;
          const installationName = typeof installation.description === 'string'
            ? installation.description : `Anlage ${String(installation.id)}`;
          const model = typeof device.modelId === 'string' ? device.modelId : `Geraet ${String(device.id)}`;
          result.push({
            installationId: String(installation.id), gatewaySerial: gateway.serial,
            deviceId: String(device.id),
            name: `${model} · ${installationName} · Gateway …${gateway.serial.slice(-4)}`,
          });
        }
      }
    }
    return result;
  }

  async read(device: Device): Promise<HeatingSnapshot> {
    const features = await this.get(`/features/installations/${encodeURIComponent(device.installationId)}/gateways/${encodeURIComponent(device.gatewaySerial)}/devices/${encodeURIComponent(device.deviceId)}/features`);
    const temperatures = parseTemperatures(features);
    if (!temperatures.length) throw new Error('Keine freigegebenen Celsius-Sensoren gefunden. API-Paket und Geraet pruefen.');
    try {
      return { temperatures, schedules: parseSchedules(features), scheduleError: null };
    } catch (error) {
      const scheduleError = error instanceof Error ? error.message : 'Zeitprogramme konnten nicht gelesen werden.';
      return { temperatures, schedules: [], scheduleError };
    }
  }
}
