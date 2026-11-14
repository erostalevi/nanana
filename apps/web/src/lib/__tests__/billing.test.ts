import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import {
  billingErrorMessage, billingStatusLabel, buildPlansView, formatDate, formatDurationMs, formatMB, formatRetention, formatUsd, FREE_LIMITS,
  isRedirectUrl, limitRows, normalizePlan, parseInterval, planLabel, PRO_LIMITS, selectBanner, yearlySavingCents,
} from '../billing';

describe('plan labels', () => {
  it('labels every plan and falls back to Free', () => {
    expect(planLabel('free')).toBe('Free');
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('pro_grace')).toBe('Pro (payment failed)');
    expect(planLabel('lapsed')).toBe('Lapsed');
    expect(planLabel('enterprise')).toBe('Free');
    expect(normalizePlan(undefined)).toBe('free');
  });
  it('labels billing status', () => {
    expect(billingStatusLabel(null)).toBe('No subscription');
    expect(billingStatusLabel({ status: 'active', cancelAtPeriodEnd: false })).toBe('Active');
    expect(billingStatusLabel({ status: 'active', cancelAtPeriodEnd: true })).toBe('Active, cancels at period end');
    expect(billingStatusLabel({ status: 'past_due', cancelAtPeriodEnd: false })).toBe('Payment failed');
    expect(billingStatusLabel({ status: 'canceled', cancelAtPeriodEnd: false })).toBe('Canceled');
  });
});

describe('formatting', () => {
  it('formats sizes, durations, money and dates', () => {
    expect(formatMB(5 * 1048576)).toBe('5 MB');
    expect(formatMB(1.5 * 1048576)).toBe('1.5 MB');
    expect(formatDurationMs(3_600_000)).toBe('1 h');
    expect(formatDurationMs(24 * 3_600_000)).toBe('24 h');
    expect(formatDurationMs(7 * 24 * 3_600_000)).toBe('7 d');
    expect(formatDurationMs(90_000)).toBe('2 min');
    expect(formatUsd(800)).toBe('$8');
    expect(formatUsd(667)).toBe('$6.67');
    expect(formatRetention(FREE_LIMITS)).toBe('100 requests / 1 h / 50 MB');
    expect(formatRetention(PRO_LIMITS)).toBe('1000 requests / 24 h / 250 MB');
    expect(formatDate(null)).toBe('');
    expect(formatDate('garbage')).toBe('');
    expect(formatDate('2026-12-14T12:00:00Z')).toMatch(/Dec 1[34], 2026/);
  });
  it('computes the yearly saving', () => {
    expect(yearlySavingCents({ priceMonthlyCents: 800, priceYearlyCents: 8000 })).toBe(1600);
    expect(yearlySavingCents({ priceMonthlyCents: 800, priceYearlyCents: null })).toBe(0);
    expect(yearlySavingCents({ priceMonthlyCents: 800, priceYearlyCents: 9999 })).toBe(0);
  });
  it('parses intervals', () => {
    expect(parseInterval('month')).toBe('month');
    expect(parseInterval('year')).toBe('year');
    expect(parseInterval('week')).toBeNull();
    expect(parseInterval(null)).toBeNull();
  });
});

describe('limitRows', () => {
  it('shows usage against the allowance and the reserved label', () => {
    const rows = limitRows(PRO_LIMITS, { endpoints: 4, names: 2 });
    expect(rows.find((r) => r.key === 'endpoints')?.value).toBe('4 of 25');
    expect(rows.find((r) => r.key === 'names')).toEqual({ key: 'names', label: 'Reserved names', value: '2 of 10' });
    expect(rows.find((r) => r.key === 'alwaysOn')?.value).toBe('Always-on');
    expect(rows.find((r) => r.key === 'body')?.value).toBe('10 MB');
    expect(rows.find((r) => r.key === 'rate')?.value).toBe('1500 / min');
  });
  it('works for free limits, without usage and with partial data', () => {
    const rows = limitRows(FREE_LIMITS);
    expect(rows.find((r) => r.key === 'endpoints')?.value).toBe('3');
    expect(rows.find((r) => r.key === 'names')?.label).toBe('Custom names');
    expect(rows.find((r) => r.key === 'alwaysOn')?.value).toMatch(/7-day cap/);
    expect(limitRows({})).toEqual([]);
  });
});

describe('selectBanner', () => {
  it('has none for free and pro', () => {
    expect(selectBanner('free', null)).toBeNull();
    expect(selectBanner('pro', { graceUntil: null, lapsedUntil: null })).toBeNull();
  });
  it('warns about the grace period with the deadline', () => {
    const b = selectBanner('pro_grace', { graceUntil: '2026-12-14T12:00:00Z', lapsedUntil: null })!;
    expect(b.kind).toBe('pro_grace');
    expect(b.action).toBe('portal');
    expect(b.message).toMatch(/Update your card by Dec 1[34], 2026 or your endpoints go read-only/);
  });
  it('warns about lapsed accounts and offers resubscribe', () => {
    const b = selectBanner('lapsed', { graceUntil: null, lapsedUntil: '2027-01-13T12:00:00Z' })!;
    expect(b.kind).toBe('lapsed');
    expect(b.action).toBe('resubscribe');
    expect(b.message).toMatch(/read-only until Jan 1[23], 2027\. Resubscribe to keep them/);
  });
  it('still renders without dates', () => {
    expect(selectBanner('pro_grace', null)!.message).toMatch(/soon/);
    expect(selectBanner('lapsed', null)!.message).toMatch(/read-only/);
  });
});

describe('buildPlansView', () => {
  it('uses static numbers without a response', () => {
    const v = buildPlansView(null, false);
    expect(v.enabled).toBe(false);
    expect(v.pro.limits.maxActiveSubdomains).toBe(25);
    expect(v.free.priceMonthlyCents).toBe(0);
  });
  it('merges API values over the static ones and ignores bad types', () => {
    const v = buildPlansView({ enabled: true, currency: 'usd', plans: [{ id: 'pro', name: 'Pro', priceMonthlyCents: 900, priceYearlyCents: 9000, limits: { ...PRO_LIMITS, maxActiveSubdomains: 30, ratePerMinute: 'x' as unknown as number } }] }, false);
    expect(v.enabled).toBe(true);
    expect(v.pro.priceMonthlyCents).toBe(900);
    expect(v.pro.limits.maxActiveSubdomains).toBe(30);
    expect(v.pro.limits.ratePerMinute).toBe(1500);
    expect(v.free.limits.maxActiveSubdomains).toBe(3);
  });
});

describe('errors and redirects', () => {
  it('maps billing error codes', () => {
    expect(billingErrorMessage(new ApiError(404, 'billing_disabled', 'x'))).toMatch(/not available right now/);
    expect(billingErrorMessage(new ApiError(409, 'already_subscribed', 'x'))).toMatch(/Manage billing/);
    expect(billingErrorMessage(new ApiError(409, 'no_customer', 'x'))).toMatch(/no billing profile/);
    expect(billingErrorMessage(new ApiError(0, 'network_error', 'x'))).toMatch(/Could not reach/);
    expect(billingErrorMessage(new ApiError(404, 'not_found', 'x'))).toMatch(/not available on this server/);
    expect(billingErrorMessage(new ApiError(500, 'boom', 'Server broke'))).toBe('Server broke');
  });
  it('only accepts http(s) redirect URLs', () => {
    expect(isRedirectUrl('https://checkout.stripe.com/c/pay/x')).toBe(true);
    expect(isRedirectUrl('javascript:alert(1)')).toBe(false);
    expect(isRedirectUrl('/relative')).toBe(false);
    expect(isRedirectUrl(undefined)).toBe(false);
  });
});
