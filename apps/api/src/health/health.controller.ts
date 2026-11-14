import { Controller, Get, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller()
export class HealthController {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  @Get('healthz')
  async healthz() {
    await this.ds.query('SELECT 1');
    return { ok: true };
  }

  @Get('version')
  version() {
    return { version: process.env.APP_VERSION ?? '0.1.0', minCliProtocol: 1 };
  }
}
