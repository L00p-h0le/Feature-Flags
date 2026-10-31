import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { ApiError } from './domain.js';
import type { Actor, Role, Scope } from './domain.js';

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
export const SESSION_COOKIE = 'w13_session';
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const csrfFor = (token: string) => digest(`w13-csrf:${token}`);

export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt)).toString('hex')}`;
}

export async function passwordMatches(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [salt, hash] = encoded.split(':');
  const computed = await derive(password, salt ?? 'missing-account');
  const expected = hash ? Buffer.from(hash, 'hex') : Buffer.alloc(64);
  return (
    hash !== undefined &&
    expected.length === computed.length &&
    timingSafeEqual(computed, expected)
  );
}

export async function sessionActor(
  pool: Pool,
  request: FastifyRequest,
): Promise<Actor | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await pool.query<Actor>(
    'SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
    [digest(token)],
  );
  return result.rows[0] ?? null;
}

export async function newSession(pool: Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
    [digest(token), userId],
  );
  return token;
}

export async function requireActor(
  pool: Pool,
  request: FastifyRequest,
): Promise<Actor> {
  const actor = await sessionActor(pool, request);
  if (!actor) {
    await pool.query(
      "INSERT INTO audit_events(action,outcome) VALUES('session.required','denied')",
    );
    throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  return actor;
}

export function checkCsrf(
  request: FastifyRequest,
  origins: readonly string[],
  authenticated: boolean,
): void {
  if (
    !origins.includes(request.headers.origin ?? '') ||
    request.headers['x-w13-request'] !== '1'
  ) {
    throw new ApiError(
      403,
      'CSRF_REJECTED',
      'The request origin could not be verified.',
    );
  }
  if (authenticated) {
    const token = request.cookies[SESSION_COOKIE];
    const csrf = request.headers['x-csrf-token'];
    if (
      !token ||
      typeof csrf !== 'string' ||
      !/^[a-f0-9]{64}$/.test(csrf) ||
      !timingSafeEqual(Buffer.from(csrf), Buffer.from(csrfFor(token)))
    ) {
      throw new ApiError(
        403,
        'CSRF_REJECTED',
        'Refresh the page before trying again.',
      );
    }
  }
}

export async function authorize(
  pool: Pool,
  actor: Actor,
  scope: Scope,
  roles: readonly Role[],
  action: string,
  key?: string,
): Promise<Role> {
  const result = await pool.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2 AND environment_key=$3',
    [actor.id, scope.organizationId, scope.environmentKey],
  );
  const role = result.rows[0]?.role;
  if (!role || !roles.includes(role)) {
    await pool.query(
      `INSERT INTO audit_events(organization_id,environment_key,actor_id,action,outcome,metadata)
       VALUES((SELECT id FROM organizations WHERE id=$1),$2,$3,$4,'denied',$5)`,
      [
        scope.organizationId,
        scope.environmentKey,
        actor.id,
        action,
        JSON.stringify({ targetKey: key ?? null }),
      ],
    );
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Your role does not allow this action in this environment.',
    );
  }
  return role;
}
