import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type WebSocket from 'ws';
import { q } from '../db/query.js';
import { EventsService } from '../events/events.service.js';
import type { HeaderMap } from '../common/http.js';

export interface ForwardRequest {
  id: string;
  method: string;
  path: string;
  headers: HeaderMap;
  body: Buffer;
  replay: boolean;
}
export interface ForwardResponse {
  status: number;
  headers: HeaderMap;
  body: Buffer;
}
export class TunnelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_INFLIGHT = 20;
const CHUNK = 64 * 1024;
const PING_MS = 20_000;
const SILENCE_MS = 60_000;

interface Pending {
  resolve: (r: ForwardResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  meta?: { status: number; headers: HeaderMap; bodyLen: number };
  chunks: Buffer[];
  received: number;
}

interface Conn {
  ws: WebSocket;
  subId: string;
  slug: string;
  ownerId: string | null;
  lastSeen: number;
  pending: Map<string, Pending>;
  ping: NodeJS.Timeout;
}

export const uuidToBytes = (id: string): Buffer => Buffer.from(id.replace(/-/g, ''), 'hex');
export const bytesToUuid = (b: Buffer): string => {
  const h = b.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

@Injectable()
export class TunnelService implements OnApplicationShutdown {
  private readonly log = new Logger('Tunnel');
  private readonly conns = new Map<string, Conn>();
  readonly timeoutMs = Number(process.env.TUNNEL_TIMEOUT_MS ?? 25_000);

  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** Tunnels currently connected (size of the in-memory map). */
  get onlineCount(): number {
    return this.conns.size;
  }

  isOnline(subId: string): boolean {
    return this.conns.has(subId);
  }

  /** Simultaneous tunnels an account currently has (optionally ignoring one subdomain that is reconnecting). */
  onlineForOwner(ownerId: string, exceptSubId?: string): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.ownerId === ownerId && c.subId !== exceptSubId) n++;
    return n;
  }

  target(_subId: string): string | null {
    return null;
  }

  /** Registers a freshly upgraded socket; replaces any existing tunnel for the subdomain. */
  register(ws: WebSocket, sub: { id: string; slug: string; owner_id?: string | null }, hello: Record<string, unknown>): void {
    const old = this.conns.get(sub.id);
    if (old) this.drop(old, 'replaced');

    const conn: Conn = {
      ws,
      subId: sub.id,
      slug: sub.slug,
      ownerId: sub.owner_id ?? null,
      lastSeen: Date.now(),
      pending: new Map(),
      ping: setInterval(() => {
        if (Date.now() - conn.lastSeen > SILENCE_MS) return this.drop(conn, undefined, true);
        this.sendJson(conn, { t: 'ping' });
        // The subdomain may have been removed out-of-band (admin CLI): drop orphaned tunnels.
        void q<unknown[]>(this.ds, 'SELECT 1 FROM subdomain WHERE id = $1', [conn.subId])
          .then((r) => {
            if (r.length === 0) this.drop(conn, 'deleted');
          })
          .catch(() => undefined);
      }, PING_MS),
    };
    conn.ping.unref();
    this.conns.set(sub.id, conn);

    ws.on('message', (data, isBinary) => {
      conn.lastSeen = Date.now();
      try {
        if (isBinary) this.onBinary(conn, data as Buffer);
        else this.onText(conn, data.toString());
      } catch (e) {
        this.log.warn(`bad frame on ${conn.slug}: ${(e as Error).message}`);
      }
    });
    ws.on('close', () => this.cleanup(conn));
    ws.on('error', () => this.cleanup(conn));

    this.sendJson(conn, hello);
    void q(this.ds, `UPDATE subdomain SET last_activity_at = now(), state = 'active' WHERE id = $1`, [sub.id]);
    this.events.emit(sub.slug, 'tunnel.status', { online: true, target: null });
  }

  forward(subId: string, req: ForwardRequest): Promise<ForwardResponse> {
    const conn = this.conns.get(subId);
    if (!conn) return Promise.reject(new TunnelError('OFFLINE', 'tunnel offline'));
    if (conn.pending.size >= MAX_INFLIGHT) return Promise.reject(new TunnelError('BUSY', 'too many in-flight requests'));
    return new Promise<ForwardResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(req.id);
        reject(new TunnelError('ETIMEDOUT', 'local app did not respond in time'));
      }, this.timeoutMs);
      conn.pending.set(req.id, { resolve, reject, timer, chunks: [], received: 0 });
      this.sendJson(conn, {
        t: 'req',
        id: req.id,
        method: req.method,
        path: req.path,
        headers: req.headers,
        bodyLen: req.body.length,
        replay: req.replay,
      });
      const id = uuidToBytes(req.id);
      for (let off = 0; off < req.body.length; off += CHUNK) {
        conn.ws.send(Buffer.concat([id, req.body.subarray(off, off + CHUNK)]), { binary: true });
      }
    });
  }

  /** Closes the tunnel of a subdomain (deleted, expired, token rotated...). */
  close(subId: string, reason: string): void {
    const conn = this.conns.get(subId);
    if (conn) this.drop(conn, reason);
  }

  onApplicationShutdown(): void {
    for (const c of [...this.conns.values()]) this.drop(c, 'server_shutdown');
  }

  private sendJson(conn: Conn, msg: Record<string, unknown>): void {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
  }

  private onText(conn: Conn, text: string): void {
    const m = JSON.parse(text) as { t: string; id?: string; status?: number; headers?: HeaderMap; bodyLen?: number; code?: string; msg?: string };
    if (m.t === 'ping') return this.sendJson(conn, { t: 'pong' });
    if (m.t === 'pong') return;
    const p = m.id ? conn.pending.get(m.id) : undefined;
    if (!p || !m.id) return;
    if (m.t === 'err') {
      this.settle(conn, m.id, p, undefined, new TunnelError(m.code ?? 'EOTHER', m.msg ?? 'local error'));
    } else if (m.t === 'res') {
      p.meta = { status: Number(m.status), headers: m.headers ?? {}, bodyLen: Number(m.bodyLen ?? 0) };
      if (p.meta.bodyLen === 0) this.settle(conn, m.id, p, { status: p.meta.status, headers: p.meta.headers, body: Buffer.alloc(0) });
    }
  }

  private onBinary(conn: Conn, data: Buffer): void {
    if (data.length < 16) return;
    const id = bytesToUuid(data);
    const p = conn.pending.get(id);
    if (!p?.meta) return;
    const chunk = data.subarray(16);
    p.chunks.push(chunk);
    p.received += chunk.length;
    if (p.received >= p.meta.bodyLen) {
      this.settle(conn, id, p, { status: p.meta.status, headers: p.meta.headers, body: Buffer.concat(p.chunks).subarray(0, p.meta.bodyLen) });
    }
  }

  private settle(conn: Conn, id: string, p: Pending, ok?: ForwardResponse, err?: Error): void {
    clearTimeout(p.timer);
    conn.pending.delete(id);
    if (ok) p.resolve(ok);
    else p.reject(err ?? new TunnelError('EOTHER', 'unknown'));
  }

  private drop(conn: Conn, byeReason?: string, terminate = false): void {
    if (byeReason) this.sendJson(conn, { t: 'bye', reason: byeReason });
    if (terminate) conn.ws.terminate();
    else conn.ws.close(1000, byeReason ?? 'bye');
    this.cleanup(conn);
  }

  private cleanup(conn: Conn): void {
    clearInterval(conn.ping);
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(new TunnelError('TUNNEL_CLOSED', 'tunnel closed'));
      conn.pending.delete(id);
    }
    if (this.conns.get(conn.subId) !== conn) return; // already replaced
    this.conns.delete(conn.subId);
    void q(this.ds, 'UPDATE subdomain SET last_activity_at = now() WHERE id = $1', [conn.subId]).catch(() => {});
    this.events.emit(conn.slug, 'tunnel.status', { online: false, target: null });
  }
}
