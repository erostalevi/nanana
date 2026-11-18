import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config/app-config.js';

try {
  process.loadEnvFile();
} catch {
  /* no .env file, use real env */
}

const cfg = loadConfig();
const app = await createApp();
await app.listen(cfg.port);
// Caddy keeps upstream connections idle for 120 s. Node's default keep-alive timeout is 5 s, so Node closed them under Caddy,
// forcing a fresh dial (and a DNS lookup) per request under load. Stay longer than the proxy; headersTimeout must exceed it.
const server = app.getHttpServer() as { keepAliveTimeout: number; headersTimeout: number };
server.keepAliveTimeout = 130_000;
server.headersTimeout = 135_000;
new Logger('Bootstrap').log(`nanana api listening on :${cfg.port} (base domain ${cfg.baseDomain})`);
