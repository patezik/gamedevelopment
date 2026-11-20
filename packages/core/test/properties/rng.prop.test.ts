import { createRng } from '@hs/core/rng';
import fc from 'fast-check';
import { expect, test } from 'vitest';

test('shuffle is a permutation and leaves its input untouched', () => {
  fc.assert(
    fc.property(fc.string(), fc.array(fc.integer()), (seed, input) => {
      const original = [...input];
      const shuffled = createRng(seed).shuffle(input);
      expect(shuffled).not.toBe(input);
      expect(input).toEqual(original);
      expect(shuffled.sort((left, right) => left - right)).toEqual(
        original.sort((left, right) => left - right),
      );
    }),
    { seed: 42 },
  );
});

test('weighted choice rejects zero weights before sampling', () => {
  fc.assert(
    fc.property(fc.string(), fc.integer({ min: 1 }), (seed, weight) => {
      const rng = createRng(seed);
      const before = rng.state;
      expect(() =>
        rng.weighted([
          { value: 'valid', weight },
          { value: 'zero', weight: 0 },
        ]),
      ).toThrow(RangeError);
      expect(rng.state).toEqual(before);
    }),
    { seed: 42 },
  );
});
