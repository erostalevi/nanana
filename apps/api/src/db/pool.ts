import type { DataSource } from 'typeorm';

/** The slice of `pg`'s Pool the hot path uses. */
export interface PgPool {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  readonly waitingCount: number;
  readonly totalCount: number;
}

/**
 * The raw pg pool behind TypeORM. The webhook ingestion path queries it directly: going through
 * `DataSource.query` acquires a query runner and wraps every statement, which is measurable overhead at hundreds of requests per second.
 */
export function pgPool(ds: DataSource): PgPool {
  const master = (ds.driver as unknown as { master?: PgPool }).master;
  if (!master) throw new Error('postgres pool is not initialised');
  return master;
}
