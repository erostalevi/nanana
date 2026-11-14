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
new Logger('Bootstrap').log(`nanana api listening on :${cfg.port} (base domain ${cfg.baseDomain})`);
