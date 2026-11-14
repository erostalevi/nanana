import type { IncomingMessage } from 'node:http';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

export type HeaderMap = Record<string, string | string[]>;

/** Headers as received (lowercased names), duplicates preserved as arrays. */
export function rawHeaders(req: IncomingMessage): HeaderMap {
  const out: HeaderMap = {};
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    const v = raw[i + 1];
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

export function stripHopByHop(h: HeaderMap): HeaderMap {
  const conn = String(h['connection'] ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(h)) {
    if (HOP_BY_HOP.has(k) || conn.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Strict utf-8 check tolerant of a multibyte sequence cut at the end (for prefixes). */
export function isUtf8(buf: Buffer, allowCut = false): boolean {
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (let cut = 0; cut <= (allowCut ? 3 : 0); cut++) {
    try {
      dec.decode(buf.subarray(0, buf.length - cut));
      return true;
    } catch {
      /* try shorter */
    }
  }
  return false;
}

export function bodyDto(buf: Buffer | null, truncated = false): { encoding: 'utf8' | 'base64'; data: string; truncated?: boolean } | null {
  if (!buf) return null;
  const base = isUtf8(buf)
    ? { encoding: 'utf8' as const, data: buf.toString('utf8') }
    : { encoding: 'base64' as const, data: buf.toString('base64') };
  return truncated ? { ...base, truncated: true } : base;
}

export function preview(head: Buffer | null): string {
  if (!head || head.length === 0) return '';
  if (!isUtf8(head, true)) return '';
  return head.toString('utf8').slice(0, 200);
}

export class PayloadTooLarge extends Error {}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new PayloadTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners('data');
        reject(new PayloadTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}
