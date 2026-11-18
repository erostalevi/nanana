import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from '../auth/access.service.js';
import { badRequest } from '../common/errors.js';
import { PRICES, limitsFor } from '../config/plan-limits.js';
import { limitsDto } from '../auth/limits.js';
import { BillingService } from './billing.service.js';

@Controller('billing')
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  @Get('plans')
  plans() {
    return {
      enabled: this.billing.enabled,
      currency: PRICES.currency,
      plans: [
        { id: 'free', name: 'Free', priceMonthlyCents: 0, priceYearlyCents: null, limits: limitsDto(limitsFor('free')) },
        { id: 'pro', name: 'Pro', priceMonthlyCents: PRICES.monthlyCents, priceYearlyCents: PRICES.yearlyCents, limits: limitsDto(limitsFor('pro')) },
      ],
    };
  }

  @Get()
  async status(@Req() req: Request) {
    const a = await this.access.requireAccount(req);
    return { plan: a.plan, ...(await this.billing.status(a.accountId)) };
  }

  @Post('checkout')
  @HttpCode(200)
  async checkout(@Req() req: Request, @Body() body: { interval?: unknown }) {
    const a = await this.access.requireAccount(req);
    return { url: await this.billing.checkout(a, body?.interval) };
  }

  @Post('portal')
  @HttpCode(200)
  async portal(@Req() req: Request) {
    const a = await this.access.requireAccount(req);
    return { url: await this.billing.portal(a.accountId) };
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: Request) {
    if (!Buffer.isBuffer(req.body)) throw badRequest('invalid_body', 'Expected a raw body');
    await this.billing.handleWebhook(req.body, req.headers);
    return { received: true };
  }
}
