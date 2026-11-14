import { Module } from '@nestjs/common';
import { AccessService } from './auth/access.service.js';
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
  controllers: [HealthController, SubdomainsController, RequestsController],
  providers: [
    EventsService,
    TunnelService,
    TunnelGateway,
    SubdomainsService,
    AccessService,
    MocksService,
    ReplayService,
    RequestsService,
    IngressService,
    LifecycleService,
  ],
})
export class AppModule {}
