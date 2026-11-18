import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../admin/metrics.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { isProLike } from '../config/plan-limits.js';

export interface ShedDecision {
  shed: boolean;
  /** Seconds for the Retry-After header (only meaningful when shed). */
  retryAfterSec: number;
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

/** Score is 0 below LOW and 1 at HIGH, linear in between (ms). Env overrides: SHED_LAG_LOW_MS etc. */
export const LAG_LOW_MS = num(process.env.SHED_LAG_LOW_MS, 100);
export const LAG_HIGH_MS = num(process.env.SHED_LAG_HIGH_MS, 400);
export const DB_LOW_MS = num(process.env.SHED_DB_LOW_MS, 100);
export const DB_HIGH_MS = num(process.env.SHED_DB_HIGH_MS, 500);

export const SAMPLE_INTERVAL_MS = 250;
/** EWMA weight of a new capture INSERT duration. */
export const DB_ALPHA = 0.2;
/** Per-sample multiplier of the DB EWMA when no insert was observed in the window. */
export const DB_IDLE_DECAY = 0.9;
/** Per-sample multiplier of the lag signal when the new sample is lower (about 50% fall per sample). */
export const LAG_DECAY = 0.5;
export const PRO_SHED_THRESHOLD = 0.5;
const LOG_INTERVAL_MS = 10_000;
const LOG_HIGH = 0.2;
const LOG_LOW = 0.05;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Pure score function: 0 (healthy) to 1 (saturated). */
export function computeScore(lagMs: number, dbMs: number): number {
  return Math.max(clamp01((lagMs - LAG_LOW_MS) / (LAG_HIGH_MS - LAG_LOW_MS)), clamp01((dbMs - DB_LOW_MS) / (DB_HIGH_MS - DB_LOW_MS)));
}

/**
 * Overload detector for webhook ingestion. No fixed concurrency cap: it measures event-loop lag and database
 * latency, folds them into a 0..1 score, and sheds probabilistically (Pro endpoints only past 0.5).
 */
@Injectable()
export class LoadService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoadService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private lagMs = 0;
  private dbMs = 0;
  private dbSamplesInWindow = 0;
  private measured = 0;
  private override: number | null = null;
  private lastLogAt = 0;
  private elevated = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(this.metrics.takeEventLoopP99Ms()), SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current overload score, 0 (healthy) to 1 (saturated). */
  get score(): number {
    return this.override ?? this.measured;
  }

  /** Smoothed event-loop lag (ms) and database EWMA (ms), for logs and tests. */
  get signals(): { lagMs: number; dbMs: number } {
    return { lagMs: this.lagMs, dbMs: this.dbMs };
  }

  /** Call with the duration (ms) of every capture INSERT, so database slowness feeds the score. */
  observeDb(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.dbMs = this.dbMs * (1 - DB_ALPHA) + ms * DB_ALPHA;
    this.dbSamplesInWindow++;
  }

  /** One sampling step with the p99 event-loop lag (ms) of the last window. Driven by the interval; callable in tests. */
  tick(lagSampleMs: number, now = Date.now()): void {
    // Fast attack, slow decay.
    this.lagMs = lagSampleMs >= this.lagMs ? lagSampleMs : Math.max(lagSampleMs, this.lagMs * LAG_DECAY);
    // A fully shedding server makes no inserts; without decay it would never recover.
    if (this.dbSamplesInWindow === 0) this.dbMs *= DB_IDLE_DECAY;
    this.dbSamplesInWindow = 0;
    if (this.dbMs < 0.5) this.dbMs = 0;
    this.measured = computeScore(this.lagMs, this.dbMs);
    this.maybeLog(now);
  }

  /** Decide whether to refuse this webhook. `plan` is the owner's plan, or null for anonymous endpoints. */
  shouldShed(plan: string | null, rand: () => number = Math.random): ShedDecision {
    const score = this.score;
    if (!this.cfg.shedEnabled || score <= 0) return { shed: false, retryAfterSec: 1 };
    const p = isProLike(plan) ? (score > PRO_SHED_THRESHOLD ? (score - PRO_SHED_THRESHOLD) * 2 : 0) : score;
    if (p <= 0 || rand() >= p) return { shed: false, retryAfterSec: 1 };
    const retryAfterSec = Math.min(6, Math.max(1, Math.ceil(1 + score * 4 + Math.random() * 0.9 - 0.2)));
    return { shed: true, retryAfterSec };
  }

  /** Tests only: force the score (null restores the measured one). */
  setScoreForTest(score: number | null): void {
    this.override = score === null ? null : clamp01(score);
  }

  private maybeLog(now: number): void {
    const s = this.measured;
    const crossedUp = !this.elevated && s > LOG_HIGH;
    const crossedDown = this.elevated && s < LOG_LOW;
    if (!crossedUp && !crossedDown) return;
    if (now - this.lastLogAt < LOG_INTERVAL_MS) return; // stays pending; logged on a later tick
    this.lastLogAt = now;
    this.elevated = crossedUp;
    const detail = `score=${s.toFixed(2)} lag=${this.lagMs.toFixed(0)}ms db=${this.dbMs.toFixed(0)}ms`;
    if (crossedUp) this.logger.warn(`Overload: ${detail}`);
    else this.logger.log(`Recovered: ${detail}`);
  }
}
