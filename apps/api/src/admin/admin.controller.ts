import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { AccessService } from '../auth/access.service.js';
import { forbidden } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PRICES } from '../config/plan-limits.js';
import { q } from '../db/query.js';
import { TunnelService } from '../tunnel/tunnel.service.js';
import { MetricsService } from './metrics.service.js';

const MB = 1024 * 1024;
const DATA_VOLUME_MB = 10240; // the EBS data volume Postgres lives on (see infra/compute.tf)

async function memAvailableMb(): Promise<number> {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(await readFile('/proc/meminfo', 'utf8'));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {
    /* not Linux */
  }
  return Math.round(os.freemem() / MB);
}

@Controller('admin')
export class AdminController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(TunnelService) private readonly tunnels: TunnelService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Get('stats')
  async stats(@Req() req: Request) {
    const p = await this.access.requireAccount(req);
    if (!this.cfg.adminEmails.includes(p.email.toLowerCase())) throw forbidden('Admin only');
    const n = (v: unknown) => Number(v ?? 0);

    const [accts] = await q<{ n: string; day: string; week: string }[]>(
      this.ds,
      `SELECT count(*) AS n, count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS day,
              count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week FROM account`,
    );
    const planRows = await q<{ plan: string; n: string }[]>(this.ds, 'SELECT plan, count(*) AS n FROM account GROUP BY plan');
    const plans = { free: 0, pro: 0, pro_grace: 0, lapsed: 0 } as Record<string, number>;
    for (const r of planRows) plans[r.plan] = n(r.n);

    const [subs] = await q<{ total: string; active: string; cold: string; anonymous: string; custom: string; created24: string }[]>(
      this.ds,
      `SELECT count(*) AS total, count(*) FILTER (WHERE state='active') AS active, count(*) FILTER (WHERE state='cold') AS cold,
              count(*) FILTER (WHERE owner_id IS NULL) AS anonymous, count(*) FILTER (WHERE is_custom) AS custom,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS created24 FROM subdomain`,
    );
    const [reqs] = await q<{ total: string; hour: string }[]>(
      this.ds,
      `SELECT count(*) AS total, count(*) FILTER (WHERE received_at > now() - interval '1 hour') AS hour FROM captured_request`,
    );
    const top = await q<{ slug: string; n: string }[]>(
      this.ds,
      `SELECT s.slug, count(*) AS n FROM captured_request r JOIN subdomain s ON s.id = r.subdomain_id
       WHERE r.received_at > now() - interval '1 hour' GROUP BY s.slug ORDER BY n DESC LIMIT 5`,
    );

    // revenue, estimated from our own subscription table (Polar remains the source of truth for money actually collected)
    const [rev] = await q<{ monthly: string; yearly: string; past_due: string; canceling: string }[]>(
      this.ds,
      `SELECT count(*) FILTER (WHERE s.status IN ('active','past_due') AND s.interval = 'month') AS monthly,
              count(*) FILTER (WHERE s.status IN ('active','past_due') AND s.interval = 'year') AS yearly,
              count(*) FILTER (WHERE s.status = 'past_due') AS past_due,
              count(*) FILTER (WHERE s.status = 'active' AND s.cancel_at_period_end) AS canceling
       FROM subscription s JOIN account a ON a.id = s.account_id WHERE a.plan IN ('pro','pro_grace')`,
    );
    const mrrCents = Math.round(n(rev.monthly) * PRICES.monthlyCents + (n(rev.yearly) * PRICES.yearlyCents) / 12);

    // health
    const t0 = Date.now();
    const [db] = await q<{ size: string; conns: string; table_size: string }[]>(
      this.ds,
      `SELECT pg_database_size(current_database()) AS size,
              (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS conns,
              pg_total_relation_size('captured_request') AS table_size`,
    );
    const dbPingMs = Date.now() - t0;
    const mem = process.memoryUsage();
    const series = this.metrics.series();
    const last60s = series[series.length - 1];
    const prev = series[series.length - 2];
    const lastFive = series.slice(-5);
    const perMinNow = last60s.captured + prev.captured; // two buckets so the current partial minute does not read as a dip
    const latencyWeighted = series.slice(-10).reduce((a, b) => a + b.avgLatencyMs * b.captured, 0);
    const latencyCount = series.slice(-10).reduce((a, b) => a + b.captured, 0);

    let online = 0;
    for (const r of await q<{ id: string }[]>(this.ds, 'SELECT id FROM subdomain')) if (this.tunnels.isOnline(r.id)) online++;
    const cpus = os.cpus().length;
    const load1 = os.loadavg()[0];
    const loop = this.metrics.eventLoop();

    return {
      accounts: n(accts.n),
      subdomains: { total: n(subs.total), active: n(subs.active), cold: n(subs.cold), anonymous: n(subs.anonymous), custom: n(subs.custom) },
      tunnelsOnline: online,
      capturedRequests: n(reqs.total),
      requestsLastHour: n(reqs.hour),
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.APP_VERSION ?? '0.1.0',
      // ---- richer overview (additive) ----
      generatedAt: new Date().toISOString(),
      traffic: {
        since: new Date(this.metrics.startedAt).toISOString(), // counters reset when the API restarts
        series,
        perMinuteNow: Math.round(perMinNow / 2),
        lastFiveMinutes: lastFive.reduce((a, b) => a + b.captured, 0),
        lastHour: series.reduce((a, b) => a + b.captured, 0),
        rejectedLastHour: series.reduce((a, b) => a + b.rejected, 0),
        tunneledLastHour: series.reduce((a, b) => a + b.tunneled, 0),
        avgLatencyMs: latencyCount ? Math.round(latencyWeighted / latencyCount) : 0,
        topEndpoints: top.map((r) => ({ slug: r.slug, requests: n(r.n) })),
      },
      growth: { signups24h: n(accts.day), signups7d: n(accts.week), endpointsCreated24h: n(subs.created24), plans },
      revenue: {
        currency: PRICES.currency,
        mrrCents,
        arrCents: mrrCents * 12,
        payingSubscribers: n(rev.monthly) + n(rev.yearly),
        monthly: n(rev.monthly),
        yearly: n(rev.yearly),
        pastDue: n(rev.past_due),
        cancelingAtPeriodEnd: n(rev.canceling),
        billingEnabled: this.cfg.polarAccessToken !== '' && this.cfg.polarProductMonthly !== '',
      },
      health: {
        cpus,
        load1: Math.round(load1 * 100) / 100,
        loadPct: Math.round((load1 / cpus) * 100),
        memAvailableMb: await memAvailableMb(),
        memTotalMb: Math.round(os.totalmem() / MB),
        apiRssMb: Math.round(mem.rss / MB),
        apiHeapMb: Math.round(mem.heapUsed / MB),
        eventLoopP99Ms: loop.p99Ms,
        eventLoopMaxMs: loop.maxMs,
        db: {
          pingMs: dbPingMs,
          sizeMb: Math.round(n(db.size) / MB),
          capturesMb: Math.round(n(db.table_size) / MB),
          connections: n(db.conns),
          volumeMb: DATA_VOLUME_MB,
        },
      },
    };
  }
}
