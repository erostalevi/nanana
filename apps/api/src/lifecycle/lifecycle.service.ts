import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { q } from '../db/query.js';
import { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { COLD_AFTER_MS, DEAD_AFTER_MS } from '../config/plan-limits.js';
import { EventsService } from '../events/events.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import { SubdomainsService, type SubRow } from '../subdomains/subdomains.service.js';
import { TunnelService } from '../tunnel/tunnel.service.js';

@Injectable()
export class LifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Lifecycle');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(TunnelService) private readonly tunnels: TunnelService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.runJobs) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch (e) {
      this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    } finally {
      this.running = false;
    }
  }

  /** One lifecycle pass; exposed for tests. */
  async run(): Promise<{ cold: number; dead: number; evicted: number }> {
    const coldMs = COLD_AFTER_MS;
    const deadMs = DEAD_AFTER_MS;

    // 1. Hard-expired and idle-dead subdomains (tunnel-connected ones are not idle).
    const doomed = await q<SubRow[]>(this.ds, 
      `SELECT * FROM subdomain
       WHERE (hard_expires_at < now() AND (always_on_until IS NULL OR always_on_until < now()))
          OR (last_activity_at < now() - ($1 || ' milliseconds')::interval
              AND (always_on_until IS NULL OR always_on_until < now()))`,
      [String(deadMs)],
    );
    let dead = 0;
    for (const row of doomed) {
      const hardExpired = row.hard_expires_at.getTime() < Date.now();
      if (!hardExpired && this.tunnels.isOnline(row.id)) continue;
      await this.subs.remove(row, 'expired');
      dead++;
    }

    // 2. Active -> cold.
    const cooling = await q<SubRow[]>(this.ds, 
      `SELECT * FROM subdomain WHERE state = 'active' AND last_activity_at < now() - ($1 || ' milliseconds')::interval`,
      [String(coldMs)],
    );
    let cold = 0;
    for (const row of cooling) {
      if (this.tunnels.isOnline(row.id)) continue;
      await q(this.ds, `UPDATE subdomain SET state = 'cold' WHERE id = $1 AND state = 'active'`, [row.id]);
      this.events.emit(row.slug, 'subdomain.state', { state: 'cold', hardExpiresAt: row.hard_expires_at.toISOString() });
      cold++;
    }

    // 3. Retention by age (1 h) and housekeeping.
    const old = await q<{ id: string; slug: string }[]>(this.ds, 
      `DELETE FROM captured_request c USING subdomain s
       WHERE c.subdomain_id = s.id AND c.received_at < now() - interval '1 hour'
       RETURNING c.id, s.slug`,
    );
    for (const r of old) this.events.emit(r.slug, 'request.deleted', { id: r.id });
    await q(this.ds, 'DELETE FROM slug_tombstone WHERE until < now()');
    await this.accounts.cleanup();
    return { cold, dead, evicted: old.length };
  }
}
