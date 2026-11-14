import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Accounts1731715200000 implements MigrationInterface {
  name = 'Accounts1731715200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE account (
      id uuid PRIMARY KEY,
      email text NOT NULL,
      display_name text NULL,
      plan text NOT NULL DEFAULT 'free',
      created_at timestamptz NOT NULL DEFAULT now(),
      disabled_at timestamptz NULL
    )`);
    await q.query(`CREATE UNIQUE INDEX account_email_idx ON account (lower(email))`);
    await q.query(`CREATE TABLE identity (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      provider text NOT NULL,
      subject text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, subject)
    )`);
    await q.query(`CREATE TABLE session (
      id text PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      user_agent text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX session_account_idx ON session (account_id)`);
    await q.query(`CREATE TABLE cli_token (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'nanana-cli',
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NULL,
      revoked_at timestamptz NULL
    )`);
    await q.query(`CREATE TABLE device_auth (
      device_code_hash text PRIMARY KEY,
      user_code text NOT NULL UNIQUE,
      account_id uuid NULL REFERENCES account(id) ON DELETE CASCADE,
      client_name text NOT NULL DEFAULT 'nanana-cli',
      status text NOT NULL DEFAULT 'pending',
      last_polled_at timestamptz NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE TABLE magic_link (
      token_hash text PRIMARY KEY,
      email text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`ALTER TABLE subdomain ADD CONSTRAINT subdomain_owner_fk FOREIGN KEY (owner_id) REFERENCES account(id) ON DELETE CASCADE`);
    await q.query(`CREATE INDEX subdomain_owner_idx ON subdomain (owner_id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE subdomain DROP CONSTRAINT subdomain_owner_fk`);
    for (const t of ['magic_link', 'device_auth', 'cli_token', 'session', 'identity', 'account']) await q.query(`DROP TABLE ${t}`);
  }
}
