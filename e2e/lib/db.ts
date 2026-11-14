import pg from 'pg';
import { DATABASE_URL } from './env';

const TABLES = ['subdomain', 'slug_tombstone', 'account', 'magic_link', 'device_auth', 'cli_token', 'session', 'identity', 'captured_request', 'replay', 'mock_rule'];

/** Wipes every table the app writes to. Safe only because the suite runs with a single worker. */
export async function resetDb(): Promise<void> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    await c.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
  } finally {
    await c.end();
  }
}

export async function dbQuery<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}
