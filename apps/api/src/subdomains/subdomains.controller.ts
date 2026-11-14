import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessService, bearer } from '../auth/access.service.js';
import { ApiError, badRequest, notFound, unauthorized } from '../common/errors.js';
import { sha256 } from '../common/crypto.js';
import { publicUrls, APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { MocksService } from '../mocks/mocks.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { EventsService } from '../events/events.service.js';
import { SubdomainsService } from './subdomains.service.js';

@Controller('subdomains')
export class SubdomainsController {
  constructor(
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RequestsService) private readonly requests: RequestsService,
    @Inject(MocksService) private readonly mocks: MocksService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Req() req: Request, @Body() body: { name?: unknown }) {
    const p = await this.access.principal(req);
    if (p.kind === 'sub') throw new ApiError(403, 'forbidden', 'Use an account or no auth to create subdomains');
    const name = body?.name;
    if (name !== undefined && typeof name !== 'string') throw badRequest('name_invalid', 'name must be a string');
    const ip = (req.ip ?? 'unknown').replace(/^::ffff:/, '');
    const { row, token } = await this.subs.create({
      ownerId: p.kind === 'account' ? p.accountId : null,
      plan: p.kind === 'account' ? p.plan : null,
      name,
      ip,
    });
    const subdomain = await this.subs.dto(row);
    return { subdomain, token, dashboardUrlWithToken: `${publicUrls(this.cfg, row.slug).dashboardUrl}/#t=${token}` };
  }

  @Get()
  async list(@Req() req: Request) {
    const a = await this.access.requireAccount(req);
    const rows = await this.subs.listByOwner(a.accountId);
    return { subdomains: await Promise.all(rows.map((r) => this.subs.dto(r))) };
  }

  @Get('_self')
  async self(@Req() req: Request) {
    const token = bearer(req);
    if (!token?.startsWith('nnt_')) throw unauthorized('A subdomain token is required');
    const row = await this.subs.getByTokenHash(sha256(token));
    if (!row) throw unauthorized('Invalid subdomain token');
    await this.subs.touch(row);
    return this.subs.dto(row);
  }

  @Get(':slug')
  async get(@Req() req: Request, @Param('slug') slug: string) {
    const row = await this.access.authorizeSub(req, slug);
    await this.subs.touch(row);
    return this.subs.dto(row);
  }

  @Patch(':slug')
  async patch(@Req() req: Request, @Param('slug') slug: string, @Body() body: Record<string, unknown>) {
    const row = await this.access.authorizeSub(req, slug);
    return this.subs.dto(await this.subs.patch(row, body ?? {}));
  }

  @Delete(':slug')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('slug') slug: string) {
    const row = await this.access.authorizeSub(req, slug);
    await this.subs.remove(row);
  }

  @Post(':slug/claim')
  async claim(@Req() req: Request, @Param('slug') slug: string, @Body() body: { token?: unknown }) {
    const a = await this.access.requireAccount(req);
    if (typeof body?.token !== 'string') throw badRequest('invalid_token', 'token is required');
    return this.subs.dto(await this.subs.claim(a.accountId, a.plan, slug, body.token));
  }

  @Post(':slug/renew')
  async renew(@Req() req: Request, @Param('slug') slug: string) {
    const a = await this.access.requireAccount(req);
    const row = await this.access.authorizeSub(req, slug);
    if (row.owner_id !== a.accountId) throw notFound('subdomain');
    return this.subs.dto(await this.subs.renew(row));
  }

  @Post(':slug/token')
  async rotate(@Req() req: Request, @Param('slug') slug: string) {
    const a = await this.access.requireAccount(req);
    const row = await this.access.authorizeSub(req, slug);
    if (row.owner_id !== a.accountId) throw notFound('subdomain');
    return { token: await this.subs.rotateToken(row) };
  }

  @Get(':slug/requests')
  async listRequests(
    @Req() req: Request,
    @Param('slug') slug: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('includePreflight') includePreflight?: string,
  ) {
    const row = await this.access.authorizeSub(req, slug);
    const n = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 100);
    if (before !== undefined && !/^[0-9a-f-]{36}$/i.test(before)) throw badRequest('invalid_before', 'before must be a request id');
    await this.subs.touch(row);
    return this.requests.list(row, { limit: n, before, includePreflight: includePreflight === 'true' });
  }

  @Post(':slug/mock')
  async setMock(@Req() req: Request, @Param('slug') slug: string, @Body() body: Record<string, unknown>) {
    const row = await this.access.authorizeSub(req, slug);
    return this.mocks.set(row, body ?? {});
  }

  @Delete(':slug/mock')
  @HttpCode(204)
  async clearMock(@Req() req: Request, @Param('slug') slug: string) {
    const row = await this.access.authorizeSub(req, slug);
    await this.mocks.clear(row);
  }

  @Get(':slug/stream')
  async stream(@Req() req: Request, @Res() res: Response, @Param('slug') slug: string) {
    const row = await this.access.authorizeSub(req, slug);
    await this.subs.touch(row);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('hello', await this.subs.dto(row));
    const sub = this.events.stream(slug).subscribe((e) => {
      write(e.event, e.data);
      if (e.event === 'subdomain.deleted') res.end();
    });
    const hb = setInterval(() => res.write(': ping\n\n'), 25_000);
    const touch = setInterval(() => {
      void this.subs.getBySlug(slug).then((r) => r && this.subs.touch(r));
    }, 60_000);
    req.on('close', () => {
      clearInterval(hb);
      clearInterval(touch);
      sub.unsubscribe();
    });
  }
}
