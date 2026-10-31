import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ApiError,
  createFlagSchema,
  parseDraft,
  revisionSchema,
  scopeSchema,
  targetSchema,
} from './domain.js';
import type { Role, Scope } from './domain.js';
import {
  authorize,
  checkCsrf,
  csrfFor,
  digest,
  newSession,
  passwordMatches,
  requireActor,
  SESSION_COOKIE,
  sessionActor,
} from './auth.js';
import { DEMO_USERS } from './seed.js';
import { FlagStore } from './store.js';

interface Options {
  pool: Pool;
  origins: readonly string[];
  demoMode?: boolean;
  secureCookies?: boolean;
  staticDirectory?: string;
  logger?: boolean;
}

export async function createApp(options: Options) {
  const { pool } = options;
  if (
    options.demoMode &&
    options.origins.some(
      (origin) => !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin),
    )
  )
    throw new Error('Demo mode requires loopback origins');
  const app = Fastify({
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
    logger: options.logger
      ? {
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.headers["x-csrf-token"]',
            'res.headers["set-cookie"]',
          ],
        }
      : false,
    genReqId: () => randomUUID(),
  });
  const store = new FlagStore(pool);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  if (options.staticDirectory)
    await app.register(staticFiles, { root: options.staticDirectory });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.code === 'CSRF_REJECTED') {
        try {
          await pool.query(
            "INSERT INTO audit_events(action,outcome,metadata) VALUES('request.csrf','denied','{}')",
          );
        } catch {
          request.log.error(
            { event: 'security_audit_failed' },
            'Security audit unavailable',
          );
          return reply
            .code(503)
            .send({
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'The service is unavailable. Retry shortly.',
                requestId: request.id,
              },
            });
        }
      }
      return reply
        .code(error.status)
        .send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
          },
        });
    }
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Check the highlighted fields and try again.',
            fields: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
            requestId: request.id,
          },
        });
    const code =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (code >= 400 && code < 500)
      return reply
        .code(code)
        .send({
          error: {
            code: 'REQUEST_REJECTED',
            message:
              code === 413
                ? 'Configuration exceeds the 256 KiB request limit.'
                : 'The request could not be accepted.',
            requestId: request.id,
          },
        });
    request.log.error(
      { event: 'request_failed', requestId: request.id },
      'Request failed',
    );
    return reply
      .code(503)
      .send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The service is unavailable. Retry shortly.',
          requestId: request.id,
        },
      });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
        checkCsrf(request, options.origins, false);
    }
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found.',
          requestId: request.id,
        },
      }),
  );

  const membership = async (
    request: FastifyRequest,
    scope: Scope,
    roles: readonly Role[],
    action: string,
    key?: string,
  ) => {
    const actor = await requireActor(pool, request);
    if (!['GET', 'HEAD'].includes(request.method))
      checkCsrf(request, options.origins, true);
    await authorize(pool, actor, scope, roles, action, key);
    return actor;
  };
  const allRoles: Role[] = ['admin', 'editor', 'viewer'];
  const base =
    '/api/organizations/:organizationId/environments/:environmentKey';

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/session', async (request) => {
    const actor = await sessionActor(pool, request);
    const memberships = actor
      ? (
          await pool.query(
            'SELECT m.organization_id AS "organizationId",o.name AS "organizationName",m.environment_key AS "environmentKey",m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE user_id=$1 ORDER BY environment_key',
            [actor.id],
          )
        ).rows
      : [];
    return {
      user: actor,
      memberships,
      csrfToken: actor ? csrfFor(request.cookies[SESSION_COOKIE] ?? '') : null,
      demoUsers: options.demoMode
        ? DEMO_USERS.map(({ id, name, role }) => ({ id, name, role }))
        : [],
    };
  });

  app.post(
    '/api/session',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z
        .strictObject({
          email: z.email().max(254),
          password: z.string().min(1).max(1024),
        })
        .parse(request.body);
      const result = await pool.query<{ id: string; password_hash: string }>(
        'SELECT id,password_hash FROM users WHERE email=$1',
        [body.email.toLowerCase()],
      );
      const user = result.rows[0];
      if (
        !(await passwordMatches(
          body.password,
          user?.password_hash ?? 'missing',
        ))
      ) {
        await pool.query(
          "INSERT INTO audit_events(action,outcome) VALUES('session.login','denied')",
        );
        throw new ApiError(
          401,
          'INVALID_CREDENTIALS',
          'Email or password is incorrect.',
        );
      }
      if (!user)
        throw new ApiError(
          401,
          'INVALID_CREDENTIALS',
          'Email or password is incorrect.',
        );
      const old = request.cookies[SESSION_COOKIE];
      if (old)
        await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
          digest(old),
        ]);
      const token = await newSession(pool, user.id);
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        secure: options.secureCookies ?? true,
        sameSite: 'strict',
        maxAge: 8 * 3600,
      });
      await pool.query(
        "INSERT INTO audit_events(actor_id,action,outcome) VALUES($1,'session.login','allowed')",
        [user.id],
      );
      return { ok: true };
    },
  );

  // Deliberate local synthetic identities; absent entirely outside demo mode.
  if (options.demoMode)
    app.post('/api/demo-session', async (request, reply) => {
      const { userId } = z
        .strictObject({ userId: z.uuid() })
        .parse(request.body);
      if (!DEMO_USERS.some((user) => user.id === userId))
        throw new ApiError(403, 'FORBIDDEN', 'Demo identity unavailable.');
      const old = request.cookies[SESSION_COOKIE];
      if (old)
        await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
          digest(old),
        ]);
      const token = await newSession(pool, userId);
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'strict',
        maxAge: 8 * 3600,
      });
      await pool.query(
        "INSERT INTO audit_events(actor_id,action,outcome) VALUES($1,'session.demo_login','allowed')",
        [userId],
      );
      return { ok: true };
    });

  app.post('/api/logout', async (request, reply) => {
    const actor = await requireActor(pool, request);
    checkCsrf(request, options.origins, true);
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
      digest(request.cookies[SESSION_COOKIE] ?? ''),
    ]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await pool.query(
      "INSERT INTO audit_events(actor_id,action,outcome) VALUES($1,'session.logout','allowed')",
      [actor.id],
    );
    return { ok: true };
  });

  app.get(`${base}/flags`, async (request) => {
    const scope = scopeSchema.parse(request.params);
    await membership(request, scope, allRoles, 'flags.read');
    return { flags: await store.list(scope) };
  });
  app.post(`${base}/flags`, async (request, reply) => {
    const scope = scopeSchema.parse(request.params);
    const actor = await membership(
      request,
      scope,
      ['admin', 'editor'],
      'flag.create',
    );
    return reply
      .code(201)
      .send(
        await store.create(scope, actor, createFlagSchema.parse(request.body)),
      );
  });
  app.get(`${base}/flags/:key`, async (request) => {
    const scope = targetSchema.parse(request.params);
    await membership(request, scope, allRoles, 'flag.read', scope.key);
    return store.get(scope, scope.key);
  });
  app.put(`${base}/flags/:key/draft`, async (request) => {
    const scope = targetSchema.parse(request.params);
    const actor = await membership(
      request,
      scope,
      ['admin', 'editor'],
      'draft.save',
      scope.key,
    );
    const body = revisionSchema
      .extend({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(1000),
        config: z.unknown(),
      })
      .parse(request.body);
    return store.save(scope, scope.key, actor, body.expectedRevision, {
      name: body.name,
      description: body.description,
      config: parseDraft(body.config),
    });
  });
  app.post(`${base}/flags/:key/publish`, async (request) => {
    const scope = targetSchema.parse(request.params);
    const actor = await membership(
      request,
      scope,
      ['admin'],
      'flag.publish',
      scope.key,
    );
    const body = revisionSchema.parse(request.body);
    return store.publish(scope, scope.key, actor, body.expectedRevision);
  });
  app.post(`${base}/flags/:key/rollback`, async (request) => {
    const scope = targetSchema.parse(request.params);
    const actor = await membership(
      request,
      scope,
      ['admin'],
      'flag.rollback',
      scope.key,
    );
    const body = revisionSchema
      .extend({ version: z.number().int().positive().max(2_147_483_646) })
      .parse(request.body);
    return store.rollback(
      scope,
      scope.key,
      actor,
      body.expectedRevision,
      body.version,
    );
  });
  app.post(`${base}/flags/:key/archive`, async (request) => {
    const scope = targetSchema.parse(request.params);
    const actor = await membership(
      request,
      scope,
      ['admin'],
      'flag.archive',
      scope.key,
    );
    const body = revisionSchema
      .extend({ archived: z.boolean() })
      .parse(request.body);
    return store.archive(
      scope,
      scope.key,
      actor,
      body.expectedRevision,
      body.archived,
    );
  });
  app.post(`${base}/flags/:key/preview`, async (request) => {
    const scope = targetSchema.parse(request.params);
    await membership(request, scope, allRoles, 'flag.preview', scope.key);
    const body = revisionSchema
      .extend({ subjectKey: z.string().max(256).nullable().optional() })
      .parse(request.body);
    return store.preview(
      scope,
      scope.key,
      body.expectedRevision,
      body.subjectKey,
    );
  });
  app.get(`${base}/flags/:key/versions`, async (request) => {
    const scope = targetSchema.parse(request.params);
    await membership(request, scope, allRoles, 'versions.read', scope.key);
    return { versions: await store.versions(scope, scope.key) };
  });
  app.get(`${base}/audit`, async (request) => {
    const scope = scopeSchema.parse(request.params);
    await membership(request, scope, allRoles, 'audit.read');
    return { events: await store.audit(scope) };
  });
  return app;
}
