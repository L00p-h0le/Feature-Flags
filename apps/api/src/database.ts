import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

/** One client per transaction: never mix pool.query with an open transaction. */
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createPool(connectionString: string): Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
  });
}

/** Ordered, checksum-checked migration with a cross-process advisory lock. */
export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(
    new URL('../migrations/001-control-plane.sql', import.meta.url),
    'utf8',
  );
  const checksum = createHash('sha256').update(sql).digest('hex');
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(13202610)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
    );
    const result = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version = 1',
    );
    const existing = result.rows[0];
    if (existing) {
      if (existing.checksum !== checksum)
        throw new Error(
          'Migration checksum mismatch: never edit applied migrations',
        );
      return;
    }
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations(version, checksum) VALUES (1, $1)',
      [checksum],
    );
  });
}

/** Normal runtime only verifies schema; migration credentials can be separate. */
export async function assertMigrated(pool: Pool): Promise<void> {
  const sql = await readFile(
    new URL('../migrations/001-control-plane.sql', import.meta.url),
    'utf8',
  );
  const expected = createHash('sha256').update(sql).digest('hex');
  const result = await pool.query<{ checksum: string }>(
    'SELECT checksum FROM schema_migrations WHERE version=1',
  );
  if (result.rows[0]?.checksum !== expected)
    throw new Error(
      'Database schema is not current. Run db:migrate with migration credentials.',
    );
}
