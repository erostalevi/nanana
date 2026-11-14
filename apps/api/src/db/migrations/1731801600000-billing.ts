import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Billing1731801600000 implements MigrationInterface {
  name = 'Billing1731801600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE subscription (
      account_id uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
      stripe_customer_id text NULL UNIQUE,
      stripe_subscription_id text NULL UNIQUE,
      status text NOT NULL DEFAULT 'none',
      interval text NULL,
      current_period_end timestamptz NULL,
      cancel_at_period_end boolean NOT NULL DEFAULT false,
      grace_until timestamptz NULL,
      lapsed_until timestamptz NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE TABLE stripe_event (
      id text PRIMARY KEY,
      type text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE stripe_event');
    await q.query('DROP TABLE subscription');
  }
}
