import { createHash, randomBytes } from 'node:crypto';
import { dataArray, record } from './model.ts';
import type { Device } from './model.ts';
import type { Store } from './store.ts';
import type { Config } from './config.ts';

const IDP = 'https://iam.viessmann-climatesolutions.com/idp/v3';
const API = 'https://api.viessmann-climatesolutions.com/iot/v2';

export class ApiError extends Error {
  status: number;
  retrySeconds: number;
  constructor(message: string, status: number, retrySeconds = 0) {
    super(message);
    this.status = status;
    this.retrySeconds = retrySeconds;
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class Viessmann {
  private config: Config;
  private store: Store;
  private request: typeof fetch;
  private refresh: Promise<Tokens> | undefined;

  constructor(config: Config, store: Store, request: typeof fetch = fetch) {
    this.config = config;
    this.store = store;
    this.request = request;
  }

  connected() { return this.store.getSetting('tokens') !== undefined; }

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
      throw new ApiError(`Viessmann-Anmeldung fehlgeschlagen (HTTP ${response.status}). Bitte erneut verbinden.`, response.status);
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

  async get(path: string): Promise<unknown[]> {
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
      const rawRetry = response.headers.get('retry-after');
      const retrySeconds = rawRetry
        ? (/^\d+$/.test(rawRetry) ? Number(rawRetry) : Math.ceil((Date.parse(rawRetry) - Date.now()) / 1000))
        : 0;
      throw new ApiError(
        `Viessmann-API: HTTP ${response.status}${response.status === 429 ? ' (Abfragelimit erreicht)' : ''}.`,
        response.status, Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds) : 0,
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
          result.push({
            installationId: String(installation.id), gatewaySerial: gateway.serial,
            deviceId: String(device.id),
            name: typeof device.modelId === 'string' ? device.modelId : `Geraet ${String(device.id)}`,
          });
        }
      }
    }
    return result;
  }

  features(device: Device) {
    return this.get(`/features/installations/${encodeURIComponent(device.installationId)}/gateways/${encodeURIComponent(device.gatewaySerial)}/devices/${encodeURIComponent(device.deviceId)}/features`);
  }
}
