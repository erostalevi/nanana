import type { DataSource, EntityManager } from 'typeorm';

/**
 * TypeORM's postgres driver returns `[rows, affectedCount]` for UPDATE/DELETE statements.
 * This normalises every statement to a plain row array.
 */
export async function q<T = Record<string, unknown>[]>(
  ds: DataSource | EntityManager,
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const r = (await ds.query(text, params)) as unknown;
  if (Array.isArray(r) && r.length === 2 && Array.isArray(r[0]) && typeof r[1] === 'number') return r[0] as T;
  return r as T;
}
