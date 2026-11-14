/** In-memory token bucket. Single-process only (single VM by design). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  /** Returns 0 if allowed, else seconds until a token is available. */
  take(key: string, perMinute: number, now = Date.now()): number {
    const rate = perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: perMinute, last: now };
    b.tokens = Math.min(perMinute, b.tokens + (now - b.last) * rate);
    b.last = now;
    let wait = 0;
    if (b.tokens >= 1) b.tokens -= 1;
    else wait = Math.ceil((1 - b.tokens) / rate / 1000);
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.gc(now);
    return wait;
  }

  private gc(now: number): void {
    for (const [k, v] of this.buckets) if (now - v.last > 10 * 60_000) this.buckets.delete(k);
  }
}
