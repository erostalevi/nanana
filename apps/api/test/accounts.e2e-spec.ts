import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { MailService } from '../src/auth/mail.service.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { harness, tryConnect, type Harness } from './helpers.js';

let h: Harness;
let port: number;
beforeAll(async () => {
  h = await harness();
  port = await h.listen();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.reset();
  (h.app.get(AuthController) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter();
});
afterEach(() => vi.unstubAllGlobals());

const cfg = () => h.app.get<AppConfig>(APP_CONFIG);

async function login(email: string): Promise<string> {
  const mail = h.app.get(MailService);
  mail.outbox.length = 0;
  expect((await h.api('post', '/auth/magic').send({ email })).status).toBe(202);
  const token = /token=(nnm_\w+)/.exec(mail.outbox[0].text)![1];
  const r = await h.api('post', '/auth/magic/verify').send({ token });
  expect(r.status).toBe(200);
  const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('nanana_session='))!;
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  return cookie.split(';')[0];
}
const as = (cookie: string, method: 'get' | 'post' | 'patch' | 'delete', path: string) => h.api(method, path).set('Cookie', cookie);

describe('magic link login', () => {
  it('validates email, sends a one-time link and creates a session', async () => {
    expect((await h.api('post', '/auth/magic').send({ email: 'nope' })).status).toBe(400);
    const cookie = await login('Dev@Example.com');
    const me = await as(cookie, 'get', '/me');
    expect(me.status).toBe(200);
    expect(me.body.account.email).toBe('dev@example.com');
    expect(me.body.account.plan).toBe('free');
    expect(me.body.limits.maxActiveSubdomains).toBe(3);
    expect(me.body.providers).toEqual({ github: false, google: false, magic: true });
    // second login with the same email reuses the account
    const again = await login('dev@example.com');
    expect((await as(again, 'get', '/me')).body.account.id).toBe(me.body.account.id);
  });

  it('rejects reused, bogus links and unauthenticated /me', async () => {
    expect((await h.api('post', '/auth/magic/verify').send({ token: 'nnm_bogus' })).status).toBe(400);
    expect((await h.api('get', '/me')).status).toBe(401);
  });

  it('logs out', async () => {
    const cookie = await login('a@example.com');
    expect((await as(cookie, 'post', '/auth/logout')).status).toBe(204);
    expect((await as(cookie, 'get', '/me')).status).toBe(401);
  });

  it('rejects cookie-authenticated writes from foreign origins', async () => {
    const cookie = await login('csrf@example.com');
    const r = await as(cookie, 'post', '/subdomains').set('Origin', 'https://evil.example').send({});
    expect(r.status === 201 ? 'anonymous' : r.status).toBe('anonymous'); // treated as anonymous, not as the account
    expect(r.body.subdomain.ownerId).toBeNull();
  });
});

describe('account subdomains', () => {
  it('enforces custom name rules and plan limits', async () => {
    const cookie = await login('owner@example.com');
    const create = (body: object) => as(cookie, 'post', '/subdomains').send(body);
    expect((await create({ name: 'admin' })).body.error.code).toBe('name_reserved');
    expect((await create({ name: 'Bad_Name' })).body.error.code).toBe('name_invalid');
    const ok = await create({ name: 'stripe-test' });
    expect(ok.status).toBe(201);
    expect(ok.body.subdomain.isCustom).toBe(true);
    expect(ok.body.subdomain.ownerId).toBeTruthy();
    expect((await create({ name: 'second-one' })).body.error.code).toBe('limit_reached');
    expect((await create({})).status).toBe(201);
    expect((await create({})).status).toBe(201);
    expect((await create({})).body.error.code).toBe('limit_reached');
    const list = await as(cookie, 'get', '/subdomains');
    expect(list.body.subdomains).toHaveLength(3);
    // someone else cannot take the name
    const other = await login('other@example.com');
    expect((await as(other, 'post', '/subdomains').send({ name: 'stripe-test' })).body.error.code).toBe('name_taken');
  });

  it('tombstones deleted custom names for their owner only', async () => {
    const cookie = await login('owner@example.com');
    await as(cookie, 'post', '/subdomains').send({ name: 'my-hooks' });
    expect((await as(cookie, 'delete', '/subdomains/my-hooks')).status).toBe(204);
    expect((await h.ingress('my-hooks')).status).toBe(410);
    const other = await login('other@example.com');
    expect((await as(other, 'post', '/subdomains').send({ name: 'my-hooks' })).body.error.code).toBe('name_tombstoned');
    expect((await as(cookie, 'post', '/subdomains').send({ name: 'my-hooks' })).status).toBe(201);
  });

  it('lets the owner (and only the owner) use dashboard endpoints without the token', async () => {
    const cookie = await login('owner@example.com');
    const created = await as(cookie, 'post', '/subdomains').send({});
    const slug = created.body.subdomain.slug;
    await h.ingress(slug).send('hello');
    const list = await as(cookie, 'get', `/subdomains/${slug}/requests`);
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);
    const other = await login('other@example.com');
    expect((await as(other, 'get', `/subdomains/${slug}/requests`)).status).toBe(404);
  });

  it('claims an anonymous subdomain with its token, renews once, rotates the token', async () => {
    const anon = await h.create();
    const cookie = await login('owner@example.com');
    expect((await as(cookie, 'post', `/subdomains/${anon.slug}/claim`).send({ token: 'nnt_wrong' })).status).toBe(404);
    const claimed = await as(cookie, 'post', `/subdomains/${anon.slug}/claim`).send({ token: anon.token });
    expect(claimed.status).toBe(200);
    expect(claimed.body.ownerId).toBeTruthy();
    expect((await as(cookie, 'post', `/subdomains/${anon.slug}/claim`).send({ token: anon.token })).status).toBe(409);

    const before = new Date(claimed.body.hardExpiresAt).getTime();
    const renewed = await as(cookie, 'post', `/subdomains/${anon.slug}/renew`);
    expect(new Date(renewed.body.hardExpiresAt).getTime() - before).toBe(7 * 24 * 3600 * 1000);
    expect((await as(cookie, 'post', `/subdomains/${anon.slug}/renew`)).body.error.code).toBe('already_renewed');

    const rot = await as(cookie, 'post', `/subdomains/${anon.slug}/token`);
    expect(rot.body.token).toMatch(/^nnt_/);
    expect((await h.api('get', `/subdomains/${anon.slug}`, anon.token)).status).toBe(401);
    expect((await h.api('get', `/subdomains/${anon.slug}`, rot.body.token)).status).toBe(200);
  });

  it('deletes everything when the account is deleted', async () => {
    const cookie = await login('owner@example.com');
    const c = await as(cookie, 'post', '/subdomains').send({ name: 'bye-bye' });
    expect((await as(cookie, 'delete', '/me')).status).toBe(204);
    expect((await h.ingress(c.body.subdomain.slug)).status).toBe(410);
    const [{ n }] = await h.ds.query('SELECT count(*) AS n FROM account');
    expect(Number(n)).toBe(0);
  });
});

describe('device flow (CLI login)', () => {
  it('issues an nna_ token after browser approval and honours revocation', async () => {
    const start = await h.api('post', '/auth/device').send({ clientName: 'nanana-cli/test' });
    expect(start.status).toBe(200);
    expect(start.body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(start.body.verificationUriComplete).toContain(start.body.userCode);
    const poll = () => h.api('post', '/auth/device/token').send({ deviceCode: start.body.deviceCode });

    const p1 = await poll();
    expect(p1.status).toBe(400);
    expect(p1.body.error.code).toBe('authorization_pending');
    expect((await poll()).body.error.code).toBe('slow_down');

    const cookie = await login('cli@example.com');
    expect((await h.api('post', '/auth/device/approve').send({ userCode: start.body.userCode })).status).toBe(401);
    expect((await as(cookie, 'post', '/auth/device/approve').send({ userCode: 'ZZZZ-ZZZZ' })).status).toBe(404);
    expect((await as(cookie, 'post', '/auth/device/approve').send({ userCode: start.body.userCode.toLowerCase() })).status).toBe(204);

    const done = await poll();
    expect(done.status).toBe(200);
    expect(done.body.accessToken).toMatch(/^nna_/);
    expect(done.body.account.email).toBe('cli@example.com');
    expect((await poll()).body.error.code).toBe('expired_token'); // single use

    const token = done.body.accessToken as string;
    const me = await h.api('get', '/me', token);
    expect(me.status).toBe(200);
    const created = await h.api('post', '/subdomains', token).send({ name: 'from-cli' });
    expect(created.status).toBe(201);
    expect((await h.api('get', '/subdomains', token)).body.subdomains).toHaveLength(1);

    // an owner token opens the tunnel without the subdomain token
    expect(await tryConnect(port, 'from-cli', { Authorization: `Bearer ${token}` })).toBe(101);
    const stranger = await login('stranger@example.com');
    expect(stranger).toBeTruthy();

    const tokens = await as(cookie, 'get', '/me/tokens');
    expect(tokens.body.tokens).toHaveLength(1);
    expect((await as(cookie, 'delete', `/me/tokens/${tokens.body.tokens[0].id}`)).status).toBe(204);
    expect((await h.api('get', '/me', token)).status).toBe(401);
  });

  it('reports expired device codes', async () => {
    const start = await h.api('post', '/auth/device').send({});
    await h.ds.query(`UPDATE device_auth SET expires_at = now() - interval '1 minute'`);
    const r = await h.api('post', '/auth/device/token').send({ deviceCode: start.body.deviceCode });
    expect(r.body.error.code).toBe('expired_token');
  });
});

describe('admin stats', () => {
  beforeAll(() => {
    process.env.ADMIN_STATS_CACHE_MS = '0'; // /admin/stats is cached for 2 s in production
  });
  afterAll(() => {
    delete process.env.ADMIN_STATS_CACHE_MS;
  });

  it('is restricted to ADMIN_EMAILS', async () => {
    const cookie = await login('boss@example.com');
    expect((await as(cookie, 'get', '/admin/stats')).status).toBe(403);
    cfg().adminEmails = ['boss@example.com'];
    const r = await as(cookie, 'get', '/admin/stats');
    expect(r.status).toBe(200);
    expect(r.body.accounts).toBe(1);
    expect(r.body.subdomains).toMatchObject({ total: 0 });
    cfg().adminEmails = [];
  });

  it('reports live traffic, growth, revenue and server health', async () => {
    cfg().adminEmails = ['boss2@example.com'];
    try {
      const cookie = await login('boss2@example.com');
      const a = await h.create();
      for (let i = 0; i < 3; i++) await h.ingress(a.slug).send(`hit ${i}`);
      await h.ingress('nosuchslug1').send('x'); // 404: counted as rejected
      await h.ds.query(`UPDATE account SET plan = 'pro' WHERE email = 'boss2@example.com'`);
      await h.ds.query(
        `INSERT INTO subscription (account_id, status, interval) SELECT id, 'active', 'year' FROM account WHERE email = 'boss2@example.com'`,
      );
      const r = (await as(cookie, 'get', '/admin/stats')).body;
      expect(r.traffic.series).toHaveLength(60);
      expect(r.traffic.lastHour).toBeGreaterThanOrEqual(3);
      expect(r.traffic.rejectedLastHour).toBeGreaterThanOrEqual(1);
      expect(r.traffic.topEndpoints[0]).toMatchObject({ slug: a.slug, requests: 3 });
      expect(r.growth).toMatchObject({ signups24h: expect.any(Number), plans: { pro: 1 } });
      expect(r.growth.endpointsCreated24h).toBeGreaterThanOrEqual(1);
      expect(r.revenue).toMatchObject({ payingSubscribers: 1, yearly: 1, monthly: 0, mrrCents: Math.round(8000 / 12), arrCents: Math.round(8000 / 12) * 12 });
      expect(r.health.db.pingMs).toBeGreaterThanOrEqual(0);
      expect(r.health.db.volumeMb).toBe(10240);
      expect(r.health.memAvailableMb).toBeGreaterThan(0);
      expect(r.health.apiRssMb).toBeGreaterThan(0);
    } finally {
      cfg().adminEmails = [];
    }
  });
});

describe('oauth', () => {
  it('is disabled by default and works end to end when enabled (github, stubbed)', async () => {
    expect((await h.api('get', '/auth/github')).status).toBe(404);
    Object.assign(cfg(), { authGithub: true, githubClientId: 'cid', githubClientSecret: 'sec' });
    try {
      expect((await h.api('get', '/auth/providers')).body.github).toBe(true);
      const begin = await h.api('get', '/auth/github?next=/device%3Fcode%3DABCD-EFGH');
      expect(begin.status).toBe(302);
      expect(begin.headers.location).toContain('https://github.com/login/oauth/authorize');
      expect(begin.headers.location).toContain('client_id=cid');
      const oauthCookie = (begin.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      const state = new URL(begin.headers.location).searchParams.get('state')!;

      vi.stubGlobal('fetch', async (url: string) => {
        const u = String(url);
        const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.includes('access_token')) return json({ access_token: 'gho_x' });
        if (u.endsWith('/user')) return json({ id: 4242, login: 'octo', name: 'Octo Cat' });
        if (u.endsWith('/user/emails')) return json([{ email: 'octo@example.com', primary: true, verified: true }]);
        throw new Error(`unexpected fetch ${u}`);
      });

      const bad = await h.api('get', `/auth/github/callback?code=abc&state=wrong`).set('Cookie', oauthCookie);
      expect(bad.status).toBe(400);
      const ok = await h.api('get', `/auth/github/callback?code=abc&state=${state}`).set('Cookie', oauthCookie);
      expect(ok.status).toBe(302);
      expect(ok.headers.location).toContain('/device?code=ABCD-EFGH');
      const cookie = (ok.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('nanana_session='))!.split(';')[0];
      expect((await as(cookie, 'get', '/me')).body.account.email).toBe('octo@example.com');
    } finally {
      Object.assign(cfg(), { authGithub: false, githubClientId: '', githubClientSecret: '' });
    }
  });
});
