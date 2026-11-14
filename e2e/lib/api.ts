import { request, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { API_PORT, API_URL, WEB_URL, dashboardUrl } from './env';
import { readMagicLink, tokenFromLink } from './mail';

export type Endpoint = {
  slug: string;
  token: string;
  url: string;
  dashboardUrl: string;
  /** dashboard URL with #t=<token> on the *.tools.localhost origin */
  link: string;
};

let ipCounter = 1;
/** A unique fake client IP; the API runs with TRUST_PROXY=true so X-Forwarded-For decides the per-IP limits. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.${Math.floor(Math.random() * 200) + 1}`;
}

export function uniqueEmail(tag = 'user'): string {
  return `${tag}-${randomBytes(4).toString('hex')}@example.test`;
}

/** Raw API call helper (no cookies unless the given context carries them). */
export async function apiCall<T = any>(ctx: APIRequestContext, method: string, path: string, opts: { token?: string; data?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const res = await ctx.fetch(`${API_URL}${path}`, {
    method,
    headers: { 'x-forwarded-for': freshIp(), origin: WEB_URL, ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    data: opts.data as never,
  });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status(), body: body as T };
}

/** Creates an anonymous endpoint through the API. */
export async function createEndpoint(ctx: APIRequestContext, opts: { name?: string; data?: Record<string, unknown> } = {}): Promise<Endpoint> {
  const r = await apiCall<{ subdomain: { slug: string; url: string; dashboardUrl: string }; token: string }>(ctx, 'POST', '/subdomains', { data: opts.name ? { name: opts.name } : {} });
  if (r.status !== 201) throw new Error(`create endpoint failed: ${r.status} ${JSON.stringify(r.body)}`);
  const { subdomain, token } = r.body;
  if (opts.data) {
    const p = await apiCall(ctx, 'PATCH', `/subdomains/${subdomain.slug}`, { token, data: opts.data });
    if (p.status !== 200) throw new Error(`patch failed: ${p.status} ${JSON.stringify(p.body)}`);
  }
  return { slug: subdomain.slug, token, url: subdomain.url, dashboardUrl: subdomain.dashboardUrl, link: dashboardUrl(subdomain.slug, token) };
}

export type Hook = { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer | object };

/**
 * Sends a webhook to the ingress of `slug`. Connects to 127.0.0.1 and sets the Host header so it does
 * not depend on the OS resolving *.localhost.
 */
export async function sendHook(slug: string, hook: Hook = {}): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const ctx = await request.newContext();
  try {
    const isObj = hook.body !== undefined && typeof hook.body === 'object' && !Buffer.isBuffer(hook.body);
    const res = await ctx.fetch(`http://127.0.0.1:${API_PORT}${hook.path ?? '/'}`, {
      method: hook.method ?? 'POST',
      headers: { host: `${slug}.localhost:${API_PORT}`, ...(isObj ? { 'content-type': 'application/json' } : {}), ...hook.headers },
      data: isObj ? JSON.stringify(hook.body) : (hook.body as string | Buffer | undefined),
      maxRedirects: 0,
    });
    return { status: res.status(), text: await res.text(), headers: res.headers() };
  } finally {
    await ctx.dispose();
  }
}

/** Signs in through the real magic-link flow (API only) and leaves the session cookie in `context`. */
export async function signIn(context: BrowserContext, email = uniqueEmail()): Promise<{ email: string }> {
  const ctx = context.request;
  const m = await apiCall(ctx, 'POST', '/auth/magic', { data: { email } });
  if (m.status !== 202) throw new Error(`magic link request failed: ${m.status} ${JSON.stringify(m.body)}`);
  const link = await readMagicLink(email);
  const v = await apiCall(ctx, 'POST', '/auth/magic/verify', { data: { token: tokenFromLink(link) } });
  if (v.status !== 200) throw new Error(`magic verify failed: ${v.status} ${JSON.stringify(v.body)}`);
  return { email };
}
