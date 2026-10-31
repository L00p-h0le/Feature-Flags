import { createPool, migrate } from './database.js';
import { seed } from './seed.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error('DATABASE_URL must be configured; see .env.example');
const seedRequested = process.argv.includes('--seed');
const password = process.env.ADMIN_SEED_PASSWORD;
if (seedRequested && (!password || password.length < 16))
  throw new Error(
    'Seeding requires ADMIN_SEED_PASSWORD of at least 16 characters',
  );
const pool = createPool(connectionString);
try {
  await migrate(pool);
  if (seedRequested) await seed(pool, password);
  console.log(
    'Database migration/seed completed without resetting existing data.',
  );
} finally {
  await pool.end();
}
