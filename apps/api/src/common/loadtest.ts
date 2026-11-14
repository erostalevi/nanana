import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../config/app-config.js';

/** True when the request carries the operator load-test token (header `x-loadtest-token`). */
export function isLoadtest(cfg: AppConfig, req: IncomingMessage): boolean {
  if (!cfg.loadtestToken || cfg.loadtestToken.length < 24) return false;
  const h = req.headers['x-loadtest-token'];
  if (typeof h !== 'string') return false;
  const a = Buffer.from(h);
  const b = Buffer.from(cfg.loadtestToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
