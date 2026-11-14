export interface PlanLimits {
  maxBodyBytes: number;
  ratePerMinute: number;
  maxActiveSubdomains: number;
  maxCustomNames: number;
  retentionMaxRequests: number;
  retentionMaxAgeMs: number;
}

const HOUR = 60 * 60 * 1000;

const ANONYMOUS: PlanLimits = {
  maxBodyBytes: 1 * 1024 * 1024,
  ratePerMinute: 60,
  maxActiveSubdomains: 0,
  maxCustomNames: 0,
  retentionMaxRequests: 100,
  retentionMaxAgeMs: HOUR,
};

const FREE: PlanLimits = {
  maxBodyBytes: 10 * 1024 * 1024,
  ratePerMinute: 300,
  maxActiveSubdomains: 3,
  maxCustomNames: 1,
  retentionMaxRequests: 100,
  retentionMaxAgeMs: HOUR,
};

/** Single place where plan -> limits is decided; paid tiers plug in here later. */
export function limitsFor(plan: string | null): PlanLimits {
  if (plan === null) return ANONYMOUS;
  switch (plan) {
    case 'free':
    default:
      return FREE;
  }
}

export const ANONYMOUS_CREATES_PER_IP_PER_DAY = 3;
export const COLD_AFTER_MS = HOUR;
export const DEAD_AFTER_MS = 24 * HOUR;
