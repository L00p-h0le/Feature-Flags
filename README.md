# Feature Flags — deployment source

Node 24 / Fastify / PostgreSQL control plane with a React dashboard and deterministic local evaluator. Includes drafts, immutable publication history, rollback, environment roles, audit records and a subject simulator. SDK delivery/cache and experiments are not implemented yet.

This repository intentionally contains deployment inputs only. Tests, learning material, screenshots, local database binaries/data, caches and credentials remain in the development workspace. Dependencies are pinned by the lockfile. The font license ships in the static output under /licenses/geist-OFL.txt.

Temporary dependency overrides pin glob 14.0.3 beneath @fastify/static and minimatch 11.0.3 to address upstream availability advisories. They cross upstream declared major ranges and were checked with the compiled runtime; remove them once upstream dependency ranges include the patched releases.

## Container deployment

Provide PostgreSQL and configure DATABASE_URL plus PUBLIC_ORIGIN (an exact HTTPS origin without a trailing slash). Set HOST=0.0.0.0 inside containers; PORT defaults to 8080 in the image. The platform or reverse proxy must terminate HTTPS. No demo sign-in endpoint is registered by this entry point.

Build the image, then run the migration before starting the server:

~~~sh
docker build -t w13-feature-flags .
docker run --rm --env-file .env w13-feature-flags node apps/api/dist/cli.js
docker run --env-file .env -p 127.0.0.1:8080:8080 w13-feature-flags
~~~

The container runs as the node user. Only build output, runtime dependencies and migrations are included in the runtime stage. Credentials are injected at runtime and never copied into an image. Health check: GET /api/health. The database requires persistent storage.

## Included Compose setup

Copy .env.example to .env. Set POSTGRES_PASSWORD, DATABASE_URL (host postgres, database/user w13, URL-encoded matching password), PUBLIC_ORIGIN and a unique ADMIN_SEED_PASSWORD. The app's localhost port is intended to sit behind your HTTPS proxy.

~~~sh
docker compose -f compose.deploy.yaml build app
docker compose -f compose.deploy.yaml up -d postgres
docker compose -f compose.deploy.yaml run --rm bootstrap --seed
docker compose -f compose.deploy.yaml up -d app
~~~

Seed creates a synthetic Northstar Studio workspace and the admin email ava@example.test using your supplied password. It preserves existing users, passwords, drafts and history on rerun; it is not a password-reset command. Editor/viewer seed accounts have random inaccessible passwords. The deployment does not expose synthetic account-switch buttons. Membership administration and password recovery are future work.

For an existing populated database, run bootstrap without --seed instead. Never delete the database volume as part of a redeploy. Use separate migration and least-privilege runtime database credentials where your platform supports them.

Rate limits key on the client IP. The Compose file sets TRUSTED_PROXY_HOPS=1 so the client address is taken from your HTTPS proxy's X-Forwarded-For; that is safe only because the app port is bound to 127.0.0.1. Use the number of proxies in front of the app, or 0 if clients connect directly.

Audit events are append-only except for retention. Run `docker compose -f compose.deploy.yaml run --rm bootstrap --prune-audit` (or `npm run db:prune-audit`) with migration credentials to delete events older than AUDIT_RETENTION_DAYS (default 365). The database refuses to delete anything younger than 90 days. Nothing schedules this for you.

## Without Docker

~~~sh
npm ci --include=dev --ignore-scripts
npm run build
npm run db:migrate
npm run db:seed
npm run db:prune-audit   # optional, any time later
npm prune --omit=dev --ignore-scripts
npm start
~~~

These commands read an optional local .env. Configure the database and HTTPS origin first. Migration/seed commands use emitted JavaScript, so no TypeScript runner or embedded database is needed in deployment. Same-origin cookies/CSRF are enforced; the dashboard and API must share the configured public origin. Production cookies are Secure/HttpOnly/SameSite=Strict.

## Verification and limits

The development workspace runs real PostgreSQL API tests and desktop/mobile browser checks. This trimmed repository is independently installed and built before push. Docker is unavailable on the authoring host, so image/Compose execution has not been verified there. No live deployment or production-capacity claim is implied by this push. Basic rate limiting is process-local and audit/version lists are bounded without pagination.
