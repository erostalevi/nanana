import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 } from 'uuid';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { LoadService } from '../src/common/load.service.js';
import { EventsService } from '../src/events/events.service.js';
import { IngressService } from '../src/ingress/ingress.service.js';
import { MocksService } from '../src/mocks/mocks.service.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
let cfg: AppConfig;
const origInterval = () => 60_000;
beforeAll(async () => {
  h = await harness();
  cfg = h.app.get<AppConfig>(APP_CONFIG);
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());
afterEach(() => {
  cfg.retentionIntervalMs = origInterval();
  vi.restoreAllMocks();
});

const subId = async (slug: string): Promise<string> => (await h.ds.query('SELECT id FROM subdomain WHERE slug=$1', [slug]))[0].id;
const count = async (id: string): Promise<number> => Number((await h.ds.query('SELECT count(*) AS n FROM captured_request WHERE subdomain_id=$1', [id]))[0].n);
async function fill(id: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++)
    await h.ds.query(`INSERT INTO captured_request (id, subdomain_id, method, path, headers, body, body_size, source_ip) VALUES ($1,$2,'GET',$3,'{}',''::bytea,0,'1.1.1.1')`, [v7(), id, `/${i}`]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('retention throttle', () => {
  it('does not enforce the cap until the interval, the insert valve or a big body', async () => {
    cfg.retentionIntervalMs = 60_000;
    const { slug } = await h.create();
    const id = await subId(slug);
    await h.ingress(slug).send('warm'); // first request runs retention and starts the interval
    await sleep(100);
    await fill(id, 130);
    await h.ingress(slug).send('x');
    await sleep(150);
    expect(await count(id)).toBe(132);

    // insert valve: the plan's retentionMaxRequests inserts since the last run
    const st = (h.app.get(IngressService) as unknown as { retention: Map<string, { lastRun: number; insertsSince: number }> }).retention.get(id)!;
    st.insertsSince = 99;
    await h.ingress(slug).send('y');
    await sleep(300);
    expect(await count(id)).toBe(100);

    // big-body valve
    await fill(id, 30);
    expect(await count(id)).toBe(130);
    await h.ingress(slug).set('content-type', 'application/octet-stream').send(Buffer.alloc(300 * 1024, 1));
    await sleep(300);
    expect(await count(id)).toBe(100);

    // interval elapsed
    await fill(id, 30);
    st.lastRun = Date.now() - 61_000;
    await h.ingress(slug).send('z');
    await sleep(300);
    expect(await count(id)).toBe(100);
  });

  it('with interval 0 enforces on every request, before the response returns', async () => {
    cfg.retentionIntervalMs = 0;
    const { slug } = await h.create();
    const id = await subId(slug);
    await fill(id, 120);
    await h.ingress(slug).send('x');
    expect(await count(id)).toBe(100);
  });
});

describe('single write and events', () => {
  it('stores a complete row in one INSERT for offline, mock and preflight answers', async () => {
    cfg.retentionIntervalMs = 0;
    const { slug, token } = await h.create();
    await h.ingress(slug).send('offline body');
    await h.api('post', `/subdomains/${slug}/mock`, token).send({ status: 418, body: '{"tea":1}', headers: { 'x-m': '1' }, times: 1 });
    const m = await h.ingress(slug).send('mocked');
    expect(m.status).toBe(418);
    expect(m.headers['x-m']).toBe('1');
    expect(m.headers['content-type']).toContain('application/json');
    await h.ingress(slug, 'options', '/hook').set('Access-Control-Request-Method', 'POST');
    const rows = await h.ds.query('SELECT * FROM captured_request ORDER BY id');
    expect(rows.map((r: { answered_by: string }) => r.answered_by)).toEqual(['offline', 'mock', 'preflight']);
    for (const r of rows) {
      expect(r.response_status).not.toBeNull();
      expect(r.response_headers).toBeTruthy();
      expect(r.response_body).not.toBeNull();
      expect(r.latency_ms).not.toBeNull();
      expect(r.forward_error).toBeNull();
    }
    expect(rows[1]).toMatchObject({ mocked: true, response_status: 418 });
    expect(rows[1].response_body.toString()).toBe('{"tea":1}');
    expect(rows[2]).toMatchObject({ response_status: 204, is_preflight: true });
    expect(rows[0].response_headers['x-content-type-options']).toBe('nosniff');
  });

  it('emits dashboard events only while someone listens, with the same summary as the list endpoint', async () => {
    const { slug, token } = await h.create();
    const events = h.app.get(EventsService);
    const spy = vi.spyOn(events, 'emit');
    await h.ingress(slug).send('nobody listens');
    expect(spy.mock.calls.filter((c) => String(c[1]).startsWith('request.'))).toHaveLength(0);

    const got: { event: string; data: unknown }[] = [];
    const sub = events.stream(slug).subscribe((e) => got.push({ event: (e as { type?: string; event?: string }).type ?? (e as { event: string }).event, data: (e as { data: unknown }).data }));
    await h.ingress(slug).send('somebody listens');
    sub.unsubscribe();
    const names = got.map((g) => g.event).filter((n) => String(n).startsWith('request.'));
    expect(names).toEqual(['request.created', 'request.updated']);
    const listed = (await h.api('get', `/subdomains/${slug}/requests`, token)).body.requests as { id: string }[];
    const updated = got.find((g) => g.event === 'request.updated')!.data as Record<string, unknown>;
    const fromList = listed.find((r) => r.id === updated.id) as Record<string, unknown>;
    expect(fromList).toBeTruthy();
    expect({ ...updated, receivedAt: 0 }).toEqual({ ...fromList, receivedAt: 0 });
    expect(updated.receivedAt).toBe(fromList.receivedAt);
  });
});

describe('mock negative cache', () => {
  it('skips the UPDATE when there is no mock and notices a mock set afterwards', async () => {
    const { slug, token } = await h.create();
    const mocks = h.app.get(MocksService);
    const consume = vi.spyOn(h.ds, 'query');
    await h.ingress(slug).send('1');
    await h.ingress(slug).send('2');
    const updates = consume.mock.calls.filter((c) => String(c[0]).includes('UPDATE mock_rule'));
    expect(updates).toHaveLength(1);
    await h.api('post', `/subdomains/${slug}/mock`, token).send({ status: 503, times: 1 });
    expect((await h.ingress(slug).send('3')).status).toBe(503);
    expect((await h.ingress(slug).send('4')).status).toBe(200);
    // clear() also resets the cache entry
    await h.api('post', `/subdomains/${slug}/mock`, token).send({ status: 500, times: 5 });
    await h.api('delete', `/subdomains/${slug}/mock`, token);
    expect((await h.ingress(slug).send('5')).status).toBe(200);
    expect(mocks).toBeTruthy();
  });
});

describe('endpoint cache and foreign keys', () => {
  it('answers 404 when the endpoint was deleted behind the cache, then keeps answering 404', async () => {
    const { slug } = await h.create();
    expect((await h.ingress(slug).send('ok')).status).toBe(200); // primes the cache
    await h.ds.query('DELETE FROM subdomain WHERE slug=$1', [slug]); // behind the service's back
    const r = await h.ingress(slug).send('gone');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
    expect((await h.ingress(slug).send('again')).status).toBe(404);
  });
});

describe('load shedding', () => {
  it('answers 503 with retry-after before reading or storing anything, but not for unknown endpoints', async () => {
    const { slug } = await h.create();
    const load = h.app.get(LoadService);
    vi.spyOn(load, 'shouldShed').mockReturnValue({ shed: true, retryAfterSec: 7 });
    const r = await h.ingress(slug).send('x');
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBe('7');
    expect(r.body).toEqual({ error: 'overloaded', message: 'The service is busy, retry shortly.' });
    expect(Number((await h.ds.query('SELECT count(*) AS n FROM captured_request'))[0].n)).toBe(0);
    expect((await h.ingress('nosuchslug').send('x')).status).toBe(404);
  });

  it('sheds when the request budget is exhausted before the insert', async () => {
    const { slug } = await h.create();
    const budget = cfg.requestBudgetMs;
    cfg.requestBudgetMs = -1;
    try {
      expect((await h.ingress(slug).send('x')).status).toBe(503);
    } finally {
      cfg.requestBudgetMs = budget;
    }
    expect(Number((await h.ds.query('SELECT count(*) AS n FROM captured_request'))[0].n)).toBe(0);
  });

  it('turns a pool connect timeout into 503 and reports insert timings to LoadService', async () => {
    const { slug } = await h.create();
    const load = h.app.get(LoadService);
    const observe = vi.spyOn(load, 'observeDb');
    await h.ingress(slug).send('x');
    expect(observe).toHaveBeenCalledTimes(1);
    const pool = (h.app.get(IngressService) as unknown as { pool: { query: (...a: unknown[]) => unknown } }).pool;
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    expect((await h.ingress(slug).send('y')).status).toBe(503);
  });
});
