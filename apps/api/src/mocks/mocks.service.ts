import { Inject, Injectable } from '@nestjs/common';
import { q } from '../db/query.js';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { badRequest } from '../common/errors.js';
import { EventsService } from '../events/events.service.js';

export interface ConsumedMock {
  status: number;
  headers: Record<string, string>;
  body: string;
  remaining: number;
}

@Injectable()
export class MocksService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async set(sub: { id: string; slug: string }, input: { status?: unknown; headers?: unknown; body?: unknown; times?: unknown }) {
    const status = input.status;
    const times = input.times;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) throw badRequest('invalid_status', 'status must be 100-599');
    if (typeof times !== 'number' || !Number.isInteger(times) || times < 1 || times > 50) throw badRequest('invalid_times', 'times must be 1-50');
    const body = input.body === undefined ? '' : input.body;
    if (typeof body !== 'string' || Buffer.byteLength(body) > 4096) throw badRequest('invalid_body', 'body must be a string up to 4096 bytes');
    const headers: Record<string, string> = {};
    if (input.headers !== undefined) {
      if (typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers)) throw badRequest('invalid_headers', 'headers must be an object');
      for (const [k, v] of Object.entries(input.headers as Record<string, unknown>)) {
        if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(k) || /[\r\n]/.test(v)) throw badRequest('invalid_headers', 'invalid header');
        headers[k.toLowerCase()] = v;
      }
    }
    await q(this.ds, 
      `INSERT INTO mock_rule (id, subdomain_id, status, headers, body, remaining) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (subdomain_id) DO UPDATE SET status=$3, headers=$4, body=$5, remaining=$6, created_at=now()`,
      [uuidv7(), sub.id, status, JSON.stringify(headers), body, times],
    );
    const out = { status, remaining: times };
    this.events.emit(sub.slug, 'mock.updated', out);
    return out;
  }

  async clear(sub: { id: string; slug: string }): Promise<void> {
    await q(this.ds, 'DELETE FROM mock_rule WHERE subdomain_id = $1', [sub.id]);
    this.events.emit(sub.slug, 'mock.updated', null);
  }

  async consume(sub: { id: string; slug: string }): Promise<ConsumedMock | null> {
    const rows = await q<{ status: number; headers: Record<string, string>; body: string; remaining: number }[]>(this.ds, 
      `UPDATE mock_rule SET remaining = remaining - 1 WHERE subdomain_id = $1 AND remaining > 0
       RETURNING status, headers, body, remaining`,
      [sub.id],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.remaining <= 0) {
      await q(this.ds, 'DELETE FROM mock_rule WHERE subdomain_id = $1', [sub.id]);
      this.events.emit(sub.slug, 'mock.updated', null);
    } else this.events.emit(sub.slug, 'mock.updated', { status: r.status, remaining: r.remaining });
    return r;
  }
}
