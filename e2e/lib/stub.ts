import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubHit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** Tiny HTTP server standing in for the developer's app (replay-by-URL target). */
export class Stub {
  hits: StubHit[] = [];
  status = 201;
  responseBody = '{"stub":"received"}';
  private server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      this.hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(this.status, { 'content-type': 'application/json', 'x-stub': 'yes' });
      res.end(this.responseBody);
    });
  });

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return this;
  }
  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
