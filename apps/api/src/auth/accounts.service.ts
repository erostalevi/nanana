import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ApiError, badRequest } from '../common/errors.js';
import { parseCookies } from '../common/cookies.js';
import { newToken, randomBase62, sha256 } from '../common/crypto.js';
import { isAllowedOrigin } from '../common/origin.js';
import { q } from '../db/query.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SubdomainsService } from '../subdomains/subdomains.service.js';
import { bearer, type AccountPrincipal, type AccountResolver } from './access.service.js';
import { MailService } from './mail.service.js';

export const SESSION_COOKIE = 'nanana_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAGIC_TTL_MS = 15 * 60 * 1000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_INTERVAL_S = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

export interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  plan: string;
  created_at: Date;
  disabled_at: Date | null;
}

export const accountDto = (a: AccountRow) => ({ id: a.id, email: a.email, displayName: a.display_name });

@Injectable()
export class AccountsService implements AccountResolver {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
  ) {}

  // ---- principal resolution (nna_ token or session cookie) ----
  async resolve(req: Request): Promise<AccountPrincipal | null> {
    const token = bearer(req);
    if (token?.startsWith('nna_')) {
      const rows = await q<(AccountRow & { token_id: string })[]>(
        this.ds,
        `UPDATE cli_token t SET last_used_at = now() FROM account a
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND a.id = t.account_id AND a.disabled_at IS NULL
         RETURNING a.*, t.id AS token_id`,
        [sha256(token)],
      );
      return rows[0] ? this.principal(rows[0]) : null;
    }
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!cookie) return null;
    // CSRF defence in depth: cookie-authenticated writes must come from our own origins.
    const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    const origin = req.headers.origin;
    if (!safe && origin && !isAllowedOrigin(this.cfg, origin)) return null;
    const rows = await q<AccountRow[]>(
      this.ds,
      `SELECT a.* FROM session s JOIN account a ON a.id = s.account_id
       WHERE s.id = $1 AND s.expires_at > now() AND a.disabled_at IS NULL`,
      [sha256(cookie)],
    );
    return rows[0] ? this.principal(rows[0]) : null;
  }

  private principal(a: AccountRow): AccountPrincipal {
    return { kind: 'account', accountId: a.id, email: a.email, plan: a.plan, displayName: a.display_name };
  }

  async getAccount(id: string): Promise<AccountRow | null> {
    return (await q<AccountRow[]>(this.ds, 'SELECT * FROM account WHERE id = $1', [id]))[0] ?? null;
  }

  // ---- sessions ----
  async startSession(res: Response, accountId: string, userAgent?: string): Promise<void> {
    const token = `nns_${randomBase62(40)}`;
    await q(this.ds, 'INSERT INTO session (id, account_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)', [
      sha256(token),
      accountId,
      new Date(Date.now() + SESSION_TTL_MS),
      userAgent?.slice(0, 200) ?? null,
    ]);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.cfg.scheme === 'https',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
  }

  async endSession(req: Request, res: Response): Promise<void> {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (cookie) await q(this.ds, 'DELETE FROM session WHERE id = $1', [sha256(cookie)]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  // ---- account lookup/creation ----
  async findOrCreate(provider: 'email' | 'github' | 'google', subject: string, email: string, displayName?: string | null): Promise<AccountRow> {
    const mail = email.trim().toLowerCase();
    const byIdentity = await q<AccountRow[]>(
      this.ds,
      `SELECT a.* FROM identity i JOIN account a ON a.id = i.account_id WHERE i.provider = $1 AND i.subject = $2`,
      [provider, subject],
    );
    if (byIdentity[0]) return this.assertEnabled(byIdentity[0]);
    let acct = (await q<AccountRow[]>(this.ds, 'SELECT * FROM account WHERE lower(email) = $1', [mail]))[0];
    if (!acct) {
      acct = (
        await q<AccountRow[]>(this.ds, 'INSERT INTO account (id, email, display_name) VALUES ($1,$2,$3) RETURNING *', [
          uuidv7(),
          mail,
          displayName ?? null,
        ])
      )[0];
    }
    await q(this.ds, 'INSERT INTO identity (id, account_id, provider, subject) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
      uuidv7(),
      acct.id,
      provider,
      subject,
    ]);
    return this.assertEnabled(acct);
  }

  private assertEnabled(a: AccountRow): AccountRow {
    if (a.disabled_at) throw new ApiError(403, 'account_disabled', 'This account is disabled');
    return a;
  }

  // ---- magic links ----
  async sendMagicLink(email: string, next?: string): Promise<void> {
    const token = `nnm_${randomBase62(40)}`;
    await q(this.ds, 'INSERT INTO magic_link (token_hash, email, expires_at) VALUES ($1,$2,$3)', [
      sha256(token),
      email,
      new Date(Date.now() + MAGIC_TTL_MS),
    ]);
    const nextQ = next && /^\/[A-Za-z0-9/_?=&.%-]*$/.test(next) ? `&next=${encodeURIComponent(next)}` : '';
    await this.mail.sendMagicLink(email, `${this.cfg.webOrigin}/auth/verify?token=${token}${nextQ}`);
  }

  async verifyMagicLink(token: string): Promise<AccountRow> {
    const rows = await q<{ email: string }[]>(
      this.ds,
      `UPDATE magic_link SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email`,
      [sha256(token)],
    );
    if (!rows[0]) throw badRequest('invalid_token', 'This sign-in link is invalid, expired or was already used');
    return this.findOrCreate('email', rows[0].email.toLowerCase(), rows[0].email);
  }

  // ---- CLI tokens ----
  async listTokens(accountId: string) {
    const rows = await q<{ id: string; name: string; created_at: Date; last_used_at: Date | null }[]>(
      this.ds,
      'SELECT id, name, created_at, last_used_at FROM cli_token WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
      [accountId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null }));
  }

  async revokeToken(accountId: string, id: string): Promise<boolean> {
    const rows = await q<{ id: string }[]>(this.ds, 'UPDATE cli_token SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING id', [id, accountId]);
    return rows.length > 0;
  }

  // ---- device flow ----
  async startDevice(clientName?: string) {
    const deviceCode = randomBase62(40);
    let userCode = '';
    for (let i = 0; i < 8; i++) {
      const raw = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[Math.floor(Math.random() * USER_CODE_ALPHABET.length)]).join('');
      userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const ins = await q<{ user_code: string }[]>(
        this.ds,
        `INSERT INTO device_auth (device_code_hash, user_code, client_name, expires_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_code) DO NOTHING RETURNING user_code`,
        [sha256(deviceCode), userCode, (clientName ?? 'nanana-cli').slice(0, 60), new Date(Date.now() + DEVICE_TTL_MS)],
      );
      if (ins.length) break;
      userCode = '';
    }
    if (!userCode) throw new ApiError(503, 'unavailable', 'Try again');
    const base = this.cfg.webOrigin;
    return {
      deviceCode,
      userCode,
      verificationUri: `${base}/device`,
      verificationUriComplete: `${base}/device?code=${userCode}`,
      interval: DEVICE_INTERVAL_S,
      expiresIn: DEVICE_TTL_MS / 1000,
    };
  }

  async approveDevice(accountId: string, userCode: string): Promise<void> {
    const code = userCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const norm = `${code.slice(0, 4)}-${code.slice(4)}`;
    const rows = await q<{ user_code: string }[]>(
      this.ds,
      `UPDATE device_auth SET account_id = $1, status = 'approved'
       WHERE user_code = $2 AND status = 'pending' AND expires_at > now() RETURNING user_code`,
      [accountId, norm],
    );
    if (!rows[0]) throw new ApiError(404, 'invalid_code', 'That code is invalid or expired');
  }

  async pollDevice(deviceCode: string) {
    const hash = sha256(deviceCode);
    const row = (
      await q<{ status: string; account_id: string | null; client_name: string; expires_at: Date; last_polled_at: Date | null }[]>(
        this.ds,
        'SELECT status, account_id, client_name, expires_at, last_polled_at FROM device_auth WHERE device_code_hash = $1',
        [hash],
      )
    )[0];
    const err = (code: string, msg: string) => new ApiError(400, code, msg);
    if (!row) throw err('expired_token', 'Unknown device code');
    if (row.expires_at.getTime() < Date.now()) throw err('expired_token', 'The code expired, run login again');
    if (row.status === 'denied') throw err('access_denied', 'Access denied');
    if (row.status === 'consumed') throw err('expired_token', 'This code was already used');
    if (row.status === 'pending') {
      const tooFast = row.last_polled_at && Date.now() - row.last_polled_at.getTime() < (DEVICE_INTERVAL_S - 1) * 1000;
      await q(this.ds, 'UPDATE device_auth SET last_polled_at = now() WHERE device_code_hash = $1', [hash]);
      throw err(tooFast ? 'slow_down' : 'authorization_pending', tooFast ? 'Polling too fast' : 'Waiting for approval');
    }
    // approved: mint the token exactly once
    const claimed = await q<{ account_id: string }[]>(
      this.ds,
      `UPDATE device_auth SET status = 'consumed' WHERE device_code_hash = $1 AND status = 'approved' RETURNING account_id`,
      [hash],
    );
    if (!claimed[0]) throw err('expired_token', 'This code was already used');
    const accessToken = newToken('nna');
    await q(this.ds, 'INSERT INTO cli_token (id, account_id, token_hash, name) VALUES ($1,$2,$3,$4)', [uuidv7(), claimed[0].account_id, sha256(accessToken), row.client_name]);
    const account = await this.getAccount(claimed[0].account_id);
    return { accessToken, account: accountDto(account!) };
  }

  // ---- account deletion ----
  async deleteAccount(accountId: string): Promise<void> {
    for (const s of await this.subs.listByOwner(accountId)) await this.subs.remove(s);
    await q(this.ds, 'DELETE FROM account WHERE id = $1', [accountId]);
  }

  async cleanup(): Promise<void> {
    await q(this.ds, 'DELETE FROM session WHERE expires_at < now()');
    await q(this.ds, `DELETE FROM device_auth WHERE expires_at < now() - interval '1 hour'`);
    await q(this.ds, `DELETE FROM magic_link WHERE expires_at < now() - interval '1 hour'`);
  }
}
