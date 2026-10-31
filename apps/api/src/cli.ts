import { z } from 'zod';
import {
  createPool,
  migrate,
  MIN_AUDIT_RETENTION_DAYS,
  pruneAudit,
} from './database.js';
import { seed } from './seed.js';

const DEFAULT_AUDIT_RETENTION_DAYS = 365;

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error('DATABASE_URL must be configured; see .env.example');
const seedRequested = process.argv.includes('--seed');
const pruneRequested = process.argv.includes('--prune-audit');
const password = process.env.ADMIN_SEED_PASSWORD;
if (seedRequested && (!password || password.length < 16))
  throw new Error(
    'Seeding requires ADMIN_SEED_PASSWORD of at least 16 characters',
  );
const retention = z.coerce
  .number()
  .int()
  .min(MIN_AUDIT_RETENTION_DAYS)
  .default(DEFAULT_AUDIT_RETENTION_DAYS)
  .safeParse(process.env.AUDIT_RETENTION_DAYS || undefined);
if (pruneRequested && !retention.success)
  throw new Error(
    `AUDIT_RETENTION_DAYS must be a whole number of at least ${MIN_AUDIT_RETENTION_DAYS}`,
  );
const pool = createPool(connectionString);
try {
  await migrate(pool);
  if (seedRequested) await seed(pool, password);
  console.log(
    'Database migration/seed completed without resetting existing data.',
  );
  if (pruneRequested && retention.success) {
    const deleted = await pruneAudit(pool, retention.data);
    console.log(
      `Audit retention: deleted ${deleted} events older than ${retention.data} days.`,
    );
  }
} finally {
  await pool.end();
}
