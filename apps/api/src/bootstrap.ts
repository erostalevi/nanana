import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/app-config.js';
import { ApiExceptionFilter } from './common/errors.js';
import { isAllowedOrigin } from './common/origin.js';
import { IngressService } from './ingress/ingress.service.js';
import { TunnelGateway } from './tunnel/tunnel.gateway.js';

export async function createApp(): Promise<NestExpressApplication> {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  if (cfg.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');

  // 1. Webhook ingress: raw body, never touched by parsers.
  app.use(app.get(IngressService).middleware);

  // 2. CORS for the API (web app origins only, with credentials).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const o = req.headers.origin;
    if (o && isAllowedOrigin(cfg, o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  // Stripe webhooks need the exact raw bytes for signature verification.
  app.use('/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }));

  // 3. JSON bodies for the API only.
  const json = express.json({ limit: '1mb' });
  app.use((req: Request, res: Response, next: NextFunction) =>
    json(req, res, (err?: unknown) => {
      if (!err) return next();
      const e = err as { type?: string };
      const tooLarge = e.type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({ error: { code: tooLarge ? 'payload_too_large' : 'invalid_json', message: tooLarge ? 'Payload too large' : 'Invalid JSON body' } });
    }),
  );

  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.init();
  app.get(TunnelGateway).attach(app.getHttpServer());
  return app;
}
