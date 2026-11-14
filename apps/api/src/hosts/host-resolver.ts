export const RESERVED_LABELS = new Set([
  'www', 'api', 'tools', 'app', 'admin', 'dashboard', 'static', 'assets', 'mail',
  'smtp', 'status', 'docs', 'blog', 'help', 'support', 'login', 'auth', 'cdn',
  'ns1', 'ns2', 'root', 'nanana',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

export function isValidSlug(label: string): boolean {
  return SLUG_RE.test(label) && !label.startsWith('xn--') && !RESERVED_LABELS.has(label);
}

export type HostTarget =
  | { kind: 'web' }
  | { kind: 'api' }
  | { kind: 'ingress'; slug: string }
  | { kind: 'dashboard'; slug: string }
  | { kind: 'unknown' };

export function resolveHost(hostHeader: string | undefined, baseDomain: string): HostTarget {
  if (!hostHeader) return { kind: 'unknown' };
  const host = hostHeader.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const base = baseDomain.toLowerCase();

  if (host === base || host === `www.${base}`) return { kind: 'web' };
  if (!host.endsWith(`.${base}`)) return { kind: 'unknown' };

  const labels = host.slice(0, -(base.length + 1)).split('.');
  if (labels.length === 1) {
    const [l] = labels;
    if (l === 'api') return { kind: 'api' };
    if (l === 'tools') return { kind: 'web' };
    return isValidSlug(l) ? { kind: 'ingress', slug: l } : { kind: 'unknown' };
  }
  if (labels.length === 2 && labels[1] === 'tools') {
    return isValidSlug(labels[0]) ? { kind: 'dashboard', slug: labels[0] } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}
