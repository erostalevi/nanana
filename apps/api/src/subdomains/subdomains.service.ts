import { Inject, Injectable } from '@nestjs/common';
import { q } from '../db/query.js';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG, publicUrls, type AppConfig } from '../config/app-config.js';
import { limitsFor } from '../config/plan-limits.js';
import { ANONYMOUS_CREATES_PER_IP_PER_DAY } from '../config/plan-limits.js';
import { ApiError, badRequest } from '../common/errors.js';
import { encryptSecret, hashIp, newToken, randomSlug, sha256 } from '../common/crypto.js';
import { isHmacAlgo } from '../common/hmac.js';
import { EventsService } from '../events/events.service.js';
import { TunnelService } from '../tunnel/tunnel.service.js';
import { isValidSlug, RESERVED_LABELS } from '../hosts/host-resolver.js';

export interface SubRow {
  id: string;
  slug: string;
  owner_id: string | null;
  is_custom: boolean;
  token_hash: string;
  state: 'active' | 'cold';
  last_activity_at: Date;
  offline_status: number;
  offline_body: string;
  hmac_secret_enc: string | null;
  hmac_header: string | null;
  hmac_algo: string;
  created_ip_hash: string | null;
  always_on_until: Date | null;
  reserved_until: Date | null;
  created_at: Date;
  hard_expires_at: Date;
  renewed_at: Date | null;
}

const DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class SubdomainsService {
  private touched = new Map<string, number>();

  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(TunnelService) private readonly tunnels: TunnelService,
  ) {}

  async getBySlug(slug: string): Promise<SubRow | null> {
    const rows = await q<SubRow[]>(this.ds, 'SELECT * FROM subdomain WHERE slug = $1', [slug]);
    return rows[0] ?? null;
  }

  async getByTokenHash(hash: string): Promise<SubRow | null> {
    const rows = await q<SubRow[]>(this.ds, 'SELECT * FROM subdomain WHERE token_hash = $1', [hash]);
    return rows[0] ?? null;
  }

  async listByOwner(ownerId: string): Promise<SubRow[]> {
    return q<SubRow[]>(this.ds, 'SELECT * FROM subdomain WHERE owner_id = $1 ORDER BY created_at DESC', [ownerId]);
  }

  async dto(row: SubRow) {
    const mock = (
      await q<{ status: number; remaining: number }[]>(this.ds, 
        'SELECT status, remaining FROM mock_rule WHERE subdomain_id = $1',
        [row.id],
      )
    )[0];
    const urls = publicUrls(this.cfg, row.slug);
    return {
      slug: row.slug,
      url: urls.url,
      dashboardUrl: urls.dashboardUrl,
      isCustom: row.is_custom,
      ownerId: row.owner_id,
      state: row.state,
      lastActivityAt: row.last_activity_at.toISOString(),
      hardExpiresAt: row.hard_expires_at.toISOString(),
      offlineStatus: row.offline_status,
      offlineBody: row.offline_body,
      hmac:
        row.hmac_secret_enc || row.hmac_header
          ? { header: row.hmac_header ?? 'x-signature', algo: row.hmac_algo, configured: !!row.hmac_secret_enc }
          : null,
      tunnelOnline: this.tunnels.isOnline(row.id),
      mock: mock ? { status: mock.status, remaining: mock.remaining } : null,
    };
  }

  async create(input: { ownerId: string | null; plan: string | null; name?: string; ip: string; skipIpLimit?: boolean }) {
    const limits = limitsFor(input.ownerId ? (input.plan ?? 'free') : null);
    const ipHash = hashIp(input.ip, this.cfg.ipHashSecret);
    const name = input.name?.trim().toLowerCase();

    if (!input.ownerId) {
      if (name) throw new ApiError(403, 'forbidden', 'Custom names require an account');
      const [{ n }] = await q<{ n: string }[]>(this.ds, 
        `SELECT count(*) AS n FROM subdomain WHERE created_ip_hash = $1 AND created_at > now() - interval '1 day'`,
        [ipHash],
      );
      if (!input.skipIpLimit && Number(n) >= ANONYMOUS_CREATES_PER_IP_PER_DAY)
        throw new ApiError(429, 'rate_limited', 'Too many subdomains created from this address today', {
          'Retry-After': '3600',
        });
    } else {
      const [{ n }] = await q<{ n: string }[]>(this.ds, 
        'SELECT count(*) AS n FROM subdomain WHERE owner_id = $1',
        [input.ownerId],
      );
      if (Number(n) >= limits.maxActiveSubdomains)
        throw new ApiError(403, 'limit_reached', `Your plan allows ${limits.maxActiveSubdomains} active subdomains`);
      if (name) {
        const [{ c }] = await q<{ c: string }[]>(this.ds, 
          'SELECT count(*) AS c FROM subdomain WHERE owner_id = $1 AND is_custom',
          [input.ownerId],
        );
        if (Number(c) >= limits.maxCustomNames)
          throw new ApiError(403, 'limit_reached', `Your plan allows ${limits.maxCustomNames} custom name(s)`);
      }
    }

    const token = newToken('nnt');
    const tokenHash = sha256(token);

    if (name) {
      if (RESERVED_LABELS.has(name)) throw badRequest('name_reserved', 'That name is reserved');
      if (!isValidSlug(name)) throw badRequest('name_invalid', 'Use 3-32 chars: a-z, 0-9 and hyphens (not at the ends)');
      const tomb = (
        await q<{ owner_id: string | null }[]>(this.ds, 'SELECT owner_id FROM slug_tombstone WHERE slug = $1 AND until > now()', [name])
      )[0];
      if (tomb && tomb.owner_id !== input.ownerId)
        throw new ApiError(409, 'name_tombstoned', 'That name was recently used and is reserved for its previous owner');
      const row = await this.insert(name, true, tokenHash, input.ownerId, ipHash);
      if (!row) throw new ApiError(409, 'name_taken', 'That name is taken');
      await q(this.ds, 'DELETE FROM slug_tombstone WHERE slug = $1', [name]);
      return { row, token };
    }

    for (let i = 0; i < 8; i++) {
      const slug = randomSlug(8);
      if (!isValidSlug(slug)) continue;
      const row = await this.insert(slug, false, tokenHash, input.ownerId, ipHash);
      if (row) return { row, token };
    }
    throw new ApiError(503, 'unavailable', 'Could not allocate a subdomain, try again');
  }

  private async insert(slug: string, custom: boolean, tokenHash: string, ownerId: string | null, ipHash: string): Promise<SubRow | null> {
    const rows = await q<SubRow[]>(this.ds, 
      `INSERT INTO subdomain (id, slug, owner_id, is_custom, token_hash, created_ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [uuidv7(), slug, ownerId, custom, tokenHash, ipHash],
    );
    return rows[0] ?? null;
  }

  /** Records activity; revives cold subdomains. Throttled to once per 5 s per subdomain. */
  async touch(row: Pick<SubRow, 'id' | 'slug' | 'state'>): Promise<void> {
    const now = Date.now();
    if (row.state === 'active' && now - (this.touched.get(row.id) ?? 0) < 5000) return;
    this.touched.set(row.id, now);
    if (this.touched.size > 20000) this.touched.clear();
    const res = await q<{ prev: string }[]>(this.ds, 
      `UPDATE subdomain s SET last_activity_at = now(), state = 'active'
       FROM (SELECT id, state FROM subdomain WHERE id = $1) old
       WHERE s.id = old.id RETURNING old.state AS prev`,
      [row.id],
    );
    if (res[0]?.prev === 'cold') {
      const fresh = await q<{ hard_expires_at: Date }[]>(this.ds, 'SELECT hard_expires_at FROM subdomain WHERE id=$1', [row.id]);
      this.events.emit(row.slug, 'subdomain.state', {
        state: 'active',
        hardExpiresAt: fresh[0]?.hard_expires_at.toISOString(),
      });
    }
  }

  async patch(
    row: SubRow,
    body: { offlineStatus?: unknown; offlineBody?: unknown; hmacSecret?: unknown; hmacHeader?: unknown; hmacAlgo?: unknown },
  ): Promise<SubRow> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (body.offlineStatus !== undefined) {
      const n = body.offlineStatus;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 100 || n > 599) throw badRequest('invalid_offline_status', 'offlineStatus must be 100-599');
      add('offline_status', n);
    }
    if (body.offlineBody !== undefined) {
      if (typeof body.offlineBody !== 'string' || Buffer.byteLength(body.offlineBody) > 4096) throw badRequest('invalid_offline_body', 'offlineBody must be a string up to 4096 bytes');
      add('offline_body', body.offlineBody);
    }
    if (body.hmacAlgo !== undefined) {
      if (typeof body.hmacAlgo !== 'string' || !isHmacAlgo(body.hmacAlgo)) throw badRequest('invalid_hmac_algo', 'hmacAlgo must be sha256, sha1 or sha512');
      add('hmac_algo', body.hmacAlgo);
    }
    if (body.hmacHeader !== undefined) {
      if (typeof body.hmacHeader !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.hmacHeader)) throw badRequest('invalid_hmac_header', 'hmacHeader must be a header name');
      add('hmac_header', body.hmacHeader.toLowerCase());
    }
    if (body.hmacSecret !== undefined) {
      if (body.hmacSecret === null || body.hmacSecret === '') {
        add('hmac_secret_enc', null);
      } else if (typeof body.hmacSecret === 'string' && body.hmacSecret.length <= 512) {
        add('hmac_secret_enc', encryptSecret(body.hmacSecret, this.cfg.encryptionKey));
        if (body.hmacHeader === undefined && !row.hmac_header) add('hmac_header', 'x-signature');
      } else throw badRequest('invalid_hmac_secret', 'hmacSecret must be a string up to 512 chars or null');
    }
    if (!sets.length) return row;
    vals.push(row.id);
    const rows = await q<SubRow[]>(this.ds, `UPDATE subdomain SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    return rows[0];
  }

  async remove(row: SubRow, reason: 'deleted' | 'expired' = 'deleted'): Promise<void> {
    await this.ds.transaction(async (m) => {
      if (row.is_custom)
        await m.query(
          `INSERT INTO slug_tombstone (slug, owner_id, until) VALUES ($1,$2, now() + interval '7 days')
           ON CONFLICT (slug) DO UPDATE SET owner_id = EXCLUDED.owner_id, until = EXCLUDED.until`,
          [row.slug, row.owner_id],
        );
      await m.query('DELETE FROM subdomain WHERE id = $1', [row.id]);
    });
    this.events.emit(row.slug, 'subdomain.deleted', {});
    this.tunnels.close(row.id, reason);
  }

  async claim(accountId: string, plan: string, slug: string, token: string): Promise<SubRow> {
    const row = await this.getBySlug(slug);
    if (!row || row.token_hash !== sha256(token)) throw new ApiError(404, 'not_found', 'Subdomain or token not found');
    if (row.owner_id) throw new ApiError(409, 'already_claimed', 'This subdomain already has an owner');
    const limits = limitsFor(plan);
    const [{ n }] = await q<{ n: string }[]>(this.ds, 'SELECT count(*) AS n FROM subdomain WHERE owner_id = $1', [accountId]);
    if (Number(n) >= limits.maxActiveSubdomains) throw new ApiError(403, 'limit_reached', `Your plan allows ${limits.maxActiveSubdomains} active subdomains`);
    const rows = await q<SubRow[]>(this.ds, 'UPDATE subdomain SET owner_id = $1 WHERE id = $2 RETURNING *', [accountId, row.id]);
    return rows[0];
  }

  async renew(row: SubRow): Promise<SubRow> {
    if (row.renewed_at) throw new ApiError(409, 'already_renewed', 'This subdomain was already renewed once');
    const rows = await q<SubRow[]>(this.ds, 
      `UPDATE subdomain SET hard_expires_at = hard_expires_at + $2::interval, renewed_at = now() WHERE id = $1 RETURNING *`,
      [row.id, `${7 * 24} hours`],
    );
    this.events.emit(row.slug, 'subdomain.state', { state: rows[0].state, hardExpiresAt: rows[0].hard_expires_at.toISOString() });
    return rows[0];
  }

  async rotateToken(row: SubRow): Promise<string> {
    const token = newToken('nnt');
    await q(this.ds, 'UPDATE subdomain SET token_hash = $1 WHERE id = $2', [sha256(token), row.id]);
    this.tunnels.close(row.id, 'deleted');
    return token;
  }
}

export { DAY };
