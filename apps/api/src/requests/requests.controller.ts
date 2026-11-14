import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { q } from '../db/query.js';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { AccessService } from '../auth/access.service.js';
import { badRequest, notFound } from '../common/errors.js';
import { EventsService } from '../events/events.service.js';
import { ReplayService } from '../replay/replay.service.js';
import { RequestsService } from './requests.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('requests')
export class RequestsController {
  constructor(
    @Inject(RequestsService) private readonly requests: RequestsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(ReplayService) private readonly replays: ReplayService,
  ) {}

  private async resolve(req: Request, id: string) {
    if (!UUID.test(id)) throw badRequest('invalid_id', 'Invalid request id');
    const rows = await q<{ subdomain_id: string }[]>(this.ds, 'SELECT subdomain_id FROM captured_request WHERE id = $1', [id]);
    if (!rows[0]) {
      await this.access.principal(req); // keep 401 vs 404 behaviour consistent
      throw notFound('request');
    }
    return this.access.authorizeSubById(req, rows[0].subdomain_id);
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const sub = await this.resolve(req, id);
    const d = await this.requests.detail(sub, id);
    if (!d) throw notFound('request');
    return d;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string) {
    const sub = await this.resolve(req, id);
    if (await this.requests.remove(sub, id)) this.events.emit(sub.slug, 'request.deleted', { id });
  }

  @Post(':id/replay')
  @HttpCode(201)
  async replay(@Req() req: Request, @Param('id') id: string, @Body() body: { target?: unknown; overrideHeaders?: unknown }) {
    const sub = await this.resolve(req, id);
    const target = this.replays.parseTarget(body?.target);
    return this.replays.replay(sub, id, target, body?.overrideHeaders);
  }
}
