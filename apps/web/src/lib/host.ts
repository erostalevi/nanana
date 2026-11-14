export type HostMode = { mode: 'dashboard'; slug: string; base: string } | { mode: 'landing'; base: string };

const DASH_RE = /^([a-z0-9-]+)\.tools\.(.+)$/;

/** Detects landing vs dashboard mode from a hostname (SPEC section 2). */
export function detectMode(hostname: string): HostMode {
  const h = hostname.toLowerCase();
  const m = DASH_RE.exec(h);
  if (m && m[1] && m[2]) return { mode: 'dashboard', slug: m[1], base: m[2] };
  return { mode: 'landing', base: h.replace(/^www\./, '') };
}

export function isDevBase(base: string): boolean {
  return base === 'localhost' || base.endsWith('.localhost') || /^\d{1,3}(\.\d{1,3}){3}$/.test(base);
}

type Env = { VITE_API_URL?: string; VITE_API_PORT?: string };

/** API base URL: VITE_API_URL, else https://api.<base> (prod) or http://api.localhost:3001 (dev). */
export function apiBaseUrl(base: string, env: Env = import.meta.env as Env): string {
  if (env.VITE_API_URL) return env.VITE_API_URL.replace(/\/+$/, '');
  if (isDevBase(base)) return `http://api.localhost:${env.VITE_API_PORT || '3001'}`;
  return `https://api.${base}`;
}

/** Origin of the apex (landing) site for the given base, preserving the current protocol/port. */
export function apexOrigin(base: string, loc: Pick<Location, 'protocol' | 'port'> = window.location): string {
  return `${loc.protocol}//${base}${loc.port ? `:${loc.port}` : ''}`;
}

export function currentMode(): HostMode {
  return detectMode(window.location.hostname);
}
