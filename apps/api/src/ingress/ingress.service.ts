import { Inject, Injectable, Logger } from '@nestjs/common';
import { q } from '../db/query.js';
import { pgPool, type PgPool } from '../db/pool.js';
import { LoadService } from '../common/load.service.js';
import type { NextFunction, Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { isLapsed, limitsFor, type PlanLimits } from '../config/plan-limits.js';
import { isLoadtest } from '../common/loadtest.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { PayloadTooLarge, rawHeaders, readBody, stripHopByHop, type HeaderMap } from '../common/http.js';
import { resolveHost } from '../hosts/host-resolver.js';
import { MetricsService } from '../admin/metrics.service.js';
import { EventsService } from '../events/events.service.js';
import { MocksService } from '../mocks/mocks.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { SubdomainsService, type SubRow } from '../subdomains/subdomains.service.js';
import { TunnelService, type ForwardResponse } from '../tunnel/tunnel.service.js';

const MAX_STORED_RESPONSE = 1024 * 1024;
const MAX_RELAY_RESPONSE = 10 * 1024 * 1024;

const EMPTY = Buffer.alloc(0);
const JSON_START = /^\s*[{[]/;
const RETENTION_BIG_BODY = 256 * 1024;
const SHED_BODY = '{"error":"overloaded","message":"The service is busy, retry shortly."}';
const NOT_FOUND_BODY = '{"error":"not_found","message":"This subdomain does not exist or has expired."}';
const isPoolTimeout = (e: unknown): boolean => String((e as Error | undefined)?.message ?? '').includes('timeout exceeded when trying to connect');

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
  private readonly pool: PgPool;
  private readonly retention = new Map<string, { lastRun: number; insertsSince: number }>();

  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
    @Inject(RequestsService) private readonly requests: RequestsService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(TunnelService) private readonly tunnels: TunnelService,
    @Inject(MocksService) private readonly mocks: MocksService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(LoadService) private readonly load: LoadService,
  ) {
    this.pool = lazyPool(ds);
  }

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
    const type = JSON_START.test(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    res.status(status);
    for (const [k, v] of Object.entries({ ...CORS_HEADERS, 'content-type': type, 'x-content-type-options': 'nosniff', ...extra })) res.setHeader(k, v);
    res.end(body);
  }

  /** Sends the 503 used for every kind of load shedding. */
  private shedResponse(res: Response, retryAfterSec: number): void {
    this.metrics.shed();
    this.send(res, 503, SHED_BODY, { 'retry-after': String(retryAfterSec) });
  }

  /**
   * The capture INSERT, timed and guarded. Returns true when the row is stored. When it returns false the request has already
   * been answered (503 when the pool is exhausted, 404 when the endpoint was deleted behind the lookup cache).
   */
  private async insertCapture(res: Response, slug: string, text: string, params: unknown[], bodyDoneAt: number): Promise<boolean> {
    if (Date.now() - bodyDoneAt > this.cfg.requestBudgetMs) {
      this.shedResponse(res, 1);
      return false;
    }
    const t0 = Date.now();
    try {
      await this.pool.query(text, params);
      this.load.observeDb(Date.now() - t0);
      return true;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === '23503') {
        this.subs.invalidate(slug);
        this.metrics.rejected();
        this.send(res, 404, NOT_FOUND_BODY);
        return false;
      }
      if (isPoolTimeout(e)) {
        this.load.observeDb(Date.now() - t0);
        this.shedResponse(res, 1);
        return false;
      }
      throw e;
    }
  }

  async handle(req: Request, res: Response, slug: string): Promise<void> {
    const started = Date.now();
    let sub: SubRow | null;
    try {
      sub = await this.subs.getBySlugCached(slug);
    } catch (e) {
      if (isPoolTimeout(e)) return this.shedResponse(res, 1);
      throw e;
    }
    if (!sub) {
      let tomb: unknown[];
      try {
        tomb = await q(this.ds, 'SELECT 1 FROM slug_tombstone WHERE slug = $1 AND until > now()', [slug]);
      } catch (e) {
        if (isPoolTimeout(e)) return this.shedResponse(res, 1);
        throw e;
      }
      this.metrics.rejected();
      if (tomb.length) return this.send(res, 410, '{"error":"gone","message":"This subdomain expired."}');
      return this.send(res, 404, NOT_FOUND_BODY);
    }

    const plan = sub.owner_id ? (sub.owner_plan ?? 'free') : null;
    if (isLapsed(plan)) {
      this.metrics.rejected();
      return this.send(res, 402, '{"error":"endpoint_read_only","message":"The owner of this endpoint has no active plan. It is read-only and not capturing new requests."}');
    }
    const d = this.load.shouldShed(plan);
    if (d.shed) return this.shedResponse(res, d.retryAfterSec);
    const limits = limitsFor(plan);
    const wait = isLoadtest(this.cfg, req) ? 0 : this.limiter.take(`sub:${sub.id}`, limits.ratePerMinute);
    if (wait > 0) {
      this.metrics.rejected();
      return this.send(res, 429, '{"error":"rate_limited"}', { 'retry-after': String(wait) });
    }

    let body: Buffer;
    try {
      body = await readBody(req, Math.min(limits.maxBodyBytes, limits.retentionMaxBytes));
    } catch (e) {
      if (e instanceof PayloadTooLarge) {
        this.metrics.rejected();
        return this.send(res, 413, '{"error":"payload_too_large"}', { connection: 'close' });
      }
      throw e;
    }
    const bodyDoneAt = Date.now();

    const headers = rawHeaders(req);
    const isPreflight = req.method === 'OPTIONS' && !!headers['access-control-request-method'];
    const id = uuidv7();
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const ctype = typeof headers['content-type'] === 'string' ? (headers['content-type'] as string) : null;
    const headersJson = JSON.stringify(headers);
    const receivedAt = new Date();
    const watched = (): boolean => this.events.hasListeners(slug);

    // Decide the response before touching the database.
    let status = sub.offline_status;
    let outHeaders: HeaderMap = {};
    let outBody: Buffer = Buffer.from(sub.offline_body);
    let answeredBy: 'tunnel' | 'mock' | 'offline' = 'offline';
    let forwardError: string | null = null;
    let mocked = false;
    let viaTunnel = false;

    if (isPreflight) {
      status = 204;
      outBody = EMPTY;
    } else {
      const mock = await this.mocks.consume(sub);
      if (mock) {
        status = mock.status;
        outHeaders = mock.headers;
        outBody = Buffer.from(mock.body);
        answeredBy = 'mock';
        mocked = true;
      } else viaTunnel = this.tunnels.isOnline(sub.id);
    }

    const baseSummary = {
      id, method: req.method, path: req.originalUrl, headers, body, contentType: ctype, sourceIp: ip, receivedAt, isPreflight,
    };

    if (!viaTunnel) {
      // One write: the response is already known.
      const out = this.buildResponse(outHeaders, outBody, answeredBy);
      const truncated = outBody.length > MAX_STORED_RESPONSE;
      const latency = Date.now() - started;
      const stored = isPreflight ? 'preflight' : answeredBy;
      const ok = await this.insertCapture(
        res, slug,
        `INSERT INTO captured_request (id, subdomain_id, method, path, headers, body, body_size, content_type, source_ip, is_preflight, received_at,
           answered_by, response_status, response_headers, response_body, response_truncated, latency_ms, forward_error, mocked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, sub.id, req.method, req.originalUrl, headersJson, body, body.length, ctype, ip, isPreflight, receivedAt,
          stored, status, JSON.stringify(out), truncated ? outBody.subarray(0, MAX_STORED_RESPONSE) : outBody, truncated, latency, forwardError, mocked],
        bodyDoneAt,
      );
      if (!ok) return;
      await this.touchSub(sub);
      this.reply(res, req, status, out, outBody);
      this.metrics.answered(Date.now() - started, false);
      if (watched()) {
        this.events.emit(slug, 'request.created', this.requests.summaryFromParts(sub, { ...baseSummary, answeredBy: null, responseStatus: null, latencyMs: null, forwardError: null, mocked: false }));
        this.events.emit(slug, 'request.updated', this.requests.summaryFromParts(sub, { ...baseSummary, answeredBy: stored, responseStatus: status, latencyMs: latency, forwardError, mocked }));
      }
      return this.retentionAfter(sub, limits, body.length);
    }

    // Tunnel: the dashboard must see the request before the local server answers, so two phases.
    const ok = await this.insertCapture(
      res, slug,
      `INSERT INTO captured_request (id, subdomain_id, method, path, headers, body, body_size, content_type, source_ip, is_preflight, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, sub.id, req.method, req.originalUrl, headersJson, body, body.length, ctype, ip, false, receivedAt],
      bodyDoneAt,
    );
    if (!ok) return;
    await this.touchSub(sub);
    if (watched()) {
      this.events.emit(slug, 'request.created', this.requests.summaryFromParts(sub, { ...baseSummary, answeredBy: null, responseStatus: null, latencyMs: null, forwardError: null, mocked: false }));
    }
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

    const out = this.buildResponse(outHeaders, outBody, answeredBy);
    this.reply(res, req, status, out, outBody);
    this.metrics.answered(Date.now() - started, answeredBy === 'tunnel');

    // Record what was actually sent.
    const truncated = outBody.length > MAX_STORED_RESPONSE;
    const latency = Date.now() - started;
    await this.pool.query(
      `UPDATE captured_request SET answered_by=$2, response_status=$3, response_headers=$4, response_body=$5,
         response_truncated=$6, latency_ms=$7, forward_error=$8, mocked=$9 WHERE id=$1`,
      [id, answeredBy, status, JSON.stringify(out), truncated ? outBody.subarray(0, MAX_STORED_RESPONSE) : outBody, truncated, latency, forwardError, false],
    );
    if (watched()) {
      this.events.emit(slug, 'request.updated', this.requests.summaryFromParts(sub, { ...baseSummary, answeredBy, responseStatus: status, latencyMs: latency, forwardError, mocked: false }));
    }
    return this.retentionAfter(sub, limits, body.length);
  }

  private async touchSub(sub: SubRow): Promise<void> {
    await this.subs.touch(sub);
    // touch() throttles only active endpoints; drop a stale cached 'cold' row so the next request is not slowed down.
    if (sub.state !== 'active') this.subs.invalidate(sub.slug);
  }

  /** Lower-cased response headers as they are sent and stored. */
  private buildResponse(outHeaders: HeaderMap, outBody: Buffer, answeredBy: string): HeaderMap {
    const lower: HeaderMap = {};
    for (const k in outHeaders) lower[k.toLowerCase()] = outHeaders[k];
    delete lower['content-length'];
    if ((answeredBy === 'offline' || answeredBy === 'mock') && !lower['content-type'] && outBody.length) {
      lower['content-type'] = JSON_START.test(outBody.subarray(0, 64).toString()) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    }
    if (!lower['access-control-allow-origin']) for (const k in CORS_HEADERS) lower[k] = lower[k] ?? CORS_HEADERS[k];
    lower['x-content-type-options'] = 'nosniff';
    return lower;
  }

  private reply(res: Response, req: Request, status: number, lower: HeaderMap, outBody: Buffer): void {
    res.status(status);
    for (const k in lower) {
      try {
        res.setHeader(k, lower[k]);
      } catch {
        /* skip invalid header values */
      }
    }
    res.setHeader('content-length', String(outBody.length));
    res.end(req.method === 'HEAD' ? undefined : outBody);
  }

  /** Per-endpoint retention bookkeeping: at most one run per interval, plus safety valves for bursts and big bodies. */
  private async retentionAfter(sub: SubRow, limits: PlanLimits, bodyBytes: number): Promise<void> {
    const now = Date.now();
    let st = this.retention.get(sub.id);
    if (!st) {
      if (this.retention.size > 20_000) this.retention.clear();
      st = { lastRun: 0, insertsSince: 0 };
      this.retention.set(sub.id, st);
    }
    st.insertsSince++;
    const interval = this.cfg.retentionIntervalMs;
    const due = interval <= 0 || now - st.lastRun >= interval || st.insertsSince >= limits.retentionMaxRequests || bodyBytes > RETENTION_BIG_BODY;
    if (!due) return;
    st.lastRun = now;
    st.insertsSince = 0;
    const run = this.enforceRetention(sub, limits).catch((e) => this.log.error(`retention failed: ${e instanceof Error ? e.message : String(e)}`));
    // With interval 0 (tests) stay deterministic; otherwise never delay the request's own completion.
    if (interval <= 0) await run;
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
    const listening = this.events.hasListeners(sub.slug);
    const res = await this.pool.query<{ id: string }>(
      `WITH ranked AS (
         SELECT id,
                row_number() OVER (ORDER BY id DESC) AS rn,
                SUM(body_size + COALESCE(octet_length(response_body), 0)) OVER (ORDER BY id DESC) AS running
         FROM captured_request WHERE subdomain_id = $1
       )
       DELETE FROM captured_request WHERE id IN (SELECT id FROM ranked WHERE rn > $2 OR (rn > 1 AND running > $3))
       ${listening ? 'RETURNING id' : ''}`,
      [sub.id, limits.retentionMaxRequests, limits.retentionMaxBytes],
    );
    if (listening) for (const r of res.rows) this.events.emit(sub.slug, 'request.deleted', { id: r.id });
  }
}

/** The pg pool exists only after TypeORM initialises; resolve it on first use. */
function lazyPool(ds: DataSource): PgPool {
  let pool: PgPool | undefined;
  const get = (): PgPool => (pool ??= pgPool(ds));
  return {
    query: (text, params) => get().query(text, params),
    get waitingCount() { return get().waitingCount; },
    get totalCount() { return get().totalCount; },
  };
}
