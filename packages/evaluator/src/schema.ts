import { z } from 'zod';

const MAX_IDENTITY_LENGTH = 256;
const MAX_RULES = 1_000;
const MAX_SUBJECTS_PER_RULE = 10_000;
const MAX_KEY_LENGTH = 128;

/** Identities are literal strings: no implicit trimming or normalization. */
export function isUsableSubjectKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_LENGTH &&
    value.isWellFormed()
  );
}

const identifierSchema = z
  .string()
  .min(1)
  .max(MAX_KEY_LENGTH)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/);

const identitySchema = z.string().refine(isUsableSubjectKey, {
  message:
    'Expected a nonempty, well-formed identity of at most 256 code units',
});

const exactRuleSchema = z
  .strictObject({
    id: identifierSchema,
    subjectKeys: z
      .array(identitySchema)
      .min(1)
      .max(MAX_SUBJECTS_PER_RULE)
      .readonly(),
    value: z.boolean(),
  })
  .readonly();

const publishedFlagSchema = z
  .strictObject({
    key: identifierSchema,
    environmentKey: identifierSchema,
    version: z.number().int().positive().safe(),
    salt: identitySchema,
    killSwitch: z.boolean(),
    exactRules: z.array(exactRuleSchema).max(MAX_RULES).readonly(),
    rollout: z
      .strictObject({ percentageBps: z.number().int().min(0).max(10_000) })
      .readonly()
      .optional(),
    defaultValue: z.boolean(),
  })
  .superRefine((flag, context) => {
    const ids = new Set<string>();
    flag.exactRules.forEach((rule, index) => {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: 'custom',
          path: ['exactRules', index, 'id'],
          message: 'Rule IDs must be unique within a flag',
        });
      }
      ids.add(rule.id);
    });
  })
  .brand<'PublishedBooleanFlag'>()
  .readonly();

/** Validated, recursively frozen configuration; versions are external metadata. */
export type PublishedBooleanFlag = z.infer<typeof publishedFlagSchema>;

/**
 * Validate external configuration once before it enters the evaluation path.
 * Throws ZodError on malformed input; never coerces or supplies policy defaults.
 */
export function parsePublishedFlag(input: unknown): PublishedBooleanFlag {
  return publishedFlagSchema.parse(input);
}
