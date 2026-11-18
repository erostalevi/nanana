import { Injectable } from '@nestjs/common';

export interface ShedDecision {
  shed: boolean;
  /** Seconds for the Retry-After header (only meaningful when shed). */
  retryAfterSec: number;
}

/**
 * Overload detector for webhook ingestion. SKELETON: the interface is final, the body is a placeholder.
 * The `perf-shed` session owns the real implementation (event-loop lag + database latency -> score 0..1,
 * probabilistic shedding, Pro endpoints protected until the score passes 0.5). Do not change the signatures.
 */
@Injectable()
export class LoadService {
  /** Current overload score, 0 (healthy) to 1 (saturated). */
  get score(): number {
    return 0;
  }

  /** Call with the duration (ms) of every capture INSERT, so database slowness feeds the score. */
  observeDb(_ms: number): void {}

  /** Decide whether to refuse this webhook. `plan` is the owner's plan, or null for anonymous endpoints. */
  shouldShed(_plan: string | null, _rand: () => number = Math.random): ShedDecision {
    return { shed: false, retryAfterSec: 1 };
  }

  /** Tests only: force the score (null restores the measured one). */
  setScoreForTest(_score: number | null): void {}
}
