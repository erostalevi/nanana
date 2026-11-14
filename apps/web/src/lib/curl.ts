import type { Body, Headers } from './types';

const SKIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Shell-quotes a string: plain single quotes when safe, bash/zsh ANSI-C $'...' otherwise. */
export function shellQuote(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[\u0000-\u001f\u007f]/.test(s)) return `'${s.replace(/'/g, `'\\''`)}'`;
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `$'${out}'`;
}

export type CurlInput = { method: string; url: string; headers: Headers; body: Body | null };

export function curlHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue;
    for (const val of Array.isArray(v) ? v : [v]) out.push([k, val]);
  }
  return out;
}

/** Builds a copy-pasteable curl command reproducing a captured request. */
export function buildCurl({ method, url, headers, body }: CurlInput): string {
  const m = method.toUpperCase();
  const hasBody = !!body && body.data.length > 0;
  const binary = !!body && hasBody && (body.encoding === 'base64' || body.data.includes('\u0000'));
  let first = 'curl';
  if (m === 'HEAD') first += ' -I';
  else if (m !== 'GET' || hasBody) first += ` -X ${m}`;
  first += ` ${shellQuote(url)}`;
  const segs: string[] = [first];
  for (const [k, v] of curlHeaders(headers)) segs.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  let prefix = '';
  if (hasBody && body) {
    if (binary) {
      const b64 = body.encoding === 'base64' ? body.data : utf8ToBase64(body.data);
      prefix = `printf '%s' '${b64}' | base64 -d | `;
      segs.push('--data-binary @-');
    } else {
      segs.push(`--data-binary ${shellQuote(body.data)}`);
    }
  }
  const text = segs.map((l, i) => (i === 0 ? l : `  ${l}`)).join(' \\\n');
  const note = body?.truncated ? '# note: the stored body was truncated; this reproduces only the stored part\n' : '';
  return note + prefix + text;
}

export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
