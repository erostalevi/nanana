import WebSocket from 'ws';
import { API_PORT } from './env';

export type TunnelReq = { id: string; method: string; path: string; headers: Record<string, string | string[]>; replay: boolean; body: Buffer };

const uuidToBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
const bytesToUuid = (b: Buffer) => {
  const h = b.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * A fake `nanana` CLI speaking docs/API.md's tunnel protocol: JSON text frames plus binary frames whose
 * first 16 bytes are the request id (raw UUID bytes).
 */
export class FakeTunnel {
  received: TunnelReq[] = [];
  hello: Record<string, unknown> | null = null;
  bye: string | null = null;
  /** What the "local app" answers. */
  respond: (r: TunnelReq) => { status: number; headers?: Record<string, string>; body?: string } = () => ({ status: 202, headers: { 'content-type': 'application/json', 'x-from': 'fake-tunnel' }, body: '{"tunnel":"ok"}' });
  private ws!: WebSocket;
  private pending = new Map<string, { meta: Omit<TunnelReq, 'body'>; bodyLen: number; chunks: Buffer[]; got: number }>();

  constructor(private slug: string, private token: string) {}

  async connect(): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/tunnel?sub=${this.slug}`, {
      headers: { authorization: `Bearer ${this.token}`, 'x-nanana-protocol': '1', 'x-nanana-client': 'nanana-e2e/0.0.0', host: `api.localhost:${API_PORT}` },
    });
    this.ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`tunnel rejected: HTTP ${res.statusCode}`)));
      this.ws.once('error', reject);
    });
    const end = Date.now() + 5000;
    while (!this.hello && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    if (!this.hello) throw new Error('no hello frame from server');
    return this;
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const id = bytesToUuid(data);
      const p = this.pending.get(id);
      if (!p) return;
      p.chunks.push(data.subarray(16));
      p.got += data.length - 16;
      if (p.got >= p.bodyLen) this.finish(id);
      return;
    }
    const m = JSON.parse(data.toString()) as { t: string } & Record<string, any>;
    if (m.t === 'hello') this.hello = m;
    else if (m.t === 'ping') this.ws.send(JSON.stringify({ t: 'pong' }));
    else if (m.t === 'bye') this.bye = m.reason;
    else if (m.t === 'req') {
      this.pending.set(m.id, { meta: { id: m.id, method: m.method, path: m.path, headers: m.headers, replay: !!m.replay }, bodyLen: m.bodyLen, chunks: [], got: 0 });
      if (m.bodyLen === 0) this.finish(m.id);
    }
  }

  private finish(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const req: TunnelReq = { ...p.meta, body: Buffer.concat(p.chunks) };
    this.received.push(req);
    const out = this.respond(req);
    const body = Buffer.from(out.body ?? '');
    this.ws.send(JSON.stringify({ t: 'res', id, status: out.status, headers: out.headers ?? {}, bodyLen: body.length }));
    if (body.length) this.ws.send(Buffer.concat([uuidToBytes(id), body]), { binary: true });
  }

  async close(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
      setTimeout(() => (this.ws.terminate(), resolve()), 2000);
    });
  }
}
