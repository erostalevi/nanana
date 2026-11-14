import fs from 'node:fs';
import { API_LOG } from './env';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads the most recent magic link sent to `email` from the API log (MAIL_DRIVER=console prints the
 * whole message, link included). Polls because the log is flushed asynchronously.
 */
export async function readMagicLink(email: string, timeoutMs = 10_000): Promise<string> {
  const re = new RegExp(`\\[mail:console\\] to=${escapeRe(email.toLowerCase())} [^\\n]*\\n[\\s\\S]*?(http\\S*/auth/verify\\?token=nnm_[A-Za-z0-9]+\\S*)`, 'g');
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const log = fs.existsSync(API_LOG) ? fs.readFileSync(API_LOG, 'utf8').replace(ANSI, '') : '';
    const all = [...log.matchAll(re)];
    const last = all[all.length - 1];
    if (last?.[1]) return last[1];
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No magic link for ${email} found in ${API_LOG}`);
}

export function tokenFromLink(link: string): string {
  const t = new URL(link).searchParams.get('token');
  if (!t) throw new Error(`No token in ${link}`);
  return t;
}
