import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';

export interface Hasher {
  sha256(text: string): string;
}

export const nodeHasher: Hasher = {
  sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  },
};

export function stateHash(value: unknown, hasher: Hasher = nodeHasher): string {
  return hasher.sha256(canonicalJson(value));
}

export function sequentialId(prefix: string): () => string {
  let next = 0n;
  return () => `${prefix}_${++next}`;
}

export function hashId(prefix: string, value: unknown, length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new RangeError('Hash ID length must be an integer from 1 to 64');
  }
  return `${prefix}_${stateHash(value).slice(0, length)}`;
}
