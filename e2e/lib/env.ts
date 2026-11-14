import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const E2E_DIR = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(E2E_DIR, '..');
export const RUN_DIR = path.join(E2E_DIR, '.run');
export const API_LOG = path.join(RUN_DIR, 'api.log');
export const VITE_LOG = path.join(RUN_DIR, 'vite.log');
export const PID_FILE = path.join(RUN_DIR, 'pids.json');
export const A11Y_DIR = path.join(E2E_DIR, 'a11y-report');

export const API_PORT = 3201;
export const WEB_PORT = 5173;

/** The API answers on bare localhost, so cookies work from the apex origin (same site). */
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://localhost:5432/nanana_test';

export const apiEnv = {
  PORT: String(API_PORT),
  BASE_DOMAIN: 'localhost',
  DATABASE_URL,
  MAIL_DRIVER: 'console',
  RUN_JOBS: 'false',
  REPLAY_ALLOW_PRIVATE: 'true',
  // Lets tests give every signed-in helper call its own client IP (the per-IP magic-link limit is 5/min).
  TRUST_PROXY: 'true',
  NO_COLOR: '1',
  WEB_ORIGIN: WEB_URL,
};

export const dashboardUrl = (slug: string, token?: string) => `http://${slug}.tools.localhost:${WEB_PORT}/${token ? `#t=${token}` : ''}`;
