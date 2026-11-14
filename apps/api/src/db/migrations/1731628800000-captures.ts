import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Captures1731628800000 implements MigrationInterface {
  name = 'Captures1731628800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE subdomain
      ADD COLUMN hard_expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
      ADD COLUMN renewed_at timestamptz NULL`);
    await q.query(`CREATE INDEX subdomain_hard_expires_idx ON subdomain (hard_expires_at)`);
    await q.query(`CREATE TABLE slug_tombstone (
      slug text PRIMARY KEY,
      owner_id uuid NULL,
      until timestamptz NOT NULL
    )`);
    // UNLOGGED: never written to WAL, so captured payloads never reach backups.
    await q.query(`CREATE UNLOGGED TABLE captured_request (
      id uuid PRIMARY KEY,
      subdomain_id uuid NOT NULL REFERENCES subdomain(id) ON DELETE CASCADE,
      method text NOT NULL,
      path text NOT NULL,
      headers jsonb NOT NULL,
      body bytea NOT NULL,
      body_size int NOT NULL,
      content_type text NULL,
      source_ip text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      answered_by text NULL,
      response_status int NULL,
      response_headers jsonb NULL,
      response_body bytea NULL,
      response_truncated boolean NOT NULL DEFAULT false,
      latency_ms int NULL,
      forward_error text NULL,
      is_preflight boolean NOT NULL DEFAULT false,
      mocked boolean NOT NULL DEFAULT false
    )`);
    await q.query(`CREATE INDEX captured_request_sub_idx ON captured_request (subdomain_id, id DESC)`);
    await q.query(`CREATE INDEX captured_request_received_idx ON captured_request (received_at)`);
    await q.query(`CREATE UNLOGGED TABLE replay (
      id uuid PRIMARY KEY,
      request_id uuid NOT NULL REFERENCES captured_request(id) ON DELETE CASCADE,
      target_type text NOT NULL,
      target_url text NULL,
      status int NULL,
      response_headers jsonb NULL,
      response_body bytea NULL,
      truncated boolean NOT NULL DEFAULT false,
      error text NULL,
      duration_ms int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX replay_request_idx ON replay (request_id, created_at)`);
    await q.query(`CREATE UNLOGGED TABLE mock_rule (
      id uuid PRIMARY KEY,
      subdomain_id uuid NOT NULL UNIQUE REFERENCES subdomain(id) ON DELETE CASCADE,
      status int NOT NULL,
      headers jsonb NOT NULL DEFAULT '{}'::jsonb,
      body text NOT NULL DEFAULT '',
      remaining int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE mock_rule`);
    await q.query(`DROP TABLE replay`);
    await q.query(`DROP TABLE captured_request`);
    await q.query(`DROP TABLE slug_tombstone`);
    await q.query(`ALTER TABLE subdomain DROP COLUMN hard_expires_at, DROP COLUMN renewed_at`);
  }
}
