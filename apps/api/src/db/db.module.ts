import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG, loadConfig } from '../config/app-config.js';
import { Subdomain } from '../subdomains/subdomain.entity.js';
import { Init1731542400000 } from './migrations/1731542400000-init.js';
import { Captures1731628800000 } from './migrations/1731628800000-captures.js';
import { Accounts1731715200000 } from './migrations/1731715200000-accounts.js';

export const entities = [Subdomain];
export const migrations = [Init1731542400000, Captures1731628800000, Accounts1731715200000];

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres' as const,
        url: loadConfig().databaseUrl,
        entities,
        migrations,
        migrationsRun: true,
        synchronize: false,
      }),
    }),
  ],
})
export class DbModule {}
