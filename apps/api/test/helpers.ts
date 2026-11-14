import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import request from 'supertest';
import http from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/nanana_test';
process.env.BASE_DOMAIN = 'localhost';
process.env.RUN_JOBS = 'false';
process.env.PORT = '0';
process.env.TUNNEL_TIMEOUT_MS = '600';

export interface Harness {
  app: NestExpressApplication;
  ds: DataSource;
  http: ReturnType<typeof request>;
  api: (method: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string, token?: string) => request.Test;
  ingress: (slug: string, method?: string, path?: string) => request.Test;
  create: (token?: string, body?: object) => Promise<{ slug: string; token: string; id?: string }>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
  listen: () => Promise<number>;
}

export async function harness(): Promise<Harness> {
  const { createApp } = await import('../src/bootstrap.js');
  const app = await createApp();
  const ds = app.get(DataSource);
  const agent = request(app.getHttpServer());
  const api: Harness['api'] = (method, path, token) => {
    const r = agent[method](path).set('Host', 'api.localhost');
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const ingress: Harness['ingress'] = (slug, method = 'post', path = '/hook') =>
    (agent as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()](path).set('Host', `${slug}.localhost`);
  return {
    app,
    ds,
    http: agent,
    api,
    ingress,
    async create(token, body) {
      const r = await api('post', '/subdomains', token).send(body ?? {});
      if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
      return { slug: r.body.subdomain.slug, token: r.body.token };
    },
    async reset() {
      await ds.query('TRUNCATE subdomain, slug_tombstone CASCADE');
      for (const t of ['account', 'identity', 'session', 'cli_token', 'device_auth', 'magic_link']) {
        await ds.query(`DO $$ BEGIN IF to_regclass('${t}') IS NOT NULL THEN EXECUTE 'TRUNCATE ${t} CASCADE'; END IF; END $$`);
      }
    },
    async close() {
      (app.getHttpServer() as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await app.close();
    },
    async listen() {
      await app.listen(0);
      return (app.getHttpServer().address() as { port: number }).port;
    },
  };
}

/** Opens an SSE stream with explicit headers; returns collected frames. */
export function openSse(port: number, path: string, headers: Record<string, string>) {
  const frames: { event: string; data: unknown }[] = [];
  let buf = '';
  const waiters: (() => void)[] = [];
  const req = http.request({ host: '127.0.0.1', port, path, headers: { Host: 'api.localhost', ...headers } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
        waiters.splice(0).forEach((w) => w());
      }
    });
  });
  req.end();
  const waitFor = async (event: string, timeoutMs = 5000) => {
    const start = Date.now();
    for (;;) {
      const f = frames.find((x) => x.event === event);
      if (f) return f.data;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${event}; got ${frames.map((x) => x.event).join(',')}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  return { frames, waitFor, close: () => req.destroy() };
}

import WebSocket from 'ws';

export type CliHandler = (req: { id: string; method: string; path: string; headers: Record<string, string | string[]>; body: Buffer; replay: boolean }) =>
  | { status: number; headers?: Record<string, string | string[]>; body?: Buffer | string }
  | { err: string }
  | 'hang';

/** Minimal fake `nanana` CLI speaking the tunnel protocol from docs/API.md. */
export async function fakeCli(port: number, slug: string, token: string, handler: CliHandler) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel?sub=${slug}`, {
    headers: { Host: 'api.localhost', Authorization: `Bearer ${token}`, 'X-Nanana-Protocol': '1' },
  });
  const messages: Record<string, unknown>[] = [];
  const bodies = new Map<string, { meta: Record<string, unknown>; chunks: Buffer[]; got: number }>();
  const toBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
  const fromBytes = (b: Buffer) => {
    const h = b.subarray(0, 16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const answer = (id: string, meta: Record<string, unknown>, body: Buffer) => {
    const r = handler({ id, method: String(meta.method), path: String(meta.path), headers: meta.headers as Record<string, string>, body, replay: !!meta.replay });
    if (r === 'hang') return;
    if ('err' in r) return ws.send(JSON.stringify({ t: 'err', id, code: r.err, msg: r.err }));
    const b = Buffer.from(r.body ?? '');
    ws.send(JSON.stringify({ t: 'res', id, status: r.status, headers: r.headers ?? {}, bodyLen: b.length }));
    for (let o = 0; o < b.length; o += 65536) ws.send(Buffer.concat([toBytes(id), b.subarray(o, o + 65536)]), { binary: true });
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = data as Buffer;
      const id = fromBytes(buf);
      const e = bodies.get(id);
      if (!e) return;
      e.chunks.push(buf.subarray(16));
      e.got += buf.length - 16;
      if (e.got >= Number(e.meta.bodyLen)) {
        bodies.delete(id);
        answer(id, e.meta, Buffer.concat(e.chunks));
      }
      return;
    }
    const m = JSON.parse(data.toString());
    messages.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
    if (m.t === 'req') {
      if (m.bodyLen === 0) answer(m.id, m, Buffer.alloc(0));
      else bodies.set(m.id, { meta: m, chunks: [], got: 0 });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_r, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
  });
  const waitMsg = async (t: string, timeoutMs = 3000) => {
    const start = Date.now();
    for (;;) {
      const f = messages.find((x) => x.t === t);
      if (f) return f;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${t}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { ws, messages, waitMsg, close: () => ws.close() };
}

export async function tryConnect(port: number, slug: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel?sub=${slug}`, { headers: { Host: 'api.localhost', 'X-Nanana-Protocol': '1', ...headers } });
    ws.once('open', () => {
      ws.close();
      resolve(101);
    });
    ws.once('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0));
    ws.once('error', () => resolve(0));
  });
}
