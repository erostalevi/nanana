import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { fakeCli, harness, type Harness } from './helpers.js';

let h: Harness;
let port: number;
let stub: http.Server;
let stubPort: number;
const stubSeen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  h = await harness();
  port = await h.listen();
  stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      stubSeen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json', 'x-stub': '1' }).end('{"stub":true}');
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = (stub.address() as { port: number }).port;
});
afterAll(async () => {
  stub.close();
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  stubSeen.length = 0;
  h.app.get<AppConfig>(APP_CONFIG).replayAllowPrivate = false;
});

async function captured(slug: string, token: string) {
  await h.ingress(slug, 'post', '/hook?x=1').set('Content-Type', 'application/json').set('X-Sig', 'abc').send('{"k":"v"}');
  const list = await h.api('get', `/subdomains/${slug}/requests`, token);
  return list.body.requests[0].id as string;
}

describe('replay via tunnel', () => {
  it('re-sends the captured request through the CLI and stores the result', async () => {
    const { slug, token } = await h.create();
    const id = await captured(slug, token);
    const seen: { method: string; path: string; replay: boolean; headers: Record<string, unknown>; body: Buffer }[] = [];
    const cli = await fakeCli(port, slug, token, (req) => {
      seen.push(req);
      return { status: 418, headers: { 'x-from': 'cli' }, body: 'teapot' };
    });
    await cli.waitMsg('hello');
    const r = await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'tunnel' }, overrideHeaders: { 'X-Extra': '1' } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe(418);
    expect(r.body.targetType).toBe('tunnel');
    expect(r.body.responseBody.data).toBe('teapot');
    const last = seen[seen.length - 1];
    expect(last.replay).toBe(true);
    expect(last.method).toBe('POST');
    expect(last.path).toBe('/hook?x=1');
    expect(last.body.toString()).toBe('{"k":"v"}');
    expect(last.headers['x-sig']).toBe('abc');
    expect(last.headers['x-extra']).toBe('1');
    const d = await h.api('get', `/requests/${id}`, token);
    expect(d.body.replays).toHaveLength(1);
    expect(d.body.replays[0].status).toBe(418);
    cli.close();
  });

  it('returns 409 when no tunnel is connected', async () => {
    const { slug, token } = await h.create();
    const id = await captured(slug, token);
    const r = await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'tunnel' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('tunnel_offline');
  });

  it('stores local errors as results, not failures', async () => {
    const { slug, token } = await h.create();
    const id = await captured(slug, token);
    const cli = await fakeCli(port, slug, token, () => ({ err: 'ECONNREFUSED' }));
    await cli.waitMsg('hello');
    const r = await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'tunnel' } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBeNull();
    expect(r.body.error).toContain('ECONNREFUSED');
    cli.close();
  });
});

describe('replay to a public url', () => {
  it('blocks private, loopback and metadata targets', async () => {
    const { slug, token } = await h.create();
    const id = await captured(slug, token);
    for (const url of ['http://127.0.0.1:9/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'file:///etc/passwd']) {
      const r = await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'url', url } });
      expect(r.status, url).toBe(400);
      expect(r.body.error.code).toBe('url_blocked');
    }
    expect(stubSeen).toHaveLength(0);
  });

  it('replays method, path, headers and raw body to an allowed host and does not follow redirects', async () => {
    h.app.get<AppConfig>(APP_CONFIG).replayAllowPrivate = true;
    const { slug, token } = await h.create();
    const id = await captured(slug, token);
    const r = await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'url', url: `http://127.0.0.1:${stubPort}/target/path?z=9` } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe(202);
    expect(r.body.responseBody.data).toBe('{"stub":true}');
    const s = stubSeen[0];
    expect(s.method).toBe('POST');
    expect(s.body).toBe('{"k":"v"}');
    expect(s.headers['x-sig']).toBe('abc');
    expect(s.headers['x-replayed-by']).toBe('nanana');
    expect(s.headers['x-replay-of']).toBe(id);
    // target path/query are those of the URL given, not the captured request
    expect(s.url).toBe('/target/path?z=9');

    const redir = await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'url', url: `http://127.0.0.1:${stubPort}/redirect` } });
    expect(redir.body.status).toBe(302);
  });

  it('records connection failures and validates input', async () => {
    h.app.get<AppConfig>(APP_CONFIG).replayAllowPrivate = true;
    const { slug, token } = await h.create();
    const id = await captured(slug, token);
    const r = await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'url', url: 'http://127.0.0.1:1/' } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBeNull();
    expect(r.body.error).toContain('ECONNREFUSED');
    expect((await h.api('post', `/requests/${id}/replay`, token).send({ target: { type: 'nope' } })).status).toBe(400);
    expect((await h.api('post', `/requests/${id}/replay`).send({ target: { type: 'tunnel' } })).status).toBe(401);
  });
});
