import type { AppConfig } from '../config/app-config.js';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const cache = new WeakMap<AppConfig, RegExp>();

/** Origins allowed to call the API with credentials: apex, www and <slug>.tools. */
export function isAllowedOrigin(cfg: AppConfig, origin: string | undefined): boolean {
  if (!origin) return false;
  let re = cache.get(cfg);
  if (!re) {
    re = new RegExp(`^https?://((www|[a-z0-9-]+\\.tools)\\.)?${escapeRe(cfg.baseDomain)}(:\\d+)?$`);
    cache.set(cfg, re);
  }
  return re.test(origin);
}
