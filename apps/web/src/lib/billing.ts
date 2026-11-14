import { ApiError, errorMessage } from './api';
import type { Billing, Interval, Limits, PlanId, PlanInfo, PlansResponse } from './types';

/** Static numbers (docs/PRO-PLAN.md). Used until, or instead of, GET /billing/plans. */
export const FREE_LIMITS: Limits = {
  maxActiveSubdomains: 3,
  maxCustomNames: 1,
  maxBodyBytes: 5 * 1024 * 1024,
  ratePerMinute: 300,
  retentionMaxRequests: 100,
  retentionMaxAgeMs: 60 * 60 * 1000,
  retentionMaxBytes: 50 * 1024 * 1024,
  tunnelsPerAccount: 3,
  alwaysOn: false,
  reservedNames: false,
};

export const PRO_LIMITS: Limits = {
  maxActiveSubdomains: 25,
  maxCustomNames: 10,
  maxBodyBytes: 10 * 1024 * 1024,
  ratePerMinute: 1500,
  retentionMaxRequests: 1000,
  retentionMaxAgeMs: 24 * 60 * 60 * 1000,
  retentionMaxBytes: 250 * 1024 * 1024,
  tunnelsPerAccount: 5,
  alwaysOn: true,
  reservedNames: true,
};

export const STATIC_PLANS: PlanInfo[] = [
  { id: 'free', name: 'Free', priceMonthlyCents: 0, priceYearlyCents: null, limits: FREE_LIMITS },
  { id: 'pro', name: 'Pro', priceMonthlyCents: 800, priceYearlyCents: 8000, limits: PRO_LIMITS },
];

export type PlansView = { enabled: boolean; plans: PlanInfo[]; free: PlanInfo; pro: PlanInfo };

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Merges an API response over the static numbers so a partial or odd response never breaks the UI. */
export function buildPlansView(resp: Partial<PlansResponse> | null | undefined, enabledFallback: boolean): PlansView {
  const plans = STATIC_PLANS.map((base): PlanInfo => {
    const got = Array.isArray(resp?.plans) ? resp.plans.find((p) => p?.id === base.id) : undefined;
    if (!got) return base;
    const limits = { ...base.limits };
    for (const k of Object.keys(base.limits) as (keyof Limits)[]) {
      const v = got.limits?.[k];
      if (typeof v === typeof base.limits[k] && (typeof v !== 'number' || isNum(v))) (limits as Record<string, unknown>)[k] = v;
    }
    return {
      id: base.id,
      name: typeof got.name === 'string' && got.name ? got.name : base.name,
      priceMonthlyCents: isNum(got.priceMonthlyCents) ? got.priceMonthlyCents : base.priceMonthlyCents,
      priceYearlyCents: isNum(got.priceYearlyCents) ? got.priceYearlyCents : base.priceYearlyCents,
      limits,
    };
  });
  return { enabled: typeof resp?.enabled === 'boolean' ? resp.enabled : enabledFallback, plans, free: plans[0]!, pro: plans[1]! };
}

export const STATIC_PLANS_VIEW: PlansView = buildPlansView(null, true);

export function normalizePlan(p: string | null | undefined): PlanId {
  return p === 'pro' || p === 'pro_grace' || p === 'lapsed' ? p : 'free';
}

const PLAN_LABEL: Record<PlanId, string> = { free: 'Free', pro: 'Pro', pro_grace: 'Pro (payment failed)', lapsed: 'Lapsed' };
export function planLabel(p: string | null | undefined): string {
  return PLAN_LABEL[normalizePlan(p)];
}

export function billingStatusLabel(b: Pick<Billing, 'status' | 'cancelAtPeriodEnd'> | null | undefined): string {
  switch (b?.status) {
    case 'active':
      return b.cancelAtPeriodEnd ? 'Active, cancels at period end' : 'Active';
    case 'past_due':
      return 'Payment failed';
    case 'canceled':
      return 'Canceled';
    default:
      return 'No subscription';
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatMB(bytes: number): string {
  const mb = bytes / 1048576;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** 3600000 -> "1 h", 86400000 -> "24 h", 172800000 * 7 -> "14 d", 90000 -> "2 min". */
export function formatDurationMs(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 48 && Number.isInteger(h / 24)) return `${h / 24} d`;
  if (h >= 1 && Number.isInteger(h)) return `${h} h`;
  const min = Math.round(ms / 60_000);
  return `${Math.max(1, min)} min`;
}

export function formatUsd(cents: number): string {
  const v = cents / 100;
  return `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

/** Money saved by paying yearly instead of 12 monthly payments, in cents (0 when not cheaper). */
export function yearlySavingCents(p: Pick<PlanInfo, 'priceMonthlyCents' | 'priceYearlyCents'>): number {
  if (p.priceYearlyCents == null) return 0;
  return Math.max(0, p.priceMonthlyCents * 12 - p.priceYearlyCents);
}

export function formatRetention(l: Pick<Limits, 'retentionMaxRequests' | 'retentionMaxAgeMs' | 'retentionMaxBytes'>): string {
  return `${l.retentionMaxRequests} requests / ${formatDurationMs(l.retentionMaxAgeMs)} / ${formatMB(l.retentionMaxBytes)}`;
}

export type LimitRow = { key: string; label: string; value: string };

/** Human rows for a Limits object (missing keys are skipped). `used` adds "x of N" for counted limits. */
export function limitRows(l: Partial<Limits>, used?: { endpoints?: number; names?: number }): LimitRow[] {
  const rows: LimitRow[] = [];
  const of = (n: number | undefined, max: number) => (n == null ? String(max) : `${n} of ${max}`);
  if (isNum(l.maxActiveSubdomains)) rows.push({ key: 'endpoints', label: 'Endpoints', value: of(used?.endpoints, l.maxActiveSubdomains) });
  if (isNum(l.maxCustomNames)) rows.push({ key: 'names', label: l.reservedNames ? 'Reserved names' : 'Custom names', value: of(used?.names, l.maxCustomNames) });
  if (typeof l.alwaysOn === 'boolean') rows.push({ key: 'alwaysOn', label: 'Lifetime', value: l.alwaysOn ? 'Always-on' : 'Idle death at 24 h, 7-day cap' });
  if (isNum(l.retentionMaxRequests) && isNum(l.retentionMaxAgeMs) && isNum(l.retentionMaxBytes)) rows.push({ key: 'retention', label: 'Retention per endpoint', value: formatRetention(l as Limits) });
  if (isNum(l.maxBodyBytes)) rows.push({ key: 'body', label: 'Max body', value: formatMB(l.maxBodyBytes) });
  if (isNum(l.ratePerMinute)) rows.push({ key: 'rate', label: 'Rate per endpoint', value: `${l.ratePerMinute} / min` });
  if (isNum(l.tunnelsPerAccount)) rows.push({ key: 'tunnels', label: 'Simultaneous tunnels', value: String(l.tunnelsPerAccount) });
  return rows;
}

export type Banner = {
  kind: 'pro_grace' | 'lapsed';
  title: string;
  message: string;
  /** What the button does: update the card in the portal, or start a new checkout. */
  action: 'portal' | 'resubscribe';
  actionLabel: string;
};

/** Which warning banner (if any) the account page shows for the current plan and billing state. */
export function selectBanner(plan: string | null | undefined, billing: Pick<Billing, 'graceUntil' | 'lapsedUntil'> | null | undefined): Banner | null {
  const p = normalizePlan(plan);
  if (p === 'pro_grace') {
    const d = formatDate(billing?.graceUntil);
    return {
      kind: 'pro_grace',
      title: 'Payment failed',
      message: d ? `Your last payment failed. Update your card by ${d} or your endpoints go read-only.` : 'Your last payment failed. Update your card soon or your endpoints go read-only.',
      action: 'portal',
      actionLabel: 'Update payment method',
    };
  }
  if (p === 'lapsed') {
    const d = formatDate(billing?.lapsedUntil);
    return {
      kind: 'lapsed',
      title: 'Your Pro plan has ended',
      message: d ? `Your endpoints are read-only until ${d}. Resubscribe to keep them.` : 'Your endpoints are read-only. Resubscribe to keep them.',
      action: 'resubscribe',
      actionLabel: 'Resubscribe',
    };
  }
  return null;
}

/** Friendly text for the errors of POST /billing/checkout and /billing/portal. */
export function billingErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (e.code === 'billing_disabled') return 'Billing is not available right now. Please try again later.';
    if (e.code === 'already_subscribed') return 'You already have an active subscription. Use Manage billing to change or cancel it.';
    if (e.code === 'no_customer') return 'There is no billing profile for this account yet. Subscribe to Pro first.';
    if (e.status === 404) return 'Billing is not available on this server yet.';
    if (e.status === 401) return 'Your session has expired. Sign in again and retry.';
  }
  return errorMessage(e);
}

/** Only http(s) URLs may be navigated to from an API response. */
export function isRedirectUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

/** Indirection so tests can observe navigation. */
export const nav = { go: (url: string) => window.location.assign(url) };

export function parseInterval(v: string | null | undefined): Interval | null {
  return v === 'month' || v === 'year' ? v : null;
}
