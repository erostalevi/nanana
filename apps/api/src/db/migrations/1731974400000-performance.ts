import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Storage tuning for the capture tables.
 * - Bodies and headers are stored uncompressed (EXTERNAL): the default compresses anything over 2 KB with pglz, which costs
 *   CPU on every insert for little gain on a disk that is mostly empty.
 * - Lower fill factor leaves room on the page so the response UPDATE stays on the same page (HOT) instead of bloating the heap.
 * - Aggressive autovacuum: these tables churn constantly (retention deletes most rows within the hour).
 * - The received_at index is dropped: it was maintained on every insert and only the once-a-minute age sweep used it.
 *
 * Operational notes: every statement here is metadata-only (SET STORAGE and SET (reloptions) never rewrite the table, they only
 * apply to rows and pages written afterwards; DROP INDEX is instant). They do need a short ACCESS EXCLUSIVE lock, so the migration
 * (which runs in one transaction at API start) uses a lock_timeout: it fails the boot, and the container restarts, instead of
 * queueing behind a long query and blocking every request on the table behind it.
 */
export class Performance1731974400000 implements MigrationInterface {
  name = 'Performance1731974400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '10s'`);
    await q.query('ALTER TABLE captured_request ALTER COLUMN body SET STORAGE EXTERNAL');
    await q.query('ALTER TABLE captured_request ALTER COLUMN response_body SET STORAGE EXTERNAL');
    await q.query('ALTER TABLE captured_request ALTER COLUMN headers SET STORAGE EXTERNAL');
    await q.query('ALTER TABLE captured_request ALTER COLUMN response_headers SET STORAGE EXTERNAL');
    await q.query(
      'ALTER TABLE captured_request SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 100, autovacuum_analyze_scale_factor = 0.05)',
    );
    await q.query('ALTER TABLE subdomain SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 50)');
    await q.query('ALTER TABLE mock_rule SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 50)');
    await q.query('DROP INDEX IF EXISTS captured_request_received_idx');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '10s'`);
    await q.query('CREATE INDEX IF NOT EXISTS captured_request_received_idx ON captured_request (received_at)');
    await q.query('ALTER TABLE mock_rule RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold)');
    await q.query('ALTER TABLE subdomain RESET (fillfactor, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold)');
    await q.query('ALTER TABLE captured_request RESET (fillfactor, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor)');
    await q.query('ALTER TABLE captured_request ALTER COLUMN response_headers SET STORAGE EXTENDED');
    await q.query('ALTER TABLE captured_request ALTER COLUMN headers SET STORAGE EXTENDED');
    await q.query('ALTER TABLE captured_request ALTER COLUMN response_body SET STORAGE EXTENDED');
    await q.query('ALTER TABLE captured_request ALTER COLUMN body SET STORAGE EXTENDED');
  }
}
