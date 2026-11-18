import type { Page, Route } from '@playwright/test';
import { API_URL } from './env';

/**
 * Billing mocks for the browser: the real API has no payment provider in tests, so the billing routes (and /me, to put the
 * account in any plan) are answered by page.route. Everything not mocked here goes to the real API.
 */

export const FREE_LIMITS = { maxActiveSubdomains: 3, maxCustomNames: 1, maxBodyBytes: 5 * 1048576, ratePerMinute: 300, retentionMaxRequests: 100, retentionMaxAgeMs: 3_600_000, retentionMaxBytes: 50 * 1048576, tunnelsPerAccount: 3, alwaysOn: false, reservedNames: false };
export const PRO_LIMITS = { maxActiveSubdomains: 25, maxCustomNames: 10, maxBodyBytes: 10 * 1048576, ratePerMinute: 1500, retentionMaxRequests: 1000, retentionMaxAgeMs: 86_400_000, retentionMaxBytes: 250 * 1048576, tunnelsPerAccount: 5, alwaysOn: true, reservedNames: true };

export const plansBody = (over: { enabled?: boolean; proLimits?: Partial<typeof PRO_LIMITS> } = {}) => ({
  enabled: over.enabled ?? true,
  currency: 'usd',
  plans: [
    { id: 'free', name: 'Free', priceMonthlyCents: 0, priceYearlyCents: null, limits: FREE_LIMITS },
    { id: 'pro', name: 'Pro', priceMonthlyCents: 800, priceYearlyCents: 8000, limits: { ...PRO_LIMITS, ...over.proLimits } },
  ],
});

export type Plan = 'free' | 'pro' | 'pro_grace' | 'lapsed';
export type BillingBody = { enabled: boolean; status: 'none' | 'active' | 'past_due' | 'canceled'; interval: 'month' | 'year' | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null; lapsedUntil: string | null };

const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

export function billingFor(plan: Plan, over: Partial<BillingBody> = {}): BillingBody {
  const base: BillingBody = { enabled: true, status: 'none', interval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null, lapsedUntil: null };
  if (plan === 'pro') Object.assign(base, { status: 'active', interval: 'month', currentPeriodEnd: iso(20) });
  if (plan === 'pro_grace') Object.assign(base, { status: 'past_due', interval: 'month', currentPeriodEnd: iso(-2), graceUntil: iso(5) });
  if (plan === 'lapsed') Object.assign(base, { status: 'canceled', interval: 'month', currentPeriodEnd: iso(-10), lapsedUntil: iso(20) });
  return { ...base, ...over };
}

export function meFor(plan: Plan, billing: BillingBody = billingFor(plan)) {
  return {
    account: { id: 'acc-mock', email: 'mock@example.test', displayName: null, plan },
    limits: plan === 'pro' || plan === 'pro_grace' ? PRO_LIMITS : FREE_LIMITS,
    billing,
    providers: { github: false, google: false, magic: true },
  };
}

export const sub = (slug: string, over: Record<string, unknown> = {}) => ({
  slug, url: `http://${slug}.localhost:3201`, dashboardUrl: `http://${slug}.tools.localhost:5173`, isCustom: false, ownerId: 'acc-mock', state: 'active',
  lastActivityAt: new Date().toISOString(), hardExpiresAt: iso(6), offlineStatus: 200, offlineBody: '{"ok":true}', hmac: null, tunnelOnline: false, mock: null,
  alwaysOn: false, readOnly: false, reserved: false, ...over,
});

export type Answer = { status?: number; body?: unknown };
export type Mock = {
  /** `null` = signed out (401). */
  me: ReturnType<typeof meFor> | null | (() => ReturnType<typeof meFor> | null);
  /** `null` = GET /billing is 404; `undefined` = derived from `me.billing`. */
  billing: BillingBody | null | undefined;
  /** `null` = GET /billing/plans is 404. */
  plans: ReturnType<typeof plansBody> | null;
  subdomains: ReturnType<typeof sub>[];
  checkout: Answer;
  portal: Answer;
  calls: { method: string; path: string; body: unknown }[];
  count(method: string, path: string): number;
};

export const CHECKOUT_URL = 'https://checkout.polar.test/c/pay/fake';
export const PORTAL_URL = 'https://portal.polar.test/p/session/fake';
const err = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });
export const checkoutErrors = { disabled: err(404, 'billing_disabled'), subscribed: err(409, 'already_subscribed'), noCustomer: err(409, 'no_customer') };

/** Installs the mocks on a page and returns a mutable handle (change `mock.me` etc. mid-test). */
export async function mockBilling(page: Page, init: Partial<Omit<Mock, 'calls' | 'count'>> = {}): Promise<Mock> {
  const mock: Mock = {
    me: meFor('free'),
    billing: undefined,
    plans: plansBody(),
    subdomains: [],
    checkout: { body: { url: CHECKOUT_URL } },
    portal: { body: { url: PORTAL_URL } },
    calls: [],
    count: (m, p) => mock.calls.filter((c) => c.method === m && c.path === p).length,
    ...init,
  };
  // Fake hosted pages so a redirect has somewhere to land (no network).
  for (const [pattern, title] of [['https://checkout.polar.test/**', 'Fake Polar Checkout'], ['https://portal.polar.test/**', 'Fake Polar Portal']] as const) {
    await page.route(pattern, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>${title}</title><h1>${title}</h1>` }));
  }
  await page.route((u) => u.origin === API_URL, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const origin = req.headers().origin ?? '*';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', vary: 'origin' };
    const reply = (a: Answer) => route.fulfill({ status: a.status ?? 200, headers: cors, contentType: 'application/json', body: JSON.stringify(a.body ?? {}) });
    const p = url.pathname;
    const mocked = ['/me', '/billing', '/billing/plans', '/billing/checkout', '/billing/portal', '/subdomains'].includes(p);
    if (method === 'OPTIONS' && mocked) return route.fulfill({ status: 204, headers: cors });
    if (!mocked) return route.fallback();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    mock.calls.push({ method, path: p, body });
    if (p === '/me' && method === 'GET') {
      const me = typeof mock.me === 'function' ? mock.me() : mock.me;
      return reply(me ? { body: me } : err(401, 'unauthorized'));
    }
    if (p === '/billing' && method === 'GET') {
      const me = typeof mock.me === 'function' ? mock.me() : mock.me;
      const b = mock.billing === undefined ? me?.billing : mock.billing;
      return reply(b ? { body: { plan: me?.account.plan, ...b } } : err(404, 'not_found'));
    }
    if (p === '/billing/plans' && method === 'GET') return reply(mock.plans ? { body: mock.plans } : err(404, 'not_found'));
    if (p === '/billing/checkout' && method === 'POST') return reply(mock.checkout);
    if (p === '/billing/portal' && method === 'POST') return reply(mock.portal);
    if (p === '/subdomains' && method === 'GET') return reply({ body: { subdomains: mock.subdomains } });
    return route.fallback();
  });
  // Account page extra: CLI logins list for a mocked session.
  await page.route((u) => u.origin === API_URL && u.pathname === '/me/tokens', (r) =>
    r.fulfill({ status: 200, headers: { 'access-control-allow-origin': r.request().headers().origin ?? '*', 'access-control-allow-credentials': 'true' }, contentType: 'application/json', body: JSON.stringify({ tokens: [] }) }));
  return mock;
}
