export type PlanId = 'free' | 'pro' | 'pro_grace' | 'lapsed';

export interface PlanLimits {
  maxBodyBytes: number;
  ratePerMinute: number;
  maxActiveSubdomains: number;
  maxCustomNames: number;
  retentionMaxRequests: number;
  retentionMaxAgeMs: number;
  retentionMaxBytes: number;
  tunnelsPerAccount: number;
  alwaysOn: boolean;
  reservedNames: boolean;
}

const HOUR = 60 * 60 * 1000;
const MB = 1024 * 1024;

const ANONYMOUS: PlanLimits = {
  maxBodyBytes: 1 * MB,
  ratePerMinute: 60,
  maxActiveSubdomains: 0,
  maxCustomNames: 0,
  retentionMaxRequests: 100,
  retentionMaxAgeMs: HOUR,
  retentionMaxBytes: 50 * MB,
  tunnelsPerAccount: 1,
  alwaysOn: false,
  reservedNames: false,
};

const FREE: PlanLimits = {
  maxBodyBytes: 5 * MB,
  ratePerMinute: 300,
  maxActiveSubdomains: 3,
  maxCustomNames: 1,
  retentionMaxRequests: 100,
  retentionMaxAgeMs: HOUR,
  retentionMaxBytes: 50 * MB,
  tunnelsPerAccount: 3,
  alwaysOn: false,
  reservedNames: false,
};

const PRO: PlanLimits = {
  maxBodyBytes: 10 * MB,
  ratePerMinute: 1500,
  maxActiveSubdomains: 25,
  maxCustomNames: 10,
  retentionMaxRequests: 1000,
  retentionMaxAgeMs: 24 * HOUR,
  retentionMaxBytes: 250 * MB,
  tunnelsPerAccount: 5,
  alwaysOn: true,
  reservedNames: true,
};

export const PRICES = { monthlyCents: 800, yearlyCents: 8000, currency: 'usd' as const };

/** True while the account has Pro limits (paying, or inside the 7-day payment-failure grace). */
export const isProLike = (plan: string | null | undefined): boolean => plan === 'pro' || plan === 'pro_grace';
/** Lapsed accounts keep their endpoints for 30 days, read-only. */
export const isLapsed = (plan: string | null | undefined): boolean => plan === 'lapsed';

/** Single place where plan -> limits is decided. `null` means an anonymous (token-only) endpoint. */
export function limitsFor(plan: string | null | undefined): PlanLimits {
  if (plan === null || plan === undefined) return ANONYMOUS;
  if (isProLike(plan)) return PRO;
  return FREE;
}

export const ANONYMOUS_CREATES_PER_IP_PER_DAY = 3;
export const COLD_AFTER_MS = HOUR;
export const DEAD_AFTER_MS = 24 * HOUR;
export const GRACE_DAYS = 7;
export const LAPSED_READ_ONLY_DAYS = 30;
