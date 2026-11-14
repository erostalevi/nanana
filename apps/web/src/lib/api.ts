import { apiBaseUrl, currentMode } from './host';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let baseOverride: string | null = null;
/** Test hook. */
export function setApiBase(url: string | null): void {
  baseOverride = url;
}
export function getApiBase(): string {
  return baseOverride ?? apiBaseUrl(currentMode().base);
}

export type ReqOpts = { method?: string; body?: unknown; token?: string | null; signal?: AbortSignal };

/** Fetches JSON from the API with account-session cookies, optional subdomain/CLI bearer token. */
export async function api<T = unknown>(path: string, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(getApiBase() + path, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'include',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Could not reach the nanana API. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    const ra = Number(res.headers.get('Retry-After'));
    throw new ApiError(
      res.status,
      err?.code ?? (res.status === 404 ? 'not_found' : 'http_error'),
      err?.message ?? `Request failed (${res.status})`,
      Number.isFinite(ra) && ra > 0 ? ra : undefined,
    );
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404 && e.code === 'not_found') return e.message || 'Not found.';
    if (e.status === 429) return `Rate limited${e.retryAfter ? `, try again in ${e.retryAfter}s` : ''}.`;
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export function isUnauthed(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404);
}
