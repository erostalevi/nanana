import { Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { DataSource } from 'typeorm';
import { ApiError, badRequest } from '../common/errors.js';
import { q } from '../db/query.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { GRACE_DAYS, LAPSED_READ_ONLY_DAYS, isProLike, limitsFor } from '../config/plan-limits.js';
import { StripeGateway } from './stripe.gateway.js';

export interface SubscriptionRow {
  account_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
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
    @Inject(StripeGateway) private readonly stripe: StripeGateway,
  ) {}

  get enabled(): boolean {
    return this.stripe.enabled;
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

  private async customerFor(accountId: string, email: string): Promise<string> {
    const row = await this.get(accountId);
    if (row?.stripe_customer_id) return row.stripe_customer_id;
    const id = await this.stripe.createCustomer(email, accountId);
    await q(
      this.ds,
      `INSERT INTO subscription (account_id, stripe_customer_id) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
      [accountId, id],
    );
    return id;
  }

  async checkout(account: { accountId: string; email: string; plan: string }, interval: unknown): Promise<string> {
    this.requireEnabled();
    if (interval !== 'month' && interval !== 'year') throw badRequest('invalid_interval', 'interval must be "month" or "year"');
    if (isProLike(account.plan)) throw new ApiError(409, 'already_subscribed', 'This account already has an active Pro subscription');
    const customer = await this.customerFor(account.accountId, account.email);
    return this.stripe.createCheckoutUrl({
      customer,
      accountId: account.accountId,
      priceId: interval === 'month' ? this.cfg.stripePriceMonthly : this.cfg.stripePriceYearly,
    });
  }

  async portal(accountId: string): Promise<string> {
    this.requireEnabled();
    const row = await this.get(accountId);
    if (!row?.stripe_customer_id) throw new ApiError(409, 'no_customer', 'No billing profile yet: subscribe first');
    return this.stripe.createPortalUrl(row.stripe_customer_id);
  }

  // ---- webhook -----------------------------------------------------------------------
  /** Verifies and applies a Stripe event. Idempotent by event id. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
    if (!this.cfg.stripeWebhookSecret) throw new ApiError(404, 'billing_disabled', 'Billing is not enabled');
    if (!signature) throw badRequest('invalid_signature', 'Missing Stripe-Signature header');
    let event: Stripe.Event;
    try {
      event = this.stripe.constructEvent(rawBody, signature);
    } catch {
      throw badRequest('invalid_signature', 'Invalid Stripe signature');
    }
    const fresh = await q<{ id: string }[]>(this.ds, 'INSERT INTO stripe_event (id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id', [event.id, event.type]);
    if (!fresh.length) return; // already processed
    try {
      await this.apply(event);
    } catch (e) {
      await q(this.ds, 'DELETE FROM stripe_event WHERE id = $1', [event.id]); // let Stripe retry
      throw e;
    }
  }

  private async apply(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const accountId = s.client_reference_id;
        const customer = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
        if (!accountId || !customer || !subId) return;
        await q(
          this.ds,
          `INSERT INTO subscription (account_id, stripe_customer_id, stripe_subscription_id) VALUES ($1,$2,$3)
           ON CONFLICT (account_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id`,
          [accountId, customer, subId],
        );
        await this.syncSubscription(await this.stripe.retrieveSubscription(subId));
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.syncSubscription(event.data.object as Stripe.Subscription);
        return;
      default:
        return;
    }
  }

  private async accountIdFor(sub: Stripe.Subscription): Promise<string | null> {
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const byCustomer = await q<{ account_id: string }[]>(this.ds, 'SELECT account_id FROM subscription WHERE stripe_customer_id = $1', [customer]);
    if (byCustomer[0]) return byCustomer[0].account_id;
    const meta = sub.metadata?.accountId;
    if (meta) {
      const ok = await q<{ id: string }[]>(this.ds, 'SELECT id FROM account WHERE id = $1', [meta]);
      if (ok[0]) {
        await q(this.ds, `INSERT INTO subscription (account_id, stripe_customer_id) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`, [meta, customer]);
        return meta;
      }
    }
    return null;
  }

  /** Maps a Stripe subscription onto our plan state machine. */
  async syncSubscription(sub: Stripe.Subscription): Promise<void> {
    const accountId = await this.accountIdFor(sub);
    if (!accountId) {
      this.log.warn(`subscription ${sub.id} has no matching account`);
      return;
    }
    const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
    const periodEndUnix = item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
    const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
    const interval = (item?.price?.recurring?.interval === 'year' ? 'year' : item?.price?.recurring?.interval === 'month' ? 'month' : null) as 'month' | 'year' | null;
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
      `INSERT INTO subscription (account_id, stripe_customer_id, stripe_subscription_id, status, interval, current_period_end, cancel_at_period_end, grace_until, lapsed_until, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (account_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         status = EXCLUDED.status, interval = EXCLUDED.interval, current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end, grace_until = EXCLUDED.grace_until, lapsed_until = EXCLUDED.lapsed_until, updated_at = now()`,
      [accountId, typeof sub.customer === 'string' ? sub.customer : sub.customer.id, sub.id, status, interval, periodEnd, !!sub.cancel_at_period_end, graceUntil, lapsedUntil],
    );
    await q(this.ds, 'UPDATE account SET plan = $2 WHERE id = $1', [accountId, newPlan]);
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
