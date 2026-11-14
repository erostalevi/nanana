import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import request from 'supertest';
import http from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/nanana_test';
process.env.BASE_DOMAIN = 'localhost';
process.env.RUN_JOBS = 'false';
process.env.PORT = '0';

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
