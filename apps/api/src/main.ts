import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/app-config.js';

try { process.loadEnvFile(); } catch { /* no .env file, use real env */ }

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule);
  if (cfg.trustProxy) (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', true);
  await app.listen(cfg.port);
}
await bootstrap();
