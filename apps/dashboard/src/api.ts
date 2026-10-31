import { z } from 'zod';

const role = z.enum(['admin', 'editor', 'viewer']);
export const sessionSchema = z.object({
  user: z
    .object({ id: z.string(), name: z.string(), email: z.string() })
    .nullable(),
  csrfToken: z.string().nullable(),
  memberships: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      environmentKey: z.string(),
      role,
    }),
  ),
  demoUsers: z.array(z.object({ id: z.string(), name: z.string(), role })),
});
export type Session = z.infer<typeof sessionSchema>;

export const draftSchema = z.object({
  killSwitch: z.boolean(),
  defaultValue: z.boolean(),
  exactRules: z.array(
    z.object({
      id: z.string(),
      subjectKeys: z.array(z.string()),
      value: z.boolean(),
    }),
  ),
  rollout: z.object({ percentageBps: z.number() }).optional(),
});
const snapshotSchema = draftSchema.extend({
  key: z.string(),
  environmentKey: z.string(),
  salt: z.string(),
  version: z.number(),
});
export type Draft = z.infer<typeof draftSchema>;
export const flagSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  environmentKey: z.string(),
  revision: z.number(),
  nextVersion: z.number(),
  activeVersion: z.number().nullable(),
  archived: z.boolean(),
  draft: draftSchema,
  active: snapshotSchema.nullable(),
  changes: z.array(
    z.object({ field: z.string(), before: z.unknown(), after: z.unknown() }),
  ),
});
export type Flag = z.infer<typeof flagSchema>;
export const listSchema = z.object({
  flags: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      description: z.string(),
      archived: z.boolean(),
      revision: z.number(),
      activeVersion: z.number().nullable(),
      hasChanges: z.boolean(),
      rolloutBps: z.number().nullable(),
      killed: z.boolean(),
    }),
  ),
});
export type FlagSummary = z.infer<typeof listSchema>['flags'][number];
export const auditSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      outcome: z.string(),
      metadata: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
      actorName: z.string().nullable(),
      flagKey: z.string().nullable(),
    }),
  ),
});
export type AuditEvent = z.infer<typeof auditSchema>['events'][number];
export const versionsSchema = z.object({
  versions: z.array(
    z.object({
      version: z.number(),
      config: snapshotSchema,
      createdAt: z.string(),
      actorName: z.string(),
    }),
  ),
});
export type Version = z.infer<typeof versionsSchema>['versions'][number];
const evaluationSchema = z.object({
  value: z.boolean(),
  flagKey: z.string(),
  version: z.number(),
  reason: z.string(),
  matchedRuleId: z.string().nullable(),
  bucket: z.number().nullable(),
});
export const previewSchema = z.object({
  revision: z.number(),
  draft: evaluationSchema,
  active: evaluationSchema.nullable(),
  changes: z.array(z.unknown()),
});
export type Preview = z.infer<typeof previewSchema>;
export const okSchema = z.object({ ok: z.boolean() });

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});
export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string | null | undefined;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      signal,
      headers: {
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        'X-W13-Request': '1',
        ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RequestError(
      0,
      'NETWORK_ERROR',
      'Cannot reach the service. Your local edits are still here. Retry when the connection returns.',
    );
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    const message = parsed.success
      ? `${parsed.data.error.message}${
          parsed.data.error.fields?.length
            ? ' ' +
              parsed.data.error.fields
                .slice(0, 3)
                .map((field) => `${field.path}: ${field.message}`)
                .join('; ')
            : ''
        }`
      : 'The request failed. Retry shortly.';
    throw new RequestError(
      response.status,
      parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      message,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new RequestError(
      0,
      'INVALID_RESPONSE',
      'The service returned an unexpected response. Reload and try again.',
    );
  return parsed.data;
}

export function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The request failed. Please retry.';
}
