import { base64ToBytes } from './curl';
import type { Body } from './types';

export type BodyView =
  | { kind: 'empty' }
  | { kind: 'json'; value: unknown; pretty: string; raw: string; truncated: boolean }
  | { kind: 'form'; pairs: [string, string][]; raw: string; truncated: boolean }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'binary'; bytes: Uint8Array; base64: string; truncated: boolean };

function header(contentType: string | null | undefined): string {
  return (contentType ?? '').toLowerCase();
}

/** Turns a stored body into a typed view model. Everything stays plain data; the UI renders it as text. */
export function renderBody(body: Body | null | undefined, contentType?: string | null): BodyView {
  if (!body || body.data === '') return { kind: 'empty' };
  const truncated = !!body.truncated;
  if (body.encoding === 'base64') {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(body.data);
    } catch {
      return { kind: 'text', text: body.data, truncated };
    }
    return { kind: 'binary', bytes, base64: body.data, truncated };
  }
  const text = body.data;
  const ct = header(contentType);
  const trimmed = text.trim();
  if (ct.includes('json') || ((trimmed.startsWith('{') || trimmed.startsWith('[')) && !ct.includes('form'))) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'object' && value !== null) {
        return { kind: 'json', value, pretty: JSON.stringify(value, null, 2), raw: text, truncated };
      }
    } catch {
      /* fall through to text */
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const pairs: [string, string][] = [];
    for (const [k, v] of new URLSearchParams(text)) pairs.push([k, v]);
    return { kind: 'form', pairs, raw: text, truncated };
  }
  return { kind: 'text', text, truncated };
}

export function toHex(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, i + 16);
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`);
  }
  return lines.join('\n');
}

/** Splits a request path into pathname and decoded query pairs. */
export function parseQuery(path: string): { pathname: string; pairs: [string, string][] } {
  const i = path.indexOf('?');
  if (i === -1) return { pathname: path, pairs: [] };
  const pairs: [string, string][] = [];
  for (const [k, v] of new URLSearchParams(path.slice(i + 1))) pairs.push([k, v]);
  return { pathname: path.slice(0, i), pairs };
}

/** Plain text of a body for copying (utf8 data or base64 of binary). */
export function bodyAsText(body: Body | null | undefined): string {
  return body?.data ?? '';
}
