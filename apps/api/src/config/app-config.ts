export interface AppConfig {
  port: number;
  baseDomain: string;
  databaseUrl: string;
  trustProxy: boolean;
  ipHashSecret: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3001),
    baseDomain: (env.BASE_DOMAIN ?? 'localhost').toLowerCase(),
    databaseUrl: required(env, 'DATABASE_URL'),
    trustProxy: env.TRUST_PROXY === 'true',
    ipHashSecret: env.IP_HASH_SECRET ?? 'dev-only-ip-hash-secret',
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
