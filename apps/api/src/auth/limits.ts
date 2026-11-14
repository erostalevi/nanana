import type { PlanLimits } from '../config/plan-limits.js';

export const limitsDto = (l: PlanLimits) => ({
  maxActiveSubdomains: l.maxActiveSubdomains,
  maxCustomNames: l.maxCustomNames,
  maxBodyBytes: l.maxBodyBytes,
  ratePerMinute: l.ratePerMinute,
  retentionMaxRequests: l.retentionMaxRequests,
  retentionMaxAgeMs: l.retentionMaxAgeMs,
  retentionMaxBytes: l.retentionMaxBytes,
  tunnelsPerAccount: l.tunnelsPerAccount,
  alwaysOn: l.alwaysOn,
  reservedNames: l.reservedNames,
});
