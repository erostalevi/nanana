import { Inject, Injectable } from '@nestjs/common';
import http from 'node:http';
import https from 'node:https';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ApiError, badRequest, notFound } from '../common/errors.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { stripHopByHop, type HeaderMap } from '../common/http.js';
import { q } from '../db/query.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { replayDto, type CaptureRow } from '../requests/requests.service.js';
import type { SubRow } from '../subdomains/subdomains.service.js';
import { TunnelError, TunnelService } from '../tunnel/tunnel.service.js';
import { resolveSafeTarget, UrlBlockedError } from './ssrf.js';

const MAX_RESPONSE = 1024 * 1024;

type Target = { type: 'tunnel' } | { type: 'url'; url: string };

interface Outcome {
  status: number | null;
  headers: HeaderMap | null;
  body: Buffer | null;
  truncated: boolean;
  error: string | null;
}

@Injectable()
export class ReplayService {
  private readonly limiter = new RateLimiter();

  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TunnelService) private readonly tunnels: TunnelService,
  ) {}

  parseTarget(input: unknown): Target {
    const t = (input as { type?: unknown; url?: unknown } | null) ?? {};
    if (t.type === 'tunnel') return { type: 'tunnel' };
    if (t.type === 'url' && typeof t.url === 'string' && t.url.length <= 2048) return { type: 'url', url: t.url };
    throw badRequest('invalid_target', 'target must be { type: "tunnel" } or { type: "url", url }');
  }

  async replay(sub: SubRow, requestId: string, target: Target, overrideHeaders?: unknown) {
    const rows = await q<CaptureRow[]>(this.ds, 'SELECT * FROM captured_request WHERE id = $1 AND subdomain_id = $2', [requestId, sub.id]);
    const cap = rows[0];
    if (!cap) throw notFound('request');

    const headers: HeaderMap = stripHopByHop(cap.headers);
    for (const k of ['host', 'content-length', 'accept-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) delete headers[k];
    if (overrideHeaders !== undefined) {
      if (typeof overrideHeaders !== 'object' || overrideHeaders === null || Array.isArray(overrideHeaders)) throw badRequest('invalid_headers', 'overrideHeaders must be an object');
      for (const [k, v] of Object.entries(overrideHeaders as Record<string, unknown>)) {
        if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(k) || /[\r\n]/.test(v)) throw badRequest('invalid_headers', 'invalid header override');
        headers[k.toLowerCase()] = v;
      }
    }

    const started = Date.now();
    let outcome: Outcome;
    let targetUrl: string | null = null;

    if (target.type === 'tunnel') {
      if (!this.tunnels.isOnline(sub.id)) throw new ApiError(409, 'tunnel_offline', 'No CLI tunnel is connected for this subdomain');
      outcome = await this.viaTunnel(sub, cap, headers);
    } else {
      targetUrl = target.url;
      const wait = this.limiter.take(`replay:${sub.id}`, 10);
      if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many replays, slow down', { 'Retry-After': String(wait) });
      let safe;
      try {
        safe = await resolveSafeTarget(target.url, this.cfg.replayAllowPrivate);
      } catch (e) {
        if (e instanceof UrlBlockedError) throw badRequest('url_blocked', e.message);
        throw e;
      }
      outcome = await this.viaUrl(cap, headers, safe);
    }

    const id = uuidv7();
    const duration = Date.now() - started;
    const inserted = await q<Parameters<typeof replayDto>[0][]>(
      this.ds,
      `INSERT INTO replay (id, request_id, target_type, target_url, status, response_headers, response_body, truncated, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, cap.id, target.type, targetUrl, outcome.status, outcome.headers ? JSON.stringify(outcome.headers) : null, outcome.body, outcome.truncated, outcome.error, duration],
    );
    return replayDto(inserted[0]);
  }

  private async viaTunnel(sub: SubRow, cap: CaptureRow, headers: HeaderMap): Promise<Outcome> {
    try {
      const r = await this.tunnels.forward(sub.id, {
        id: uuidv7(),
        method: cap.method,
        path: cap.path,
        headers,
        body: cap.body ?? Buffer.alloc(0),
        replay: true,
      });
      const trunc = r.body.length > MAX_RESPONSE;
      return { status: r.status, headers: r.headers, body: trunc ? r.body.subarray(0, MAX_RESPONSE) : r.body, truncated: trunc, error: null };
    } catch (e) {
      const code = e instanceof TunnelError ? e.code : 'EOTHER';
      return { status: null, headers: null, body: null, truncated: false, error: `${code}: ${(e as Error).message}` };
    }
  }

  private viaUrl(cap: CaptureRow, headers: HeaderMap, safe: { url: URL; address: string; family: 4 | 6 }): Promise<Outcome> {
    const { url, address, family } = safe;
    const isHttps = url.protocol === 'https:';
    const body = cap.body ?? Buffer.alloc(0);
    const out: HeaderMap = { ...headers, host: url.host, 'content-length': String(body.length), 'x-replayed-by': 'nanana', 'x-replay-of': cap.id };
    return new Promise<Outcome>((resolve) => {
      const lib = isHttps ? https : http;
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: cap.method,
          headers: out as http.OutgoingHttpHeaders,
          timeout: 10_000,
          servername: url.hostname,
          // Connect to the already-vetted address: no second DNS lookup, so no rebinding.
          lookup: (_h, _o, cb) => (_o && (_o as { all?: boolean }).all ? (cb as unknown as (e: null, a: unknown[]) => void)(null, [{ address, family }]) : cb(null, address, family)),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          res.on('data', (c: Buffer) => {
            if (size >= MAX_RESPONSE) {
              truncated = true;
              return;
            }
            const room = MAX_RESPONSE - size;
            chunks.push(c.length > room ? c.subarray(0, room) : c);
            if (c.length > room) truncated = true;
            size += Math.min(c.length, room);
          });
          res.on('end', () => {
            const hdrs: HeaderMap = {};
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
              const k = res.rawHeaders[i].toLowerCase();
              const v = res.rawHeaders[i + 1];
              const cur = hdrs[k];
              hdrs[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
            }
            resolve({ status: res.statusCode ?? null, headers: hdrs, body: Buffer.concat(chunks), truncated, error: null });
          });
          res.on('error', (e) => resolve({ status: null, headers: null, body: null, truncated: false, error: `ERESPONSE: ${e.message}` }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout after 10s')));
      req.on('error', (e: NodeJS.ErrnoException) => resolve({ status: null, headers: null, body: null, truncated: false, error: `${e.code ?? 'EOTHER'}: ${e.message}` }));
      req.end(body);
    });
  }
}
