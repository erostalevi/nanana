import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HeaderMap } from './http.js';

export type Signature = 'pass' | 'fail' | 'header_missing' | 'not_configured';
export interface SignatureResult {
  state: Signature;
  header: string | null;
  received: string | null;
  expected: string | null;
}

const ALGOS = new Set(['sha256', 'sha1', 'sha512']);
export const isHmacAlgo = (a: string): boolean => ALGOS.has(a);

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function computeSignature(
  cfg: { secret: string | null; header: string | null; algo: string },
  headers: HeaderMap,
  body: Buffer,
): SignatureResult {
  if (!cfg.secret || !cfg.header) return { state: 'not_configured', header: cfg.header, received: null, expected: null };
  const h = cfg.header.toLowerCase();
  const raw = headers[h];
  const received = Array.isArray(raw) ? raw[0] : (raw ?? null);
  if (!received) return { state: 'header_missing', header: h, received: null, expected: null };

  const mac = (data: Buffer | string) => createHmac(cfg.algo, cfg.secret!).update(data);
  const hex = mac(body).digest('hex');
  const b64 = mac(body).digest('base64');

  // Stripe style: t=timestamp,v1=sig[,v1=sig2]
  if (/(^|,)\s*t=\d+/.test(received) && /v1=/.test(received)) {
    const parts = received.split(',').map((p) => p.trim().split('='));
    const t = parts.find(([k]) => k === 't')?.[1] ?? '';
    const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    const expected = mac(Buffer.concat([Buffer.from(`${t}.`), body])).digest('hex');
    return { state: sigs.some((s) => eq(s, expected)) ? 'pass' : 'fail', header: h, received, expected };
  }
  const val = received.trim();
  const candidates = [hex, `${cfg.algo}=${hex}`, b64, `${cfg.algo}=${b64}`];
  const ok = candidates.some((c) => eq(val, c)) || eq(val.toLowerCase(), hex);
  return { state: ok ? 'pass' : 'fail', header: h, received, expected: hex };
}
