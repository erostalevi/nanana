import { Module } from '@nestjs/common';
import { AdminController } from './admin/admin.controller.js';
import { MetricsService } from './admin/metrics.service.js';
import { ACCOUNT_RESOLVER, AccessService } from './auth/access.service.js';
import { AccountsService } from './auth/accounts.service.js';
import { AuthController } from './auth/auth.controller.js';
import { MailService } from './auth/mail.service.js';
import { OAuthService } from './auth/oauth.service.js';
import { BillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { PolarGateway } from './billing/polar.gateway.js';
import { DbModule } from './db/db.module.js';
import { EventsService } from './events/events.service.js';
import { HealthController } from './health/health.controller.js';
import { IngressService } from './ingress/ingress.service.js';
import { LifecycleService } from './lifecycle/lifecycle.service.js';
import { MocksService } from './mocks/mocks.service.js';
import { ReplayService } from './replay/replay.service.js';
import { RequestsController } from './requests/requests.controller.js';
import { RequestsService } from './requests/requests.service.js';
import { SubdomainsController } from './subdomains/subdomains.controller.js';
import { SubdomainsService } from './subdomains/subdomains.service.js';
import { TunnelGateway } from './tunnel/tunnel.gateway.js';
import { TunnelService } from './tunnel/tunnel.service.js';

@Module({
  imports: [DbModule],
  controllers: [HealthController, SubdomainsController, RequestsController, AuthController, BillingController, AdminController],
  providers: [
    MetricsService,
    EventsService,
    TunnelService,
    TunnelGateway,
    SubdomainsService,
    AccessService,
    MailService,
    AccountsService,
    OAuthService,
    PolarGateway,
    BillingService,
    { provide: ACCOUNT_RESOLVER, useExisting: AccountsService },
    MocksService,
    ReplayService,
    RequestsService,
    IngressService,
    LifecycleService,
  ],
})
export class AppModule {}
