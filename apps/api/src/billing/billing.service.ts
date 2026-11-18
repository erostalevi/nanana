import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiError, badRequest } from '../common/errors.js';
import { q } from '../db/query.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { GRACE_DAYS, LAPSED_READ_ONLY_DAYS, isProLike, limitsFor } from '../config/plan-limits.js';
import { SubdomainsService } from '../subdomains/subdomains.service.js';
import { PolarGateway, type PolarEvent, type PolarSubscription } from './polar.gateway.js';

export interface SubscriptionRow {
  account_id: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  status: 'none' | 'active' | 'past_due' | 'canceled';
  interval: 'month' | 'year' | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  grace_until: Date | null;
  lapsed_until: Date | null;
}

export const billingDto = (enabled: boolean, s?: SubscriptionRow | null) => ({
  enabled,
  status: s?.status ?? 'none',
  interval: s?.interval ?? null,
  currentPeriodEnd: s?.current_period_end?.toISOString() ?? null,
  cancelAtPeriodEnd: s?.cancel_at_period_end ?? false,
  graceUntil: s?.grace_until?.toISOString() ?? null,
  lapsedUntil: s?.lapsed_until?.toISOString() ?? null,
});

@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');

  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PolarGateway) private readonly polar: PolarGateway,
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
  ) {}

  get enabled(): boolean {
    return this.polar.enabled;
  }

  async get(accountId: string): Promise<SubscriptionRow | null> {
    return (await q<SubscriptionRow[]>(this.ds, 'SELECT * FROM subscription WHERE account_id = $1', [accountId]))[0] ?? null;
  }

  async status(accountId: string) {
    return billingDto(this.enabled, await this.get(accountId));
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new ApiError(404, 'billing_disabled', 'Billing is not enabled');
  }

  async checkout(account: { accountId: string; email: string; plan: string }, interval: unknown): Promise<string> {
    this.requireEnabled();
    if (interval !== 'month' && interval !== 'year') throw badRequest('invalid_interval', 'interval must be "month" or "year"');
    if (isProLike(account.plan)) throw new ApiError(409, 'already_subscribed', 'This account already has an active Pro subscription');
    return this.polar.createCheckoutUrl({
      accountId: account.accountId,
      email: account.email,
      productId: interval === 'month' ? this.cfg.polarProductMonthly : this.cfg.polarProductYearly,
    });
  }

  async portal(accountId: string): Promise<string> {
    this.requireEnabled();
    const row = await this.get(accountId);
    if (!row?.provider_customer_id) throw new ApiError(409, 'no_customer', 'No billing profile yet: subscribe first');
    return this.polar.createPortalUrl(accountId);
  }

  // ---- webhook -----------------------------------------------------------------------
  /** Verifies and applies a Polar event. Idempotent by delivery id (`webhook-id`). */
  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<void> {
    if (!this.cfg.polarWebhookSecret) throw new ApiError(404, 'billing_disabled', 'Billing is not enabled');
    let event: PolarEvent;
    try {
      event = this.polar.verifyEvent(rawBody, headers);
    } catch {
      throw badRequest('invalid_signature', 'Invalid webhook signature');
    }
    const fresh = await q<{ id: string }[]>(this.ds, 'INSERT INTO webhook_event (id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id', [event.id, event.type]);
    if (!fresh.length) return; // already processed
    try {
      await this.apply(event);
    } catch (e) {
      await q(this.ds, 'DELETE FROM webhook_event WHERE id = $1', [event.id]); // let Polar retry
      throw e;
    }
  }

  private async apply(event: PolarEvent): Promise<void> {
    if (event.type.startsWith('subscription.')) await this.syncSubscription(event.data as PolarSubscription);
  }

  private async accountIdFor(sub: PolarSubscription): Promise<string | null> {
    const customer = sub.customer?.id ?? sub.customer_id;
    const byCustomer = await q<{ account_id: string }[]>(this.ds, 'SELECT account_id FROM subscription WHERE provider_customer_id = $1', [customer]);
    if (byCustomer[0]) return byCustomer[0].account_id;
    const ext = sub.customer?.external_id ?? (typeof sub.metadata?.accountId === 'string' ? sub.metadata.accountId : null);
    if (ext && /^[0-9a-f-]{36}$/i.test(ext)) {
      const ok = await q<{ id: string }[]>(this.ds, 'SELECT id FROM account WHERE id = $1', [ext]);
      if (ok[0]) {
        await q(this.ds, `INSERT INTO subscription (account_id, provider_customer_id) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET provider_customer_id = EXCLUDED.provider_customer_id`, [ext, customer]);
        return ext;
      }
    }
    return null;
  }

  /** Maps a Polar subscription onto our plan state machine. */
  async syncSubscription(sub: PolarSubscription): Promise<void> {
    const accountId = await this.accountIdFor(sub);
    if (!accountId) {
      this.log.warn(`subscription ${sub.id} has no matching account`);
      return;
    }
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
    const interval = (sub.recurring_interval === 'year' ? 'year' : sub.recurring_interval === 'month' ? 'month' : null) as 'month' | 'year' | null;
    const customerId = sub.customer?.id ?? sub.customer_id;
    const current = await q<{ plan: string }[]>(this.ds, 'SELECT plan FROM account WHERE id = $1', [accountId]);
    const plan = current[0]?.plan ?? 'free';

    let status: SubscriptionRow['status'];
    let newPlan: string;
    let graceUntil: Date | null = null;
    let lapsedUntil: Date | null = null;
    const existing = await this.get(accountId);

    switch (sub.status) {
      case 'active':
      case 'trialing':
        status = 'active';
        newPlan = 'pro';
        break;
      case 'past_due':
      case 'unpaid':
        status = 'past_due';
        newPlan = 'pro_grace';
        graceUntil = existing?.grace_until ?? new Date(Date.now() + GRACE_DAYS * 86400_000);
        break;
      case 'canceled':
      case 'incomplete_expired':
        status = 'canceled';
        if (isProLike(plan)) {
          newPlan = 'lapsed';
          lapsedUntil = new Date(Date.now() + LAPSED_READ_ONLY_DAYS * 86400_000);
        } else {
          newPlan = plan; // already lapsed or free: keep
          lapsedUntil = existing?.lapsed_until ?? null;
        }
        break;
      default:
        return; // incomplete / paused: no change
    }

    await q(
      this.ds,
      `INSERT INTO subscription (account_id, provider_customer_id, provider_subscription_id, status, interval, current_period_end, cancel_at_period_end, grace_until, lapsed_until, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (account_id) DO UPDATE SET provider_customer_id = EXCLUDED.provider_customer_id, provider_subscription_id = EXCLUDED.provider_subscription_id,
         status = EXCLUDED.status, interval = EXCLUDED.interval, current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end, grace_until = EXCLUDED.grace_until, lapsed_until = EXCLUDED.lapsed_until, updated_at = now()`,
      [accountId, customerId, sub.id, status, interval, periodEnd, !!sub.cancel_at_period_end, graceUntil, lapsedUntil],
    );
    await q(this.ds, 'UPDATE account SET plan = $2 WHERE id = $1', [accountId, newPlan]);
    this.subs.invalidateAll(); // the webhook endpoint lookup cache holds the owner's plan
  }

  // ---- periodic transitions (called from the lifecycle tick) -----------------------
  async housekeeping(): Promise<{ lapsed: number; downgraded: number }> {
    // Grace expired and still unpaid: lapse (read-only for 30 days).
    const lapse = await q<{ account_id: string }[]>(
      this.ds,
      `UPDATE subscription s SET lapsed_until = now() + ($1 || ' days')::interval, status = 'canceled', updated_at = now()
       FROM account a WHERE a.id = s.account_id AND a.plan = 'pro_grace' AND s.grace_until IS NOT NULL AND s.grace_until < now()
       RETURNING s.account_id`,
      [String(LAPSED_READ_ONLY_DAYS)],
    );
    for (const r of lapse) await q(this.ds, `UPDATE account SET plan = 'lapsed' WHERE id = $1`, [r.account_id]);
    if (lapse.length) this.subs.invalidateAll();

    // Read-only window over: back to free rules.
    const done = await q<{ account_id: string }[]>(
      this.ds,
      `SELECT s.account_id FROM subscription s JOIN account a ON a.id = s.account_id
       WHERE a.plan = 'lapsed' AND s.lapsed_until IS NOT NULL AND s.lapsed_until < now()`,
    );
    for (const r of done) await this.downgradeToFree(r.account_id);
    return { lapsed: lapse.length, downgraded: done.length };
  }

  /** Free rules apply again: release reserved names, restart expiry clocks, queue extra endpoints for removal. */
  async downgradeToFree(accountId: string): Promise<void> {
    const free = limitsFor('free');
    await q(this.ds, `UPDATE account SET plan = 'free' WHERE id = $1`, [accountId]);
    this.subs.invalidateAll();
    await q(this.ds, `UPDATE subscription SET lapsed_until = NULL, grace_until = NULL WHERE account_id = $1`, [accountId]);
    await q(this.ds, `UPDATE slug_tombstone SET until = now() + interval '7 days' WHERE owner_id = $1 AND until = 'infinity'`, [accountId]);
    await q(this.ds, `UPDATE subdomain SET state = 'active', last_activity_at = now(), hard_expires_at = now() + interval '7 days', renewed_at = NULL WHERE owner_id = $1`, [accountId]);
    // Endpoints beyond the free limit (keep the most recently active ones) expire in 3 days.
    await q(
      this.ds,
      `UPDATE subdomain SET hard_expires_at = now() + interval '3 days'
       WHERE id IN (SELECT id FROM subdomain WHERE owner_id = $1 ORDER BY created_at DESC OFFSET $2)`,
      [accountId, free.maxActiveSubdomains],
    );
  }
}
