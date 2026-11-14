import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeCli, harness, openSse, tryConnect, type Harness } from './helpers.js';

let h: Harness;
let port: number;
beforeAll(async () => {
  h = await harness();
  port = await h.listen();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe('tunnel', () => {
  it('rejects bad auth, wrong sub and old protocol', async () => {
    const a = await h.create();
    const b = await h.create();
    expect(await tryConnect(port, a.slug, {})).toBe(401);
    expect(await tryConnect(port, a.slug, { Authorization: 'Bearer nnt_nope' })).toBe(401);
    expect(await tryConnect(port, a.slug, { Authorization: `Bearer ${b.token}` })).toBe(403);
    expect(await tryConnect(port, 'zzzzzzzz', { Authorization: `Bearer ${a.token}` })).toBe(404);
    expect(await tryConnect(port, a.slug, { Authorization: `Bearer ${a.token}`, 'X-Nanana-Protocol': '0' })).toBe(426);
    expect(await tryConnect(port, a.slug, { Authorization: `Bearer ${a.token}` })).toBe(101);
  });

  it('proxies the sender request to the CLI and returns the local response', async () => {
    const { slug, token } = await h.create();
    const seen: unknown[] = [];
    const cli = await fakeCli(port, slug, token, (req) => {
      seen.push(req);
      return { status: 201, headers: { 'x-local': 'yes', 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] }, body: JSON.stringify({ got: req.body.toString() }) };
    });
    const hello = (await cli.waitMsg('hello')) as { sub: string; protocol: number };
    expect(hello.sub).toBe(slug);
    expect(hello.protocol).toBe(1);
    expect((await h.api('get', `/subdomains/${slug}`, token)).body.tunnelOnline).toBe(true);

    const r = await h.ingress(slug, 'post', '/pay?a=1').set('X-Trace', 't1').send('{"hello":"world"}');
    expect(r.status).toBe(201);
    expect(r.headers['x-local']).toBe('yes');
    expect(r.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(r.body).toEqual({ got: '{"hello":"world"}' });
    const req = seen[0] as { method: string; path: string; headers: Record<string, string>; replay: boolean };
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/pay?a=1');
    expect(req.headers['x-trace']).toBe('t1');
    expect(req.headers['x-forwarded-for']).toBeTruthy();
    expect(req.headers['host']).toBeUndefined();
    expect(req.replay).toBe(false);

    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests[0].answeredBy).toBe('tunnel');
    expect(list.body.requests[0].responseStatus).toBe(201);
    cli.close();
  });

  it('relays large bodies in chunks both ways', async () => {
    const { slug, token } = await h.create();
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const cli = await fakeCli(port, slug, token, (req) => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.concat([req.body, big.subarray(0, 100)]) }));
    await cli.waitMsg('hello');
    const r = await h.ingress(slug).set('Content-Type', 'application/octet-stream').send(big);
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body).length).toBe(big.length + 100);
    expect(Buffer.from(r.body).subarray(0, big.length).equals(big)).toBe(true);
    cli.close();
  });

  it('falls back to the offline response when the local app errors or hangs', async () => {
    const { slug, token } = await h.create();
    await h.api('patch', `/subdomains/${slug}`, token).send({ offlineStatus: 502, offlineBody: 'down' });
    let mode: 'err' | 'hang' = 'err';
    const cli = await fakeCli(port, slug, token, () => (mode === 'err' ? { err: 'ECONNREFUSED' } : 'hang'));
    await cli.waitMsg('hello');
    const r1 = await h.ingress(slug).send('x');
    expect(r1.status).toBe(502);
    mode = 'hang';
    const r2 = await h.ingress(slug).send('y');
    expect(r2.status).toBe(502);
    const list = await h.api('get', `/subdomains/${slug}/requests`, token);
    expect(list.body.requests.map((r: { forwardError: string; answeredBy: string }) => [r.answeredBy, r.forwardError])).toEqual([
      ['offline', 'ETIMEDOUT'],
      ['offline', 'ECONNREFUSED'],
    ]);
    cli.close();
  });

  it('replaces an existing tunnel and notifies the old one', async () => {
    const { slug, token } = await h.create();
    const first = await fakeCli(port, slug, token, () => ({ status: 200, body: 'first' }));
    await first.waitMsg('hello');
    const second = await fakeCli(port, slug, token, () => ({ status: 200, body: 'second' }));
    await second.waitMsg('hello');
    expect(await first.waitMsg('bye')).toMatchObject({ reason: 'replaced' });
    const r = await h.ingress(slug).send('x');
    expect(r.text).toBe('second');
    second.close();
  });

  it('goes offline on disconnect and emits tunnel.status over SSE', async () => {
    const { slug, token } = await h.create();
    const sse = openSse(port, `/subdomains/${slug}/stream`, { Authorization: `Bearer ${token}` });
    await sse.waitFor('hello');
    const cli = await fakeCli(port, slug, token, () => ({ status: 200 }));
    await cli.waitMsg('hello');
    await sse.waitFor('tunnel.status');
    cli.close();
    await new Promise((r) => setTimeout(r, 300));
    expect((await h.api('get', `/subdomains/${slug}`, token)).body.tunnelOnline).toBe(false);
    const statuses = sse.frames.filter((f) => f.event === 'tunnel.status').map((f) => (f.data as { online: boolean }).online);
    expect(statuses).toEqual([true, false]);
    sse.close();
  });

  it('closes the tunnel with bye when the subdomain is deleted', async () => {
    const { slug, token } = await h.create();
    const cli = await fakeCli(port, slug, token, () => ({ status: 200 }));
    await cli.waitMsg('hello');
    await h.api('delete', `/subdomains/${slug}`, token);
    expect(await cli.waitMsg('bye')).toMatchObject({ reason: 'deleted' });
  });
});
