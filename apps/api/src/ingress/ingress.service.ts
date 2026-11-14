import { Inject, Injectable, Logger } from '@nestjs/common';
import { q } from '../db/query.js';
import type { NextFunction, Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { isLapsed, limitsFor, type PlanLimits } from '../config/plan-limits.js';
import { isLoadtest } from '../common/loadtest.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { PayloadTooLarge, rawHeaders, readBody, stripHopByHop, type HeaderMap } from '../common/http.js';
import { resolveHost } from '../hosts/host-resolver.js';
import { EventsService } from '../events/events.service.js';
import { MocksService } from '../mocks/mocks.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { SubdomainsService, type SubRow } from '../subdomains/subdomains.service.js';
import { TunnelService, type ForwardResponse } from '../tunnel/tunnel.service.js';

const MAX_STORED_RESPONSE = 1024 * 1024;
const MAX_RELAY_RESPONSE = 10 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '600',
};

@Injectable()
export class IngressService {
  private readonly log = new Logger('Ingress');
  private readonly limiter = new RateLimiter();

  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
    @Inject(RequestsService) private readonly requests: RequestsService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(TunnelService) private readonly tunnels: TunnelService,
    @Inject(MocksService) private readonly mocks: MocksService,
  ) {}

  /** Express middleware: handles <slug>.<base> hosts, passes everything else on. */
  middleware = (req: Request, res: Response, next: NextFunction): void => {
    const target = resolveHost(req.headers.host, this.cfg.baseDomain);
    if (target.kind !== 'ingress') return next();
    this.handle(req, res, target.slug).catch((err) => {
      this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      if (!res.headersSent) res.status(500).type('application/json').send('{"error":"internal_error"}');
    });
  };

  private send(res: Response, status: number, body: string, extra: Record<string, string> = {}): void {
    const type = /^\s*[{[]/.test(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    res.status(status);
    for (const [k, v] of Object.entries({ ...CORS_HEADERS, 'content-type': type, 'x-content-type-options': 'nosniff', ...extra })) res.setHeader(k, v);
    res.end(body);
  }

  async handle(req: Request, res: Response, slug: string): Promise<void> {
    const started = Date.now();
    const sub = await this.subs.getBySlug(slug);
    if (!sub) {
      const tomb = await q(this.ds, 'SELECT 1 FROM slug_tombstone WHERE slug = $1 AND until > now()', [slug]);
      if (tomb.length) return this.send(res, 410, '{"error":"gone","message":"This subdomain expired."}');
      return this.send(res, 404, '{"error":"not_found","message":"This subdomain does not exist or has expired."}');
    }

    const plan = sub.owner_id ? (sub.owner_plan ?? 'free') : null;
    if (isLapsed(plan)) return this.send(res, 402, '{"error":"endpoint_read_only","message":"The owner of this endpoint has no active plan. It is read-only and not capturing new requests."}');
    const limits = limitsFor(plan);
    const wait = isLoadtest(this.cfg, req) ? 0 : this.limiter.take(`sub:${sub.id}`, limits.ratePerMinute);
    if (wait > 0) return this.send(res, 429, '{"error":"rate_limited"}', { 'retry-after': String(wait) });

    let body: Buffer;
    try {
      body = await readBody(req, Math.min(limits.maxBodyBytes, limits.retentionMaxBytes));
    } catch (e) {
      if (e instanceof PayloadTooLarge) return this.send(res, 413, '{"error":"payload_too_large"}', { connection: 'close' });
      throw e;
    }

    const headers = rawHeaders(req);
    const isPreflight = req.method === 'OPTIONS' && !!headers['access-control-request-method'];
    const id = uuidv7();
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const ctype = typeof headers['content-type'] === 'string' ? (headers['content-type'] as string) : null;

    await q(this.ds, 
      `INSERT INTO captured_request (id, subdomain_id, method, path, headers, body, body_size, content_type, source_ip, is_preflight)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, sub.id, req.method, req.originalUrl, JSON.stringify(headers), body, body.length, ctype, ip, isPreflight],
    );
    await this.subs.touch(sub);
    const created = await this.requests.summaryById(sub, id);
    if (created) this.events.emit(slug, 'request.created', created);

    // Decide the response.
    let status = sub.offline_status;
    let outHeaders: HeaderMap = {};
    let outBody: Buffer = Buffer.from(sub.offline_body);
    let answeredBy: 'tunnel' | 'mock' | 'offline' = 'offline';
    let forwardError: string | null = null;
    let mocked = false;

    if (isPreflight) {
      status = 204;
      outBody = Buffer.alloc(0);
    } else {
      const mock = await this.mocks.consume(sub);
      if (mock) {
        status = mock.status;
        outHeaders = { ...mock.headers };
        outBody = Buffer.from(mock.body);
        answeredBy = 'mock';
        mocked = true;
      } else if (this.tunnels.isOnline(sub.id)) {
        try {
          const r: ForwardResponse = await this.tunnels.forward(sub.id, {
            id,
            method: req.method,
            path: req.originalUrl,
            headers: this.forwardHeaders(headers, ip, req.headers.host ?? ''),
            body,
            replay: false,
          });
          if (r.body.length > MAX_RELAY_RESPONSE) throw new Error('response too large');
          status = r.status;
          outHeaders = stripHopByHop(r.headers);
          outBody = r.body;
          answeredBy = 'tunnel';
        } catch (e) {
          forwardError = (e as { code?: string }).code ?? (e as Error).message ?? 'error';
        }
      }
    }

    // Send to the original sender.
    res.status(status);
    const lower: HeaderMap = {};
    for (const [k, v] of Object.entries(outHeaders)) lower[k.toLowerCase()] = v;
    delete lower['content-length'];
    if (answeredBy === 'offline' || answeredBy === 'mock') {
      if (!lower['content-type'] && outBody.length) lower['content-type'] = /^\s*[{[]/.test(outBody.toString()) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    }
    if (!lower['access-control-allow-origin']) for (const [k, v] of Object.entries(CORS_HEADERS)) lower[k] = lower[k] ?? v;
    lower['x-content-type-options'] = 'nosniff';
    for (const [k, v] of Object.entries(lower)) {
      try {
        res.setHeader(k, v);
      } catch {
        /* skip invalid header values */
      }
    }
    res.setHeader('content-length', String(outBody.length));
    res.end(req.method === 'HEAD' ? undefined : outBody);

    // Record what was actually sent.
    const truncated = outBody.length > MAX_STORED_RESPONSE;
    await q(this.ds, 
      `UPDATE captured_request SET answered_by=$2, response_status=$3, response_headers=$4, response_body=$5,
         response_truncated=$6, latency_ms=$7, forward_error=$8, mocked=$9 WHERE id=$1`,
      [id, isPreflight ? 'preflight' : answeredBy, status, JSON.stringify(lower), truncated ? outBody.subarray(0, MAX_STORED_RESPONSE) : outBody, truncated, Date.now() - started, forwardError, mocked],
    );
    const updated = await this.requests.summaryById(sub, id);
    if (updated) this.events.emit(slug, 'request.updated', updated);
    await this.enforceRetention(sub, limits);
  }

  private forwardHeaders(h: HeaderMap, ip: string, host: string): HeaderMap {
    const out = stripHopByHop(h);
    delete out['host'];
    delete out['content-length'];
    out['x-forwarded-for'] = ip;
    out['x-forwarded-proto'] = this.cfg.scheme;
    out['x-forwarded-host'] = host;
    return out;
  }

  /** Newest N requests and a byte budget per subdomain, both from the owner's plan. */
  async enforceRetention(sub: Pick<SubRow, 'id' | 'slug'>, limits: PlanLimits = limitsFor(null)): Promise<void> {
    const rows = await q<{ id: string }[]>(this.ds, 
      `WITH ranked AS (
         SELECT id,
                row_number() OVER (ORDER BY id DESC) AS rn,
                SUM(body_size + COALESCE(octet_length(response_body), 0)) OVER (ORDER BY id DESC) AS running
         FROM captured_request WHERE subdomain_id = $1
       )
       DELETE FROM captured_request WHERE id IN (SELECT id FROM ranked WHERE rn > $2 OR (rn > 1 AND running > $3))
       RETURNING id`,
      [sub.id, limits.retentionMaxRequests, limits.retentionMaxBytes],
    );
    for (const r of rows) this.events.emit(sub.slug, 'request.deleted', { id: r.id });
  }
}
