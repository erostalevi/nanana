export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Lifecycle constants (SPEC section 3). */
export const COLD_AFTER = HOUR;
export const DEAD_AFTER = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < 5 * SEC) return 'just now';
  if (diff < MIN) return `${Math.floor(diff / SEC)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

/** Compact countdown: 6d 23h, 3h 12m, 4m 05s, 42s. Negative or zero gives "now". */
export function formatCountdown(ms: number): string {
  if (!(ms > 0)) return 'now';
  const s = Math.floor(ms / SEC);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export type Expiry = {
  /** ms until the next state flip (active -> cold), or null if already cold */
  sleepsInMs: number | null;
  /** ms until idle death (24h of inactivity) */
  idleDeathMs: number;
  /** ms until the 7 day ceiling */
  hardMs: number;
  /** whichever of idle death / hard ceiling hits first */
  goneInMs: number;
  limitedBy: 'idle' | 'hard';
};

export function expiryInfo(sub: { state: 'active' | 'cold'; lastActivityAt: string; hardExpiresAt: string }, now: number = Date.now()): Expiry {
  const last = new Date(sub.lastActivityAt).getTime();
  const sleeps = last + COLD_AFTER - now;
  const idleDeathMs = last + DEAD_AFTER - now;
  const hardMs = new Date(sub.hardExpiresAt).getTime() - now;
  return {
    sleepsInMs: sub.state === 'active' ? Math.max(0, sleeps) : null,
    idleDeathMs,
    hardMs,
    goneInMs: Math.min(idleDeathMs, hardMs),
    limitedBy: hardMs < idleDeathMs ? 'hard' : 'idle',
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
