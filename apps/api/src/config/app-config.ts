export interface AppConfig {
  port: number;
  baseDomain: string;
  databaseUrl: string;
  trustProxy: boolean;
  ipHashSecret: string;
  encryptionKey: Buffer;
  sessionSecret: string;
  publicApiUrl: string;
  /** scheme used when rendering public URLs (https in prod, http on localhost) */
  scheme: 'http' | 'https';
  /** extra port suffix for rendered URLs in dev, e.g. ":3001" */
  publicPortSuffix: string;
  webOrigin: string;
  mailDriver: 'console' | 'ses';
  mailFrom: string;
  awsRegion: string;
  authGithub: boolean;
  authGoogle: boolean;
  githubClientId: string;
  githubClientSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  adminEmails: string[];
  runJobs: boolean;
  replayAllowPrivate: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseDomain = (env.BASE_DOMAIN ?? 'localhost').toLowerCase();
  const isLocal = baseDomain === 'localhost';
  const port = Number(env.PORT ?? 3001);
  const scheme = (env.PUBLIC_SCHEME as 'http' | 'https' | undefined) ?? (isLocal ? 'http' : 'https');
  const publicPortSuffix = env.PUBLIC_PORT_SUFFIX ?? (isLocal ? `:${port}` : '');
  const key = env.ENCRYPTION_KEY
    ? Buffer.from(env.ENCRYPTION_KEY, 'base64')
    : Buffer.alloc(32, 'dev-only-encryption-key-0123456789');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return {
    port,
    baseDomain,
    databaseUrl: required(env, 'DATABASE_URL'),
    trustProxy: env.TRUST_PROXY === 'true',
    ipHashSecret: env.IP_HASH_SECRET ?? 'dev-only-ip-hash-secret',
    encryptionKey: key,
    sessionSecret: env.SESSION_SECRET ?? 'dev-only-session-secret',
    publicApiUrl: env.PUBLIC_API_URL ?? `${scheme}://api.${baseDomain}${publicPortSuffix}`,
    scheme,
    publicPortSuffix,
    webOrigin: env.WEB_ORIGIN ?? `${scheme}://${baseDomain}${isLocal ? ':5173' : ''}`,
    mailDriver: env.MAIL_DRIVER === 'ses' ? 'ses' : 'console',
    mailFrom: env.MAIL_FROM ?? 'noreply@nanana.lat',
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    authGithub: env.AUTH_GITHUB === 'true',
    authGoogle: env.AUTH_GOOGLE === 'true',
    githubClientId: env.GITHUB_CLIENT_ID ?? '',
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '',
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    adminEmails: (env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    runJobs: env.RUN_JOBS !== 'false',
    replayAllowPrivate: env.REPLAY_ALLOW_PRIVATE === 'true',
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function publicUrls(cfg: AppConfig, slug: string) {
  const s = cfg.scheme;
  const p = cfg.publicPortSuffix;
  const dashPort = cfg.baseDomain === 'localhost' ? ':5173' : '';
  return {
    url: `${s}://${slug}.${cfg.baseDomain}${p}`,
    dashboardUrl: `${s}://${slug}.tools.${cfg.baseDomain}${dashPort}`,
  };
}
