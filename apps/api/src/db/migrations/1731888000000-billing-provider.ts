import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Billing moved from Stripe to Polar: provider-neutral column and table names. */
export class BillingProvider1731888000000 implements MigrationInterface {
  name = 'BillingProvider1731888000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE subscription RENAME COLUMN stripe_customer_id TO provider_customer_id');
    await q.query('ALTER TABLE subscription RENAME COLUMN stripe_subscription_id TO provider_subscription_id');
    await q.query('ALTER TABLE stripe_event RENAME TO webhook_event');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE webhook_event RENAME TO stripe_event');
    await q.query('ALTER TABLE subscription RENAME COLUMN provider_subscription_id TO stripe_subscription_id');
    await q.query('ALTER TABLE subscription RENAME COLUMN provider_customer_id TO stripe_customer_id');
  }
}
