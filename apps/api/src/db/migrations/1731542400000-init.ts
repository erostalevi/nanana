import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1731542400000 implements MigrationInterface {
  name = 'Init1731542400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE subdomain (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      owner_id uuid NULL,
      is_custom boolean NOT NULL DEFAULT false,
      token_hash text NOT NULL,
      state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','cold')),
      last_activity_at timestamptz NOT NULL DEFAULT now(),
      offline_status int NOT NULL DEFAULT 200,
      offline_body text NOT NULL DEFAULT '{"ok":true}',
      hmac_secret_enc text NULL,
      hmac_header text NULL,
      hmac_algo text NOT NULL DEFAULT 'sha256',
      created_ip_hash text NULL,
      always_on_until timestamptz NULL,
      reserved_until timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX subdomain_last_activity_idx ON subdomain (last_activity_at)`);
    await q.query(`CREATE INDEX subdomain_created_ip_idx ON subdomain (created_ip_hash, created_at)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE subdomain`);
  }
}
