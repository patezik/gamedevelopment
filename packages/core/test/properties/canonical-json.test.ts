import { canonicalJson } from '@hs/core/common';
import fc from 'fast-check';
import { expect, test } from 'vitest';

test('canonical JSON is stable after a round trip', () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const encoded = canonicalJson(value);
      expect(canonicalJson(JSON.parse(encoded))).toBe(encoded);
    }),
    { seed: 42, numRuns: 500 },
  );
});
