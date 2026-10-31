import { createHash } from 'node:crypto';
import type { PublishedBooleanFlag } from './schema.js';

const HASH_SPACE_SIZE = 2 ** 32;
const BASIS_POINT_SCALE = 10_000;

/** Internal contract primitive; do not change tuple encoding without a new contract. */
export function subjectBucket(
  flag: PublishedBooleanFlag,
  subjectKey: string,
): number {
  const tuple = JSON.stringify([
    flag.key,
    flag.environmentKey,
    flag.salt,
    subjectKey,
  ]);
  return createHash('sha256').update(tuple, 'utf8').digest().readUInt32BE(0);
}

/** Both integer products fit exactly in a JavaScript number (below 2^53). */
export function isInRollout(bucket: number, percentageBps: number): boolean {
  return bucket * BASIS_POINT_SCALE < percentageBps * HASH_SPACE_SIZE;
}
