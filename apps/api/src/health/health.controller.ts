import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller()
export class HealthController {
  constructor(private readonly ds: DataSource) {}

  @Get('healthz')
  async healthz() {
    await this.ds.query('SELECT 1');
    return { ok: true };
  }
}
