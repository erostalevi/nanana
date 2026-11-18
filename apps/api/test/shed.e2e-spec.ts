import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetricsService } from '../src/admin/metrics.service.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { MailService } from '../src/auth/mail.service.js';
import { LoadService } from '../src/common/load.service.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
let cfg: AppConfig;
let load: LoadService;
beforeAll(async () => {
  h = await harness();
  cfg = h.app.get<AppConfig>(APP_CONFIG);
  load = h.app.get(LoadService);
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.reset();
  (h.app.get(AuthController) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter();
});
afterEach(() => {
  load.setScoreForTest(null);
  cfg.shedEnabled = true;
});

async function proEndpoint(): Promise<string> {
  const mail = h.app.get(MailService);
  mail.outbox.length = 0;
  await h.api('post', '/auth/magic').send({ email: 'pro-shed@example.com' });
  const token = /token=(nnm_\w+)/.exec(mail.outbox[0].text)![1];
  const r = await h.api('post', '/auth/magic/verify').send({ token });
  const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('nanana_session='))!.split(';')[0];
  await h.ds.query(`UPDATE account SET plan = 'pro' WHERE email = 'pro-shed@example.com'`);
  const created = await h.api('post', '/subdomains').set('Cookie', cookie).send({});
  return created.body.subdomain.slug as string;
}

describe('load shedding end to end (real LoadService)', () => {
  it('serves normally when healthy', async () => {
    const { slug } = await h.create();
    expect((await h.ingress(slug).send('ok')).status).toBe(200);
  });

  it('refuses free and anonymous webhooks with 503 + Retry-After when saturated, and counts them as shed', async () => {
    const { slug } = await h.create();
    load.setScoreForTest(1);
    const before = h.app.get(MetricsService).series().reduce((a, m) => a + m.shed, 0);
    const r = await h.ingress(slug).send('x');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('overloaded');
    const retry = Number(r.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(6);
    expect(h.app.get(MetricsService).series().reduce((a, m) => a + m.shed, 0)).toBe(before + 1);
    const [{ n }] = await h.ds.query('SELECT count(*) AS n FROM captured_request');
    expect(Number(n)).toBe(0); // nothing was written
    load.setScoreForTest(0);
    expect((await h.ingress(slug).send('x')).status).toBe(200); // recovers the moment the score drops
  });

  it('protects Pro endpoints until the score passes 0.5', async () => {
    const pro = await proEndpoint();
    const free = (await h.create()).slug;
    load.setScoreForTest(0.5);
    for (let i = 0; i < 25; i++) expect((await h.ingress(pro).send('p')).status).toBe(200);
    let shedFree = 0;
    for (let i = 0; i < 60; i++) if ((await h.ingress(free).send('f')).status === 503) shedFree++;
    expect(shedFree).toBeGreaterThan(10); // about half of 60
    expect(shedFree).toBeLessThan(55);
    load.setScoreForTest(1);
    expect((await h.ingress(pro).send('p')).status).toBe(503); // full saturation sheds everyone
  });

  it('never sheds unknown endpoints (404) and can be switched off', async () => {
    const { slug } = await h.create();
    load.setScoreForTest(1);
    expect((await h.ingress('nosuchendpoint').send('x')).status).toBe(404);
    cfg.shedEnabled = false;
    expect((await h.ingress(slug).send('x')).status).toBe(200);
  });
});
