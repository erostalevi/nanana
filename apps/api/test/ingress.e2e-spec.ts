import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IngressService } from '../src/ingress/ingress.service.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
import { harness, openSse, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe('subdomain creation', () => {
  it('creates an anonymous subdomain with a token', async () => {
    const r = await h.api('post', '/subdomains').send({});
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^nnt_[0-9A-Za-z]{32}$/);
    expect(r.body.subdomain.slug).toMatch(/^[a-z0-9]{8}$/);
    expect(r.body.subdomain.state).toBe('active');
    expect(r.body.subdomain.offlineStatus).toBe(200);
    expect(r.body.dashboardUrlWithToken).toContain('/#t=' + r.body.token);
  });

  it('rejects custom names for anonymous users', async () => {
    const r = await h.api('post', '/subdomains').send({ name: 'mything' });
    expect(r.status).toBe(403);
  });

  it('limits anonymous creation to 3 per IP per day', async () => {
    for (let i = 0; i < 3; i++) await h.create();
    const r = await h.api('post', '/subdomains').send({});
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
  });
});

describe('ingress capture', () => {
  it('stores raw bytes exactly and returns the default response', async () => {
    const { slug, token } = await h.create();
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x20, 0x31, 0x7d, 0x0d, 0x0a]);
    const r = await h.ingress(slug, 'post', '/pay/callback?x=1&y=a%20b').set('Content-Type', 'application/octet-stream').set('X-Custom', 'one').send(raw);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);
    const sum = list.body.requests[0];
    expect(sum.method).toBe('POST');
    expect(sum.path).toBe('/pay/callback?x=1&y=a%20b');
    expect(sum.bodySize).toBe(raw.length);
    expect(sum.answeredBy).toBe('offline');
    expect(sum.responseStatus).toBe(200);

    const detail = await h.api('get', `/requests/${sum.id}`, token);
    expect(detail.status).toBe(200);
    expect(detail.body.body.encoding).toBe('base64');
    expect(Buffer.from(detail.body.body.data, 'base64').equals(raw)).toBe(true);
    expect(detail.body.headers['x-custom']).toBe('one');
    expect(detail.body.responseBody.data).toBe('{"ok":true}');
  });

  it('keeps utf8 JSON bodies readable', async () => {
    const { slug, token } = await h.create();
    await h.ingress(slug).set('Content-Type', 'application/json').send('{"monto": 1000, "glosa": "pago ñandú"}');
    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests[0].bodyPreview).toContain('ñandú');
    const d = await h.api('get', `/requests/${list.body.requests[0].id}`, token);
    expect(d.body.body.encoding).toBe('utf8');
  });

  it('captures GET and other methods on any path', async () => {
    const { slug, token } = await h.create();
    await h.ingress(slug, 'get', '/a/b/c?q=1');
    await h.ingress(slug, 'put', '/x').send('hi');
    await h.ingress(slug, 'delete', '/y');
    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests.map((r: { method: string }) => r.method)).toEqual(['DELETE', 'PUT', 'GET']);
  });

  it('applies the configurable offline response', async () => {
    const { slug, token } = await h.create();
    const p = await h.api('patch', `/subdomains/${slug}`, token).send({ offlineStatus: 503, offlineBody: '{"retry":true}' });
    expect(p.status).toBe(200);
    expect(p.body.offlineStatus).toBe(503);
    const r = await h.ingress(slug).send('x');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ retry: true });
    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests).toHaveLength(1);
  });

  it('answers CORS preflights and hides them by default', async () => {
    const { slug, token } = await h.create();
    const r = await h.ingress(slug, 'options', '/hook').set('Origin', 'http://app.test').set('Access-Control-Request-Method', 'POST');
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const hidden = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(hidden.body.requests).toHaveLength(0);
    const shown = await h.api('get', `/subdomains/${slug}/requests?includePreflight=true`, token);
    expect(shown.body.requests).toHaveLength(1);
    expect(shown.body.requests[0].isPreflight).toBe(true);
  });

  it('rejects oversize bodies for anonymous subdomains', async () => {
    const { slug } = await h.create();
    const r = await h.ingress(slug).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(1024 * 1024 + 1, 1));
    expect(r.status).toBe(413);
  });

  it('returns 404 for unknown and 410 for tombstoned names', async () => {
    expect((await h.ingress('nope1234')).status).toBe(404);
    await h.ds.query(`INSERT INTO slug_tombstone (slug, owner_id, until) VALUES ('gone-name', NULL, now() + interval '1 day')`);
    expect((await h.ingress('gone-name')).status).toBe(410);
  });

  it('rate limits per subdomain', async () => {
    const { slug } = await h.create();
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await h.ingress(slug, 'get', '/r');
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('authorization', () => {
  it('requires the right token', async () => {
    const a = await h.create();
    const b = await h.create();
    expect((await h.api('get', `/subdomains/${a.slug}/requests`)).status).toBe(401);
    expect((await h.api('get', `/subdomains/${a.slug}/requests`, b.token)).status).toBe(403);
    expect((await h.api('get', `/subdomains/${a.slug}`, a.token)).status).toBe(200);
    const self = await h.api('get', '/subdomains/_self', a.token);
    expect(self.body.slug).toBe(a.slug);
  });

  it('deletes a subdomain and its data', async () => {
    const { slug, token } = await h.create();
    await h.ingress(slug).send('x');
    expect((await h.api('delete', `/subdomains/${slug}`, token)).status).toBe(204);
    expect((await h.ingress(slug)).status).toBe(404);
    const [{ n }] = await h.ds.query('SELECT count(*) AS n FROM captured_request');
    expect(Number(n)).toBe(0);
  });

  it('serves request detail only to the owner of that capture', async () => {
    const a = await h.create();
    const b = await h.create();
    await h.ingress(a.slug).send('secret');
    const list = await h.api('get', `/subdomains/${a.slug}/requests`, a.token);
    const id = list.body.requests[0].id;
    expect((await h.api('get', `/requests/${id}`, b.token)).status).toBe(403);
    expect((await h.api('get', `/requests/${id}`, a.token)).status).toBe(200);
    expect((await h.api('delete', `/requests/${id}`, a.token)).status).toBe(204);
  });
});

describe('retention', () => {
  it('keeps only the newest 100 requests', async () => {
    const { slug, token } = await h.create();
    const row = (await h.ds.query('SELECT id FROM subdomain WHERE slug=$1', [slug]))[0];
    const { v7 } = await import('uuid');
    for (let i = 0; i < 105; i++) {
      await h.ds.query(
        `INSERT INTO captured_request (id, subdomain_id, method, path, headers, body, body_size, source_ip)
         VALUES ($1, $2, 'GET', $3, '{}', ''::bytea, 0, '1.1.1.1')`,
        [v7(), row.id, `/${i}`],
      );
    }
    await h.app.get(IngressService).enforceRetention({ id: row.id, slug });
    const list = await h.api('get', `/subdomains/${slug}/requests?limit=100`, token);
    expect(list.body.requests).toHaveLength(100);
    expect(list.body.requests[0].path).toBe('/104');
    expect(list.body.requests[99].path).toBe('/5');
  });

  it('paginates with before cursor', async () => {
    const { slug, token } = await h.create();
    for (let i = 0; i < 5; i++) await h.ingress(slug, 'get', `/p${i}`);
    const p1 = await h.api('get', `/subdomains/${slug}/requests?limit=2`, token);
    expect(p1.body.requests.map((r: { path: string }) => r.path)).toEqual(['/p4', '/p3']);
    const p2 = await h.api('get', `/subdomains/${slug}/requests?limit=2&before=${p1.body.nextBefore}`, token);
    expect(p2.body.requests.map((r: { path: string }) => r.path)).toEqual(['/p2', '/p1']);
  });
});

describe('mocking', () => {
  it('fails the next N calls then returns to normal', async () => {
    const { slug, token } = await h.create();
    const m = await h.api('post', `/subdomains/${slug}/mock`, token).send({ status: 500, body: '{"err":1}', times: 2 });
    expect(m.body).toEqual({ status: 500, remaining: 2 });
    expect((await h.ingress(slug)).status).toBe(500);
    expect((await h.ingress(slug)).status).toBe(500);
    expect((await h.ingress(slug)).status).toBe(200);
    const sub = await h.api('get', `/subdomains/${slug}`, token);
    expect(sub.body.mock).toBeNull();
    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests.filter((r: { mocked: boolean }) => r.mocked)).toHaveLength(2);
  });
});

describe('hmac', () => {
  it('verifies plain, prefixed and stripe-style signatures', async () => {
    const { slug, token } = await h.create();
    await h.api('patch', `/subdomains/${slug}`, token).send({ hmacSecret: 's3cr3t', hmacHeader: 'x-signature' });
    const body = '{"a":1}';
    const hex = createHmac('sha256', 's3cr3t').update(body).digest('hex');
    await h.ingress(slug).set('x-signature', hex).send(body);
    await h.ingress(slug).set('x-signature', `sha256=${hex}`).send(body);
    await h.ingress(slug).set('x-signature', 'deadbeef').send(body);
    await h.ingress(slug).send(body);
    const t = '1700000000';
    const stripe = createHmac('sha256', 's3cr3t').update(`${t}.${body}`).digest('hex');
    await h.ingress(slug).set('x-signature', `t=${t},v1=${stripe}`).send(body);
    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests.map((r: { signature: string }) => r.signature)).toEqual(['pass', 'header_missing', 'fail', 'pass', 'pass']);
    const sub = await h.api('get', `/subdomains/${slug}`, token);
    expect(sub.body.hmac).toEqual({ header: 'x-signature', algo: 'sha256', configured: true });
    expect(JSON.stringify(sub.body)).not.toContain('s3cr3t');
  });
});

describe('lifecycle', () => {
  it('goes cold after 1h idle, revives on activity, dies after 24h idle', async () => {
    const lc = h.app.get(LifecycleService);
    const { slug, token } = await h.create();
    await h.ds.query(`UPDATE subdomain SET last_activity_at = now() - interval '2 hours' WHERE slug=$1`, [slug]);
    expect((await lc.run()).cold).toBe(1);
    expect((await h.api('get', `/subdomains/${slug}`, token)).body.state).toBe('cold');
    const r = await h.ingress(slug).send('still works');
    expect(r.status).toBe(200);
    expect((await h.api('get', `/subdomains/${slug}`, token)).body.state).toBe('active');

    await h.ds.query(`UPDATE subdomain SET last_activity_at = now() - interval '25 hours' WHERE slug=$1`, [slug]);
    expect((await lc.run()).dead).toBe(1);
    expect((await h.ingress(slug)).status).toBe(404);
  });

  it('hard-expires after 7 days regardless of activity', async () => {
    const lc = h.app.get(LifecycleService);
    const { slug } = await h.create();
    await h.ds.query(`UPDATE subdomain SET hard_expires_at = now() - interval '1 minute' WHERE slug=$1`, [slug]);
    expect((await lc.run()).dead).toBe(1);
  });

  it('deletes captured requests older than 1 hour', async () => {
    const lc = h.app.get(LifecycleService);
    const { slug, token } = await h.create();
    await h.ingress(slug).send('x');
    await h.ds.query(`UPDATE captured_request SET received_at = now() - interval '2 hours'`);
    await lc.run();
    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests).toHaveLength(0);
  });
});

describe('live stream', () => {
  it('pushes request events over SSE', async () => {
    const port = await h.listen();
    const { slug, token } = await h.create();
    const sse = openSse(port, `/subdomains/${slug}/stream`, { Authorization: `Bearer ${token}` });
    const hello = (await sse.waitFor('hello')) as { slug: string };
    expect(hello.slug).toBe(slug);
    await h.ingress(slug).send('live!');
    const created = (await sse.waitFor('request.created')) as { method: string; path: string };
    expect(created.method).toBe('POST');
    await sse.waitFor('request.updated');
    sse.close();
  });
});
