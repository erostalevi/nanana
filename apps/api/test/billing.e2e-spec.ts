import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { AuthController } from '../src/auth/auth.controller.js';
import { MailService } from '../src/auth/mail.service.js';
import { BillingService } from '../src/billing/billing.service.js';
import { PolarGateway } from '../src/billing/polar.gateway.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
import { fakeCli, harness, tryConnect, type Harness } from './helpers.js';

const WHSEC = 'polar_whs_test_secret';
let h: Harness;
let port: number;
let cfg: AppConfig;

beforeAll(async () => {
  h = await harness();
  port = await h.listen();
  cfg = h.app.get<AppConfig>(APP_CONFIG);
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.reset();
  (h.app.get(AuthController) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter();
  Object.assign(cfg, { polarAccessToken: 'polar_oat_local', polarWebhookSecret: WHSEC, polarProductMonthly: 'prod_m', polarProductYearly: 'prod_y' });
  const gw = h.app.get(PolarGateway);
  vi.spyOn(gw, 'createCheckoutUrl').mockImplementation(async (a) => `https://checkout.polar.test/${a.productId}?c=${a.accountId}`);
  vi.spyOn(gw, 'createPortalUrl').mockImplementation(async (accountId) => `https://portal.polar.test/${accountId}`);
});
afterEach(() => vi.restoreAllMocks());

async function login(email: string): Promise<{ cookie: string; accountId: string }> {
  const mail = h.app.get(MailService);
  mail.outbox.length = 0;
  await h.api('post', '/auth/magic').send({ email });
  const token = /token=(nnm_\w+)/.exec(mail.outbox[0].text)![1];
  const r = await h.api('post', '/auth/magic/verify').send({ token });
  const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('nanana_session='))!.split(';')[0];
  return { cookie, accountId: r.body.account.id };
}
const as = (cookie: string, method: 'get' | 'post' | 'patch' | 'delete', path: string) => h.api(method, path).set('Cookie', cookie);

let evtN = 0;
function subscription(accountId: string, over: Record<string, unknown> = {}) {
  return {
    id: 'sub_test_1',
    status: 'active',
    cancel_at_period_end: false,
    recurring_interval: 'month',
    current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString(),
    customer_id: `cus_${accountId.slice(0, 8)}`,
    customer: { id: `cus_${accountId.slice(0, 8)}`, external_id: accountId },
    metadata: { accountId },
    ...over,
  };
}
/** Signs and delivers a Polar webhook (Standard Webhooks: HMAC-SHA256 over `id.timestamp.body`, keyed by the secret's UTF-8 bytes). */
async function send(type: string, data: unknown, opts: { id?: string; badSig?: boolean; ageSeconds?: number } = {}) {
  const id = opts.id ?? `msg_${++evtN}`;
  const ts = Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0);
  const payload = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  const sig = createHmac('sha256', Buffer.from(WHSEC, 'utf8')).update(`${id}.${ts}.${payload}`).digest('base64');
  return h.http
    .post('/billing/webhook')
    .set('Host', 'api.localhost')
    .set('Content-Type', 'application/json')
    .set('webhook-id', id)
    .set('webhook-timestamp', String(ts))
    .set('webhook-signature', opts.badSig ? 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' : `v1,${sig}`)
    .send(payload);
}
const planOf = async (cookie: string) => (await as(cookie, 'get', '/me')).body.account.plan as string;

describe('plans and checkout', () => {
  it('lists plans publicly and reports whether billing is enabled', async () => {
    const r = await h.api('get', '/billing/plans');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const [free, pro] = r.body.plans;
    expect(free.limits.maxActiveSubdomains).toBe(3);
    expect(pro).toMatchObject({ id: 'pro', priceMonthlyCents: 800, priceYearlyCents: 8000 });
    expect(pro.limits).toMatchObject({ maxActiveSubdomains: 25, maxCustomNames: 10, retentionMaxRequests: 1000, tunnelsPerAccount: 5, alwaysOn: true, reservedNames: true });
    cfg.polarAccessToken = '';
    expect((await h.api('get', '/billing/plans')).body.enabled).toBe(false);
  });

  it('creates checkout and portal sessions for a signed-in account', async () => {
    const { cookie, accountId } = await login('buyer@example.com');
    expect((await h.api('post', '/billing/checkout').send({ interval: 'month' })).status).toBe(401);
    expect((await as(cookie, 'post', '/billing/checkout').send({ interval: 'weekly' })).body.error.code).toBe('invalid_interval');
    expect((await as(cookie, 'post', '/billing/portal')).body.error.code).toBe('no_customer');
    const month = await as(cookie, 'post', '/billing/checkout').send({ interval: 'month' });
    expect(month.status).toBe(200);
    expect(month.body.url).toContain('prod_m');
    const year = await as(cookie, 'post', '/billing/checkout').send({ interval: 'year' });
    expect(year.body.url).toContain('prod_y');
    expect((await as(cookie, 'post', '/billing/portal')).body.error.code).toBe('no_customer'); // Polar creates the customer at checkout; we learn of it from the webhook
    await send('subscription.created', subscription(accountId));
    const portal = await as(cookie, 'post', '/billing/portal');
    expect(portal.status).toBe(200);
    expect(portal.body.url).toContain('portal.polar.test/');
    cfg.polarAccessToken = '';
    expect((await as(cookie, 'post', '/billing/portal')).body.error.code).toBe('billing_disabled');
  });
});

describe('webhook and plan state machine', () => {
  it('rejects bad signatures and ignores duplicate events', async () => {
    const { accountId } = await login('a@example.com');
    expect((await send('subscription.created', subscription(accountId), { badSig: true })).status).toBe(400);
    expect((await h.http.post('/billing/webhook').set('Host', 'api.localhost').send('{}')).status).toBe(400);
    const first = await send('subscription.created', subscription(accountId), { id: 'msg_dup' });
    expect(first.status).toBe(200);
    const second = await send('subscription.created', subscription(accountId, { status: 'canceled' }), { id: 'msg_dup' });
    expect(second.status).toBe(200);
    const [{ n }] = await h.ds.query(`SELECT count(*) AS n FROM webhook_event WHERE id = 'msg_dup'`);
    expect(Number(n)).toBe(1);
    const [acct] = await h.ds.query('SELECT plan FROM account WHERE id = $1', [accountId]);
    expect(acct.plan).toBe('pro'); // the duplicate (canceled) payload was ignored
  });

  it('active subscription -> Pro limits everywhere; payment failure -> grace; cancellation -> lapsed', async () => {
    const { cookie, accountId } = await login('pro@example.com');
    expect(await planOf(cookie)).toBe('free');

    await send('subscription.created', subscription(accountId));
    let me = (await as(cookie, 'get', '/me')).body;
    expect(me.account.plan).toBe('pro');
    expect(me.limits).toMatchObject({ maxActiveSubdomains: 25, alwaysOn: true, ratePerMinute: 1500 });
    expect(me.billing).toMatchObject({ enabled: true, status: 'active', interval: 'month', cancelAtPeriodEnd: false, graceUntil: null });
    expect(me.billing.currentPeriodEnd).toBeTruthy();
    const created = await as(cookie, 'post', '/subdomains').send({ name: 'my-reserved' });
    expect(created.body.subdomain).toMatchObject({ alwaysOn: true, readOnly: false, reserved: true, isCustom: true });

    // payment fails: still Pro limits, 7-day grace
    await send('subscription.updated', subscription(accountId, { status: 'past_due' }));
    me = (await as(cookie, 'get', '/me')).body;
    expect(me.account.plan).toBe('pro_grace');
    expect(me.limits.maxActiveSubdomains).toBe(25);
    expect(me.billing.status).toBe('past_due');
    const graceDays = (new Date(me.billing.graceUntil).getTime() - Date.now()) / 86400_000;
    expect(graceDays).toBeGreaterThan(6.9);
    expect(graceDays).toBeLessThanOrEqual(7);

    // card fixed: back to pro, grace cleared
    await send('subscription.updated', subscription(accountId, { status: 'active' }));
    me = (await as(cookie, 'get', '/me')).body;
    expect(me.account.plan).toBe('pro');
    expect(me.billing.graceUntil).toBeNull();

    // subscription deleted: lapsed, read-only
    await send('subscription.revoked', subscription(accountId, { status: 'canceled' }));
    me = (await as(cookie, 'get', '/me')).body;
    expect(me.account.plan).toBe('lapsed');
    expect(me.limits.maxActiveSubdomains).toBe(3);
    const lapsedDays = (new Date(me.billing.lapsedUntil).getTime() - Date.now()) / 86400_000;
    expect(lapsedDays).toBeGreaterThan(29.9);
    const sub = (await as(cookie, 'get', '/subdomains')).body.subdomains[0];
    expect(sub).toMatchObject({ readOnly: true, alwaysOn: false, reserved: true });
    const r = await h.ingress(sub.slug).send('x');
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('endpoint_read_only');
    const [{ n }] = await h.ds.query('SELECT count(*) AS n FROM captured_request');
    expect(Number(n)).toBe(0);

    // resubscribe during the read-only window restores everything
    await send('subscription.created', subscription(accountId, { id: 'sub_test_2' }));
    expect(await planOf(cookie)).toBe('pro');
    expect((await h.ingress(sub.slug).send('x')).status).toBe(200);
  });

  it('links the Polar customer to the account on the first subscription event', async () => {
    const { cookie, accountId } = await login('chk@example.com');
    expect((await as(cookie, 'post', '/billing/portal')).body.error.code).toBe('no_customer');
    const res = await send('subscription.active', subscription(accountId, { id: 'sub_from_checkout', customer_id: 'cus_abc', customer: { id: 'cus_abc', external_id: accountId } }));
    expect(res.status).toBe(200);
    expect(await planOf(cookie)).toBe('pro');
    const row = await h.app.get(BillingService).get(accountId);
    expect(row).toMatchObject({ provider_customer_id: 'cus_abc', provider_subscription_id: 'sub_from_checkout', status: 'active' });
    expect((await as(cookie, 'post', '/billing/checkout').send({ interval: 'month' })).body.error.code).toBe('already_subscribed');
    expect((await as(cookie, 'post', '/billing/portal')).status).toBe(200);
  });

  it('ignores events for unknown customers, non-subscription events and stale or unsigned deliveries', async () => {
    const { cookie, accountId } = await login('noise@example.com');
    expect((await send('subscription.active', subscription('00000000-0000-4000-8000-000000000000'))).status).toBe(200);
    expect((await send('order.paid', { id: 'ord_1' })).status).toBe(200);
    expect(await planOf(cookie)).toBe('free');
    expect((await send('subscription.active', subscription(accountId), { ageSeconds: 3600 })).status).toBe(400); // replayed old delivery
    expect(await planOf(cookie)).toBe('free');
  });

  it('a yearly subscription is reported as such, and cancel-at-period-end keeps Pro until the period ends', async () => {
    const { cookie, accountId } = await login('yr@example.com');
    await send('subscription.active', subscription(accountId, { recurring_interval: 'year' }));
    await send('subscription.canceled', subscription(accountId, { recurring_interval: 'year', cancel_at_period_end: true }));
    const me = (await as(cookie, 'get', '/me')).body;
    expect(me.account.plan).toBe('pro');
    expect(me.billing).toMatchObject({ interval: 'year', cancelAtPeriodEnd: true, status: 'active' });
  });

  it('lapses after the 7-day grace and returns to free after 30 days with cleanup', async () => {
    const { cookie, accountId } = await login('flow@example.com');
    await send('subscription.created', subscription(accountId));
    const slugs: string[] = [];
    for (let i = 0; i < 5; i++) slugs.push((await as(cookie, 'post', '/subdomains').send(i === 0 ? { name: 'keep-my-name' } : {})).body.subdomain.slug);
    await as(cookie, 'delete', '/subdomains/keep-my-name'); // Pro: name stays reserved
    const [tomb] = await h.ds.query(`SELECT until FROM slug_tombstone WHERE slug = 'keep-my-name'`);
    expect(String(tomb.until)).toMatch(/infinity|Infinity/);
    const other = await login('other@example.com');
    expect((await as(other.cookie, 'post', '/subdomains').send({ name: 'keep-my-name' })).body.error.code).toBe('name_tombstoned');

    await send('subscription.updated', subscription(accountId, { status: 'past_due' }));
    await h.ds.query(`UPDATE subscription SET grace_until = now() - interval '1 minute' WHERE account_id = $1`, [accountId]);
    const bill = h.app.get(BillingService);
    expect((await bill.housekeeping()).lapsed).toBe(1);
    expect(await planOf(cookie)).toBe('lapsed');

    // the lifecycle job leaves lapsed endpoints alone, even past the 7-day cap
    await h.ds.query(`UPDATE subdomain SET hard_expires_at = now() - interval '1 day', last_activity_at = now() - interval '3 days' WHERE owner_id = $1`, [accountId]);
    expect((await h.app.get(LifecycleService).run()).dead).toBe(0);

    await h.ds.query(`UPDATE subscription SET lapsed_until = now() - interval '1 minute' WHERE account_id = $1`, [accountId]);
    expect((await bill.housekeeping()).downgraded).toBe(1);
    expect(await planOf(cookie)).toBe('free');
    const [t2] = await h.ds.query(`SELECT until FROM slug_tombstone WHERE slug = 'keep-my-name'`);
    expect(new Date(t2.until).getTime() - Date.now()).toBeLessThan(7.1 * 86400_000);
    const rows = await h.ds.query(`SELECT slug, extract(epoch FROM (hard_expires_at - now())) / 86400 AS days FROM subdomain WHERE owner_id = $1 ORDER BY created_at DESC`, [accountId]);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r: { days: string }) => Number(r.days) > 6.5)).toHaveLength(3); // free limit keeps 3 endpoints on a fresh 7-day clock
    expect(rows.filter((r: { days: string }) => Number(r.days) < 3.1)).toHaveLength(1); // the rest are queued for removal
  });
});

describe('Pro entitlements', () => {
  it('allows 25 endpoints and 10 custom names, always-on, 24 h retention', async () => {
    const { cookie, accountId } = await login('big@example.com');
    const create = (b: object) => as(cookie, 'post', '/subdomains').send(b);
    for (let i = 0; i < 3; i++) expect((await create({})).status).toBe(201);
    expect((await create({})).body.error.code).toBe('limit_reached'); // free: 3
    await send('subscription.created', subscription(accountId));
    for (let i = 0; i < 10; i++) expect((await create({ name: `name-number-${i}` })).status).toBe(201);
    expect((await create({ name: 'name-number-x' })).body.error.code).toBe('limit_reached');

    const slug = (await as(cookie, 'get', '/subdomains')).body.subdomains[0].slug;
    // always-on: no idle death, no 7-day cap
    await h.ds.query(`UPDATE subdomain SET last_activity_at = now() - interval '5 days', hard_expires_at = now() - interval '1 day' WHERE owner_id = $1`, [accountId]);
    expect((await h.app.get(LifecycleService).run()).dead).toBe(0);
    expect((await h.ingress(slug).send('still here')).status).toBe(200);
    // retention: 2-hour-old captures survive for Pro, not for free/anonymous
    const anon = await h.create();
    await h.ingress(anon.slug).send('x');
    await h.ds.query(`UPDATE captured_request SET received_at = now() - interval '2 hours'`);
    await h.app.get(LifecycleService).run();
    const proList = await as(cookie, 'get', `/subdomains/${slug}/requests`);
    expect(proList.body.requests).toHaveLength(1);
    expect((await h.api('get', `/subdomains/${anon.slug}/requests`, anon.token)).body.requests).toHaveLength(0);
  });

  it('keeps more than 100 requests for Pro', async () => {
    const { cookie, accountId } = await login('keep@example.com');
    await send('subscription.created', subscription(accountId));
    const slug = (await as(cookie, 'post', '/subdomains').send({})).body.subdomain.slug;
    const sub = (await h.ds.query('SELECT id FROM subdomain WHERE slug = $1', [slug]))[0];
    const { v7 } = await import('uuid');
    for (let i = 0; i < 130; i++)
      await h.ds.query(`INSERT INTO captured_request (id, subdomain_id, method, path, headers, body, body_size, source_ip) VALUES ($1,$2,'GET',$3,'{}',''::bytea,0,'1.1.1.1')`, [v7(), sub.id, `/${i}`]);
    expect((await h.ingress(slug).send('trigger retention')).status).toBe(200);
    const [{ n }] = await h.ds.query('SELECT count(*) AS n FROM captured_request WHERE subdomain_id = $1', [sub.id]);
    expect(Number(n)).toBe(131); // nothing evicted: Pro keeps up to 1000
  });

  it('limits simultaneous tunnels per account (free 3, Pro 5)', async () => {
    const { cookie, accountId } = await login('tun@example.com');
    await send('subscription.created', subscription(accountId));
    const subs: { slug: string }[] = [];
    for (let i = 0; i < 6; i++) subs.push((await as(cookie, 'post', '/subdomains').send({})).body.subdomain);
    const token = (await as(cookie, 'post', `/subdomains/${subs[0].slug}/token`)).body.token as string;
    void token;
    const connected = [];
    for (let i = 0; i < 5; i++) {
      const t = (await as(cookie, 'post', `/subdomains/${subs[i].slug}/token`)).body.token as string;
      connected.push(await fakeCli(port, subs[i].slug, t, () => ({ status: 200 })));
    }
    const t6 = (await as(cookie, 'post', `/subdomains/${subs[5].slug}/token`)).body.token as string;
    expect(await tryConnect(port, subs[5].slug, { Authorization: `Bearer ${t6}` })).toBe(403);
    connected[0].close();
    await new Promise((r) => setTimeout(r, 300));
    expect(await tryConnect(port, subs[5].slug, { Authorization: `Bearer ${t6}` })).toBe(101);
    connected.slice(1).forEach((c) => c.close());
  });
});
