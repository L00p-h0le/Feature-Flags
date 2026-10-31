import { isInRollout, subjectBucket } from './bucketing.js';
import { isUsableSubjectKey } from './schema.js';
import type { PublishedBooleanFlag } from './schema.js';

/** Stable application identity; other context attributes are not targeted in v1. */
export interface EvaluationContext {
  readonly subjectKey?: string | null;
}

/** Explanation of the first applicable decision in the precedence table. */
export type EvaluationReason =
  | 'kill_switch'
  | 'missing_subject'
  | 'exact_match'
  | 'percentage_rollout'
  | 'default';

/** Bucket is a uint32, not a percentage. Non-applicable diagnostics are null. */
export interface EvaluationResult {
  readonly value: boolean;
  readonly flagKey: string;
  readonly version: number;
  readonly reason: EvaluationReason;
  readonly matchedRuleId: string | null;
  readonly bucket: number | null;
}

function result(
  flag: PublishedBooleanFlag,
  value: boolean,
  reason: EvaluationReason,
  matchedRuleId: string | null = null,
  bucket: number | null = null,
): EvaluationResult {
  return {
    value,
    flagKey: flag.key,
    version: flag.version,
    reason,
    matchedRuleId,
    bucket,
  };
}

/**
 * Pure local boolean evaluation of already validated configuration.
 * No clock, random source, I/O, cache state or exposure side effects are consulted.
 */
export function evaluate(
  flag: PublishedBooleanFlag,
  context: EvaluationContext,
): EvaluationResult {
  if (flag.killSwitch) return result(flag, false, 'kill_switch');

  const subjectKey = context.subjectKey;
  if (!isUsableSubjectKey(subjectKey)) {
    return result(flag, flag.defaultValue, 'missing_subject');
  }

  for (const rule of flag.exactRules) {
    if (rule.subjectKeys.includes(subjectKey)) {
      return result(flag, rule.value, 'exact_match', rule.id);
    }
  }

  if (flag.rollout !== undefined) {
    const bucket = subjectBucket(flag, subjectKey);
    if (isInRollout(bucket, flag.rollout.percentageBps)) {
      return result(flag, true, 'percentage_rollout', null, bucket);
    }
    return result(flag, flag.defaultValue, 'default', null, bucket);
  }

  return result(flag, flag.defaultValue, 'default');
}
