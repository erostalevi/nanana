/**
 * Lowest possible UUIDv7 for a unix-millisecond timestamp. UUIDv7 ids start with the 48-bit
 * creation time, so `id >= uuidV7Floor(t)` selects rows created at or after `t` using the primary
 * key (or `(subdomain_id, id DESC)`), without needing an index on `received_at`.
 */
export function uuidV7Floor(unixMs: number): string {
  const ms = Math.max(0, Math.min(Math.floor(unixMs), 0xffffffffffff));
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}
