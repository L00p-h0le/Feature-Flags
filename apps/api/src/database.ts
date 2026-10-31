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
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A failed ROLLBACK means the connection is unusable: discard it from
      // the pool and keep the original error, which explains the failure.
      broken =
        rollbackError instanceof Error
          ? rollbackError
          : new Error('Transaction rollback failed');
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
  });
  // An idle client losing its connection (restart, failover) emits 'error' on
  // the pool; unhandled, that crashes the process. pg already drops the
  // client, so record it and let the next checkout open a fresh connection.
  pool.on('error', (error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'database_idle_client_error',
        code: 'code' in error ? error.code : undefined,
      }),
    );
  });
  return pool;
}

/** Applied in order; never edit one after release, add a new file instead. */
const MIGRATIONS = [
  { version: 1, file: '001-control-plane.sql' },
  { version: 2, file: '002-audit-retention.sql' },
] as const;

async function loadMigrations() {
  return Promise.all(
    MIGRATIONS.map(async ({ version, file }) => {
      const sql = await readFile(
        new URL(`../migrations/${file}`, import.meta.url),
        'utf8',
      );
      return {
        version,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

/** Ordered, checksum-checked migrations under a cross-process advisory lock. */
export async function migrate(pool: Pool): Promise<void> {
  const migrations = await loadMigrations();
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(13202610)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
    );
    const result = await client.query<{ version: number; checksum: string }>(
      'SELECT version,checksum FROM schema_migrations',
    );
    const applied = new Map(
      result.rows.map((row) => [row.version, row.checksum]),
    );
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing !== undefined) {
        if (existing !== migration.checksum)
          throw new Error(
            `Migration ${migration.version} checksum mismatch: never edit applied migrations`,
          );
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
    }
  });
}

/** Normal runtime only verifies schema; migration credentials can be separate. */
export async function assertMigrated(pool: Pool): Promise<void> {
  const migrations = await loadMigrations();
  const result = await pool.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations',
  );
  const applied = new Map(
    result.rows.map((row) => [row.version, row.checksum]),
  );
  if (
    migrations.some(
      (migration) => applied.get(migration.version) !== migration.checksum,
    )
  )
    throw new Error(
      'Database schema is not current. Run db:migrate with migration credentials.',
    );
}

/** The database refuses to prune anything younger; see migration 002. */
export const MIN_AUDIT_RETENTION_DAYS = 90;
const AUDIT_PRUNE_BATCH = 10_000;

/**
 * Deletes audit events older than `retentionDays`, in bounded batches so each
 * transaction stays within the statement timeout. Run with migration (owner)
 * credentials; the runtime role has no DELETE grant on audit_events.
 */
export async function pruneAudit(
  pool: Pool,
  retentionDays: number,
): Promise<number> {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < MIN_AUDIT_RETENTION_DAYS
  )
    throw new Error(
      `Audit retention must be a whole number of at least ${MIN_AUDIT_RETENTION_DAYS} days`,
    );
  let total = 0;
  for (;;) {
    const deleted = await transaction(pool, async (client) => {
      await client.query("SET LOCAL w13.audit_retention = 'on'");
      const result = await client.query(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events WHERE created_at < now() - make_interval(days => $1) LIMIT $2)`,
        [retentionDays, AUDIT_PRUNE_BATCH],
      );
      return result.rowCount ?? 0;
    });
    total += deleted;
    if (deleted < AUDIT_PRUNE_BATCH) return total;
  }
}
