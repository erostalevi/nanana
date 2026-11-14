import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request } from 'express';
import { WebSocketServer } from 'ws';
import { AccessService } from '../auth/access.service.js';
import { sha256 } from '../common/crypto.js';
import { APP_CONFIG, publicUrls, type AppConfig } from '../config/app-config.js';
import { limitsFor } from '../config/plan-limits.js';
import { resolveHost } from '../hosts/host-resolver.js';
import { SubdomainsService } from '../subdomains/subdomains.service.js';
import { TunnelService } from './tunnel.service.js';

export const PROTOCOL_VERSION = 1;

function reject(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  const text = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 400: 'Bad Request' }[status] ?? 'Error';
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  socket.destroy();
}

@Injectable()
export class TunnelGateway {
  private readonly log = new Logger('TunnelGateway');
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  constructor(
    @Inject(TunnelService) private readonly tunnels: TunnelService,
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.onUpgrade(req, socket, head).catch((e) => {
        this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
        socket.destroy();
      });
    });
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/tunnel') return void socket.destroy();
    if (resolveHost(req.headers.host, this.cfg.baseDomain).kind === 'ingress') return void socket.destroy();

    const proto = Number(req.headers['x-nanana-protocol'] ?? PROTOCOL_VERSION);
    if (!Number.isFinite(proto) || proto < PROTOCOL_VERSION)
      return reject(socket, 426, 'upgrade_required', 'This CLI version is too old, please upgrade nanana');

    const p = await this.access.principal(req as unknown as Request);
    if (p.kind === 'none') return reject(socket, 401, 'unauthorized', 'Missing or invalid token');

    let slug = url.searchParams.get('sub');
    if (!slug && p.kind === 'sub') {
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      slug = (await this.subs.getByTokenHash(sha256(auth)))?.slug ?? null;
    }
    if (!slug) return reject(socket, 400, 'sub_required', 'Missing ?sub=<slug>');
    const sub = await this.subs.getBySlug(slug);
    if (!sub) return reject(socket, 404, 'not_found', 'Subdomain not found');
    if (p.kind === 'sub' ? p.subId !== sub.id : sub.owner_id !== p.accountId)
      return reject(socket, 403, 'forbidden', 'This token does not grant access to that subdomain');

    if (sub.owner_id) {
      const max = limitsFor(sub.owner_plan ?? 'free').tunnelsPerAccount;
      if (this.tunnels.onlineForOwner(sub.owner_id, sub.id) >= max)
        return reject(socket, 403, 'tunnel_limit', `Your plan allows ${max} simultaneous tunnels. Close one or upgrade to Pro.`);
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const urls = publicUrls(this.cfg, sub.slug);
      this.tunnels.register(ws, sub, {
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        sub: sub.slug,
        url: urls.url,
        dashboard: urls.dashboardUrl,
        serverTime: new Date().toISOString(),
      });
    });
  }
}
