import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { ApiError, badRequest, forbidden, notFound } from '../common/errors.js';
import { parseCookies } from '../common/cookies.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { q } from '../db/query.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { limitsFor } from '../config/plan-limits.js';
import { TunnelService } from '../tunnel/tunnel.service.js';
import { AccessService } from './access.service.js';
import { AccountsService, accountDto } from './accounts.service.js';
import { OAuthService, type OAuthProvider } from './oauth.service.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const OAUTH_COOKIE = 'nanana_oauth';

@Controller()
export class AuthController {
  private readonly limiter = new RateLimiter();

  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(OAuthService) private readonly oauth: OAuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(TunnelService) private readonly tunnels: TunnelService,
  ) {}

  private providers() {
    return { github: this.oauth.enabled('github'), google: this.oauth.enabled('google'), magic: true as const };
  }

  @Get('auth/providers')
  providersRoute() {
    return this.providers();
  }

  @Post('auth/magic')
  @HttpCode(202)
  async magic(@Req() req: Request, @Body() body: { email?: unknown; next?: unknown }) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw badRequest('invalid_email', 'Enter a valid email address');
    const ip = req.ip ?? 'unknown';
    const wait = Math.max(this.limiter.take(`magic-ip:${ip}`, 5), this.limiter.take(`magic-email:${email}`, 3));
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many sign-in emails requested, try again soon', { 'Retry-After': String(wait * 10) });
    await this.accounts.sendMagicLink(email, typeof body.next === 'string' ? body.next : undefined);
    return {};
  }

  @Post('auth/magic/verify')
  @HttpCode(200)
  async verify(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { token?: unknown }) {
    if (typeof body?.token !== 'string') throw badRequest('invalid_token', 'token is required');
    const account = await this.accounts.verifyMagicLink(body.token);
    await this.accounts.startSession(res, account.id, req.headers['user-agent']);
    return { account: accountDto(account) };
  }

  @Get('auth/:provider')
  begin(@Param('provider') provider: string, @Query('next') next: string | undefined, @Res() res: Response) {
    if (provider !== 'github' && provider !== 'google') throw notFound('route');
    if (!this.oauth.enabled(provider)) throw notFound('provider');
    const { url, state } = this.oauth.begin(provider);
    const safeNext = next && /^\/[A-Za-z0-9/_?=&.%-]*$/.test(next) ? next : '/account';
    res.cookie(OAUTH_COOKIE, `${state}|${safeNext}`, { httpOnly: true, secure: this.cfg.scheme === 'https', sameSite: 'lax', path: '/', maxAge: 10 * 60 * 1000 });
    res.redirect(302, url);
  }

  @Get('auth/:provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (provider !== 'github' && provider !== 'google') throw notFound('route');
    if (!this.oauth.enabled(provider)) throw notFound('provider');
    const cookie = parseCookies(req.headers.cookie)[OAUTH_COOKIE] ?? '';
    const [expected, next] = cookie.split('|');
    res.clearCookie(OAUTH_COOKIE, { path: '/' });
    if (!code || !state || !expected || state !== expected) throw badRequest('invalid_state', 'Sign-in session expired, please try again');
    const account = await this.oauth.complete(provider as OAuthProvider, code);
    await this.accounts.startSession(res, account.id, req.headers['user-agent']);
    res.redirect(302, `${this.cfg.webOrigin}${next || '/account'}`);
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.accounts.endSession(req, res);
  }

  @Get('me')
  async me(@Req() req: Request) {
    const p = await this.access.requireAccount(req);
    const limits = limitsFor(p.plan);
    return {
      account: { id: p.accountId, email: p.email, displayName: p.displayName, plan: p.plan },
      limits: {
        maxActiveSubdomains: limits.maxActiveSubdomains,
        maxCustomNames: limits.maxCustomNames,
        maxBodyBytes: limits.maxBodyBytes,
        ratePerMinute: limits.ratePerMinute,
        retentionMaxRequests: limits.retentionMaxRequests,
        retentionMaxAgeMs: limits.retentionMaxAgeMs,
      },
      providers: this.providers(),
    };
  }

  @Delete('me')
  @HttpCode(204)
  async deleteMe(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const p = await this.access.requireAccount(req);
    await this.accounts.deleteAccount(p.accountId);
    res.clearCookie('nanana_session', { path: '/' });
  }

  @Get('me/tokens')
  async tokens(@Req() req: Request) {
    const p = await this.access.requireAccount(req);
    return { tokens: await this.accounts.listTokens(p.accountId) };
  }

  @Delete('me/tokens/:id')
  @HttpCode(204)
  async revoke(@Req() req: Request, @Param('id') id: string) {
    const p = await this.access.requireAccount(req);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(await this.accounts.revokeToken(p.accountId, id))) throw notFound('token');
  }

  @Post('auth/device')
  @HttpCode(200)
  async device(@Req() req: Request, @Body() body: { clientName?: unknown }) {
    const wait = this.limiter.take(`device:${req.ip ?? 'x'}`, 20);
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many requests', { 'Retry-After': String(wait) });
    return this.accounts.startDevice(typeof body?.clientName === 'string' ? body.clientName : undefined);
  }

  @Post('auth/device/token')
  @HttpCode(200)
  async deviceToken(@Body() body: { deviceCode?: unknown }) {
    if (typeof body?.deviceCode !== 'string') throw badRequest('invalid_request', 'deviceCode is required');
    return this.accounts.pollDevice(body.deviceCode);
  }

  @Post('auth/device/approve')
  @HttpCode(204)
  async approve(@Req() req: Request, @Body() body: { userCode?: unknown }) {
    const p = await this.access.requireAccount(req);
    if (typeof body?.userCode !== 'string') throw badRequest('invalid_request', 'userCode is required');
    await this.accounts.approveDevice(p.accountId, body.userCode);
  }

  @Get('admin/stats')
  async stats(@Req() req: Request) {
    const p = await this.access.requireAccount(req);
    if (!this.cfg.adminEmails.includes(p.email.toLowerCase())) throw forbidden('Admin only');
    const [accts] = await q<{ n: string }[]>(this.ds, 'SELECT count(*) AS n FROM account');
    const [subs] = await q<{ total: string; active: string; cold: string; anonymous: string; custom: string }[]>(
      this.ds,
      `SELECT count(*) AS total, count(*) FILTER (WHERE state='active') AS active, count(*) FILTER (WHERE state='cold') AS cold,
              count(*) FILTER (WHERE owner_id IS NULL) AS anonymous, count(*) FILTER (WHERE is_custom) AS custom FROM subdomain`,
    );
    const [reqs] = await q<{ total: string; hour: string }[]>(this.ds, `SELECT count(*) AS total, count(*) FILTER (WHERE received_at > now() - interval '1 hour') AS hour FROM captured_request`);
    let online = 0;
    for (const r of await q<{ id: string }[]>(this.ds, 'SELECT id FROM subdomain')) if (this.tunnels.isOnline(r.id)) online++;
    return {
      accounts: Number(accts.n),
      subdomains: { total: Number(subs.total), active: Number(subs.active), cold: Number(subs.cold), anonymous: Number(subs.anonymous), custom: Number(subs.custom) },
      tunnelsOnline: online,
      capturedRequests: Number(reqs.total),
      requestsLastHour: Number(reqs.hour),
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.APP_VERSION ?? '0.1.0',
    };
  }
}
