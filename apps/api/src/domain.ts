import { z } from 'zod';
import { parsePublishedFlag } from '@w13/evaluator';
import type { PublishedBooleanFlag } from '@w13/evaluator';

export type DraftConfig = Pick<
  PublishedBooleanFlag,
  'killSwitch' | 'defaultValue' | 'exactRules' | 'rollout'
>;
export type Snapshot = DraftConfig & {
  key: string;
  environmentKey: string;
  salt: string;
  version: number;
};
export type Role = 'admin' | 'editor' | 'viewer';
export interface Actor {
  id: string;
  name: string;
  email: string;
}
export interface Scope {
  organizationId: string;
  environmentKey: string;
}
export interface FlagRow {
  id: string;
  organization_id: string;
  environment_key: string;
  key: string;
  name: string;
  description: string;
  salt: string;
  revision: number;
  next_version: number;
  active_version: number | null;
  archived: boolean;
  config: unknown;
  active_config: unknown;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Server-side data failed re-validation on read. Rows are validated on write,
 * so this is an invariant violation (500, logged), never a client error (400).
 */
export class StoredDataError extends Error {
  constructor(
    public flagId: string,
    options: { cause: unknown },
  ) {
    super('Stored flag data failed validation', options);
  }
}

export const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/);
export const scopeSchema = z.strictObject({
  organizationId: z.uuid(),
  environmentKey: z.enum(['development', 'production']),
});
export const targetSchema = scopeSchema.extend({ key: keySchema });
export const revisionSchema = z.strictObject({
  expectedRevision: z.number().int().positive().max(2_147_483_646),
});
export const createFlagSchema = z.strictObject({
  key: keySchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
});

const draftShape = z.strictObject({
  killSwitch: z.boolean(),
  defaultValue: z.boolean(),
  exactRules: z.array(z.unknown()),
  rollout: z
    .strictObject({ percentageBps: z.number().int().min(0).max(10_000) })
    .optional(),
});

/** Reuse the normative parser; do not duplicate rule or Unicode validation. */
export function parseDraft(input: unknown): DraftConfig {
  const shape = draftShape.parse(input);
  return draftFromSnapshot(
    parsePublishedFlag({
      key: 'validation',
      environmentKey: 'development',
      version: 1,
      salt: 'validation',
      ...shape,
    }),
  );
}

export function draftFromSnapshot(flag: DraftConfig): DraftConfig {
  return {
    killSwitch: flag.killSwitch,
    defaultValue: flag.defaultValue,
    exactRules: flag.exactRules,
    ...(flag.rollout === undefined ? {} : { rollout: flag.rollout }),
  };
}

export function snapshot(
  flag: FlagRow,
  config: unknown,
  version = flag.next_version,
): PublishedBooleanFlag {
  return parsePublishedFlag({
    ...parseDraft(config),
    key: flag.key,
    environmentKey: flag.environment_key,
    salt: flag.salt,
    version,
  });
}

export function configsEqual(a: DraftConfig, b: DraftConfig): boolean {
  return (
    JSON.stringify(draftFromSnapshot(a)) ===
    JSON.stringify(draftFromSnapshot(b))
  );
}

export function changes(before: DraftConfig | null, after: DraftConfig) {
  return (['killSwitch', 'defaultValue', 'exactRules', 'rollout'] as const)
    .filter(
      (field) =>
        JSON.stringify(before?.[field] ?? null) !==
        JSON.stringify(after[field] ?? null),
    )
    .map((field) => ({
      field,
      before: before?.[field] ?? null,
      after: after[field] ?? null,
    }));
}
