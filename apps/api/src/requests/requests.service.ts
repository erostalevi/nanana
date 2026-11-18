import { Inject, Injectable } from '@nestjs/common';
import { q } from '../db/query.js';
import { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { decryptSecret } from '../common/crypto.js';
import { computeSignature, type Signature } from '../common/hmac.js';
import { bodyDto, preview, type HeaderMap } from '../common/http.js';
import type { SubRow } from '../subdomains/subdomains.service.js';

export interface CaptureRow {
  id: string;
  subdomain_id: string;
  method: string;
  path: string;
  headers: HeaderMap;
  body?: Buffer;
  head?: Buffer;
  body_size: number;
  content_type: string | null;
  source_ip: string;
  received_at: Date;
  answered_by: string | null;
  response_status: number | null;
  response_headers: HeaderMap | null;
  response_body: Buffer | null;
  response_truncated: boolean;
  latency_ms: number | null;
  forward_error: string | null;
  is_preflight: boolean;
  mocked: boolean;
}

const SUMMARY_COLS = `id, subdomain_id, method, path, body_size, content_type, source_ip, received_at, answered_by,
  response_status, latency_ms, forward_error, is_preflight, mocked`;

@Injectable()
export class RequestsService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private hmacCfg(sub: Pick<SubRow, 'hmac_secret_enc' | 'hmac_header' | 'hmac_algo'>) {
    return {
      secret: sub.hmac_secret_enc ? decryptSecret(sub.hmac_secret_enc, this.cfg.encryptionKey) : null,
      header: sub.hmac_header,
      algo: sub.hmac_algo,
    };
  }

  summary(row: CaptureRow, sub: SubRow) {
    const hm = this.hmacCfg(sub);
    const signature: Signature =
      hm.secret && row.body && row.headers
        ? computeSignature(hm, row.headers, row.body).state
        : hm.secret
          ? 'header_missing'
          : 'not_configured';
    return {
      id: row.id,
      method: row.method,
      path: row.path,
      receivedAt: row.received_at.toISOString(),
      bodySize: row.body_size,
      contentType: row.content_type,
      sourceIp: row.source_ip,
      answeredBy: row.is_preflight ? 'preflight' : (row.answered_by ?? 'offline'),
      responseStatus: row.response_status,
      latencyMs: row.latency_ms,
      isPreflight: row.is_preflight,
      mocked: row.mocked,
      forwardError: row.forward_error,
      signature,
      bodyPreview: preview(row.head ?? row.body?.subarray(0, 1024) ?? null),
    };
  }

  /**
   * Same object as `summary(row, sub)` for a capture the caller still holds in memory, so the hot path needs no SELECT.
   * `body` is the full request body (needed for the HMAC check and the 1 KB preview).
   */
  summaryFromParts(
    sub: SubRow,
    p: {
      id: string; method: string; path: string; headers: HeaderMap; body: Buffer; contentType: string | null; sourceIp: string; receivedAt: Date;
      answeredBy: string | null; responseStatus: number | null; latencyMs: number | null; forwardError: string | null; isPreflight: boolean; mocked: boolean;
    },
  ) {
    return this.summary(
      {
        id: p.id, subdomain_id: sub.id, method: p.method, path: p.path, headers: p.headers, body: p.body, head: p.body.subarray(0, 1024),
        body_size: p.body.length, content_type: p.contentType, source_ip: p.sourceIp, received_at: p.receivedAt, answered_by: p.answeredBy,
        response_status: p.responseStatus, response_headers: null, response_body: null, response_truncated: false, latency_ms: p.latencyMs,
        forward_error: p.forwardError, is_preflight: p.isPreflight, mocked: p.mocked,
      },
      sub,
    );
  }

  async summaryById(sub: SubRow, id: string) {
    const needFull = !!sub.hmac_secret_enc;
    const rows = await q<CaptureRow[]>(this.ds, 
      `SELECT ${SUMMARY_COLS}, headers, ${needFull ? 'body' : 'substring(body from 1 for 1024) AS head'}
       FROM captured_request WHERE id = $1 AND subdomain_id = $2`,
      [id, sub.id],
    );
    return rows[0] ? this.summary(rows[0], sub) : null;
  }

  async list(sub: SubRow, opts: { limit: number; before?: string; includePreflight: boolean }) {
    const needFull = !!sub.hmac_secret_enc;
    const params: unknown[] = [sub.id, opts.limit + 1];
    let where = 'subdomain_id = $1';
    if (opts.before) {
      params.push(opts.before);
      where += ` AND id < $${params.length}`;
    }
    if (!opts.includePreflight) where += ' AND NOT is_preflight';
    const rows = await q<CaptureRow[]>(this.ds, 
      `SELECT ${SUMMARY_COLS}, headers, ${needFull ? 'body' : 'substring(body from 1 for 1024) AS head'}
       FROM captured_request WHERE ${where} ORDER BY id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    return {
      requests: page.map((r) => this.summary(r, sub)),
      nextBefore: rows.length > opts.limit ? page[page.length - 1].id : null,
    };
  }

  async detail(sub: SubRow, id: string) {
    const rows = await q<CaptureRow[]>(this.ds, 'SELECT * FROM captured_request WHERE id = $1 AND subdomain_id = $2', [id, sub.id]);
    const row = rows[0];
    if (!row) return null;
    const hm = this.hmacCfg(sub);
    const sig = computeSignature(hm, row.headers, row.body!);
    const replays = await this.replays(row.id);
    return {
      ...this.summary(row, sub),
      headers: row.headers,
      body: bodyDto(row.body!)!,
      responseHeaders: row.response_headers,
      responseBody: bodyDto(row.response_body, row.response_truncated),
      signatureDetail: { state: sig.state, header: sig.header, received: sig.received, expected: sig.expected },
      replays,
    };
  }

  async replays(requestId: string) {
    const rows = await q<
      { id: string; request_id: string; target_type: string; target_url: string | null; status: number | null; response_headers: HeaderMap | null; response_body: Buffer | null; truncated: boolean; error: string | null; duration_ms: number; created_at: Date }[]
    >(this.ds, 'SELECT * FROM replay WHERE request_id = $1 ORDER BY created_at DESC', [requestId]);
    return rows.map(replayDto);
  }

  async remove(sub: SubRow, id: string): Promise<boolean> {
    const res = await q<{ id: string }[]>(this.ds, 'DELETE FROM captured_request WHERE id = $1 AND subdomain_id = $2 RETURNING id', [id, sub.id]);
    return res.length > 0;
  }
}

export function replayDto(r: {
  id: string; request_id: string; target_type: string; target_url: string | null; status: number | null;
  response_headers: HeaderMap | null; response_body: Buffer | null; truncated: boolean; error: string | null;
  duration_ms: number; created_at: Date;
}) {
  return {
    id: r.id,
    requestId: r.request_id,
    targetType: r.target_type as 'tunnel' | 'url',
    targetUrl: r.target_url,
    status: r.status,
    responseHeaders: r.response_headers,
    responseBody: bodyDto(r.response_body, r.truncated),
    error: r.error,
    durationMs: r.duration_ms,
    createdAt: r.created_at.toISOString(),
  };
}
