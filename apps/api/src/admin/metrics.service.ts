import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Injectable } from '@nestjs/common';

export type Outcome = 'captured' | 'rejected';

const MINUTES = 60;

interface Bucket {
  minute: number; // epoch minute
  captured: number;
  rejected: number;
  shed: number;
  tunneled: number;
  latencySumMs: number;
  latencyMaxMs: number;
}

/**
 * In-memory, per-minute counters for the admin dashboard. They reset when the API restarts (the dashboard says so);
 * the captured_request table cannot answer "how many requests per minute" because retention keeps deleting rows.
 */
@Injectable()
export class MetricsService {
  readonly startedAt = Date.now();
  private readonly buckets = new Map<number, Bucket>();
  private readonly loop: ReturnType<typeof monitorEventLoopDelay> = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.loop.enable();
  }

  private bucket(now = Date.now()): Bucket {
    const minute = Math.floor(now / 60_000);
    let b = this.buckets.get(minute);
    if (!b) {
      b = { minute, captured: 0, rejected: 0, shed: 0, tunneled: 0, latencySumMs: 0, latencyMaxMs: 0 };
      this.buckets.set(minute, b);
      for (const k of this.buckets.keys()) if (k <= minute - MINUTES) this.buckets.delete(k);
    }
    return b;
  }

  /** A request reached an endpoint and was refused (unknown, expired, read-only, rate limited, too large). */
  rejected(): void {
    this.bucket().rejected++;
  }

  /** A webhook was refused by load shedding (503). Counted separately from `rejected` (404, 429, 413, read-only). */
  shed(): void {
    this.bucket().shed++;
  }

  /** A request was captured and answered; `viaTunnel` when it was forwarded to a CLI. */
  answered(latencyMs: number, viaTunnel: boolean): void {
    const b = this.bucket();
    b.captured++;
    if (viaTunnel) b.tunneled++;
    b.latencySumMs += latencyMs;
    b.latencyMaxMs = Math.max(b.latencyMaxMs, latencyMs);
  }

  /** Last 60 minutes, oldest first, zero-filled. */
  series(now = Date.now()) {
    const current = Math.floor(now / 60_000);
    const out: { minute: number; captured: number; rejected: number; shed: number; tunneled: number; avgLatencyMs: number; maxLatencyMs: number }[] = [];
    for (let m = current - MINUTES + 1; m <= current; m++) {
      const b = this.buckets.get(m);
      out.push({
        minute: m * 60_000,
        captured: b?.captured ?? 0,
        rejected: b?.rejected ?? 0,
        shed: b?.shed ?? 0,
        tunneled: b?.tunneled ?? 0,
        avgLatencyMs: b && b.captured ? Math.round(b.latencySumMs / b.captured) : 0,
        maxLatencyMs: b?.latencyMaxMs ?? 0,
      });
    }
    return out;
  }

  eventLoop() {
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e4) / 100 : 0);
    return { p50Ms: ms(this.loop.percentile(50)), p99Ms: ms(this.loop.percentile(99)), maxMs: ms(this.loop.max) };
  }

  /** p99 event-loop delay (ms) since the last call, then resets the histogram. Used by LoadService every 250 ms. */
  takeEventLoopP99Ms(): number {
    const ns = this.loop.percentile(99);
    this.loop.reset();
    return Number.isFinite(ns) ? ns / 1e6 : 0;
  }

  resetEventLoop(): void {
    this.loop.reset();
  }
}
