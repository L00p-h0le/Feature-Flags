import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createApp } from './app.js';
import { assertMigrated, createPool } from './database.js';

const MAX_TRUSTED_PROXY_HOPS = 5;

const environment = z
  .object({
    DATABASE_URL: z.url(),
    PUBLIC_ORIGIN: z.url().refine((value) => {
      const origin = new URL(value);
      return (
        ['http:', 'https:'].includes(origin.protocol) && origin.origin === value
      );
    }, 'PUBLIC_ORIGIN must be an HTTP(S) origin without a path or trailing slash'),
    HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1024).max(65535).default(4173),
    TRUSTED_PROXY_HOPS: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_TRUSTED_PROXY_HOPS)
      .default(0),
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
  })
  .safeParse(process.env);
if (!environment.success) {
  console.error(
    'Invalid configuration. Set DATABASE_URL and PUBLIC_ORIGIN and check HOST, PORT and TRUSTED_PROXY_HOPS; see .env.example.',
  );
  process.exit(1);
}
const config = environment.data;
if (
  config.NODE_ENV === 'production' &&
  !config.PUBLIC_ORIGIN.startsWith('https://')
)
  throw new Error('Production requires an HTTPS public origin');
const pool = createPool(config.DATABASE_URL);
try {
  await assertMigrated(pool);
} catch (error) {
  await pool.end();
  throw error;
}
const app = await createApp({
  pool,
  origins: [config.PUBLIC_ORIGIN],
  secureCookies: config.NODE_ENV === 'production',
  // Resolve like migrations do (from this module), not from the launch directory.
  staticDirectory: fileURLToPath(
    new URL('../../dashboard/dist', import.meta.url),
  ),
  logger: true,
  trustedProxyHops: config.TRUSTED_PROXY_HOPS,
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await pool.end();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  await shutdown();
  throw error;
}
