import { resolve } from 'node:path';

export interface Config {
  port: number;
  demo: boolean;
  dataDir: string;
  pollSeconds: number;
  clientId: string;
  redirectUri: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
    }
    return value;
  };
  if (env.DEMO_MODE !== undefined && !['true', 'false'].includes(env.DEMO_MODE)) {
    throw new Error('DEMO_MODE muss true oder false sein.');
  }
  const port = integer('PORT', 3000, 1024, 65535);
  const demo = env.DEMO_MODE !== 'false';
  const clientId = env.VIESSMANN_CLIENT_ID?.trim() ?? '';
  if (!demo && !clientId) throw new Error('VIESSMANN_CLIENT_ID fehlt. Bitte .env konfigurieren.');
  const redirectUri = env.VIESSMANN_REDIRECT_URI ?? `http://localhost:${port}/auth/callback`;
  if (redirectUri !== `http://localhost:${port}/auth/callback`) {
    throw new Error(`VIESSMANN_REDIRECT_URI muss http://localhost:${port}/auth/callback sein.`);
  }
  return {
    port, demo, clientId, redirectUri,
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    pollSeconds: integer('POLL_INTERVAL_SECONDS', 300, 300, 86400),
  };
}
