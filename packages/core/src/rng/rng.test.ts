import { createRng, restoreRng, type Rng, type RngState } from '@hs/core/rng';
import { expect, test } from 'vitest';

function draw(rng: Rng): number[] {
  return Array.from({ length: 10 }, () => rng.nextU32());
}

test.each([
  [
    'alpha',
    [
      1825004052, 1958783623, 3115041170, 3522994156, 940781358, 1761299928, 393347278, 3623397133,
      4281977869, 1629390847,
    ],
  ],
  [
    'beta',
    [
      1475814188, 2955308520, 4124190896, 549422491, 193367558, 4101619359, 1147474374, 3003143322,
      714277648, 3976616619,
    ],
  ],
] as const)('matches the sfc32 sequence for seed %s', (seed, expected) => {
  expect(draw(createRng(seed))).toEqual(expected);
});

test('each fork is determined by its path and leaves the parent untouched', () => {
  const parent = createRng('alpha');
  const child = draw(parent.fork('a'));
  expect(draw(parent.fork('b'))).not.toEqual(child);
  expect(draw(parent)).toEqual(draw(createRng('alpha')));
  expect(draw(parent.fork('a'))).toEqual(child);
  expect(draw(parent.fork('a/b'))).not.toEqual(draw(parent.fork('a').fork('b')));
});

test('restores future draws and forks from a serialized snapshot', () => {
  const source = createRng('расследование').fork('a').fork('b');
  draw(source);
  const snapshot = source.state;
  const parsed = JSON.parse(JSON.stringify(snapshot)) as RngState;
  const expected = draw(source);
  expect(snapshot).toEqual(parsed);

  const restored = restoreRng(parsed);
  expect(draw(restored)).toEqual(expected);
  expect(draw(restored.fork('c'))).toEqual(draw(source.fork('c')));
  expect(restored.state).toEqual(source.state);
  expect(() => restoreRng({ ...snapshot, words: [0, 0, 0, -1] })).toThrow(RangeError);
});

test('handles the widest safe bounds and allows both endpoints', () => {
  const rng = createRng('bounds');
  expect(rng.int(7, 7)).toBe(7);
  expect(new Set(Array.from({ length: 100 }, () => rng.int(-1, 1)))).toEqual(new Set([-1, 0, 1]));
  const min = Number.MIN_SAFE_INTEGER;
  const max = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < 50; index++) {
    const value = rng.int(min, max);
    expect(Number.isSafeInteger(value) && value >= min && value <= max).toBe(true);
  }
  expect(() => rng.int(2, 1)).toThrow(RangeError);
  expect(() => rng.int(0, 2.5)).toThrow(RangeError);
});

test('rejects samples in the partial bucket', () => {
  const rng = restoreRng({ seed: '', path: [], words: [0xffffffff, 0, 0, 0] });
  expect(rng.int(0, 2)).toBe(1);
  expect(rng.state.words[3]).toBe(2);
});

test('integer buckets pass a chi-square test on 100,000 draws', () => {
  const rng = createRng('chi-square');
  const buckets = Array<number>(10).fill(0);
  for (let index = 0; index < 100_000; index++) {
    const bucket = rng.int(0, 9);
    buckets[bucket] = buckets[bucket]! + 1;
  }
  const statistic = buckets.reduce((sum, count) => sum + (count - 10_000) ** 2 / 10_000, 0);
  // The 99th percentile for 9 degrees of freedom is 21.666.
  expect(statistic).toBeLessThan(21.666);
});

test('supports float, probability, uniform pick and finite weighted pick', () => {
  const rng = createRng('helpers');
  const value = rng.float();
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThan(1);
  expect(rng.chance(0)).toBe(false);
  expect(rng.chance(1)).toBe(true);
  expect(() => rng.chance(NaN)).toThrow(RangeError);
  expect(rng.pick(['only'])).toBe('only');
  expect(() => rng.pick([])).toThrow(RangeError);
  expect(rng.weighted([{ value: 'only', weight: 1 }])).toBe('only');
  expect(
    rng.weighted([
      { value: 'a', weight: Number.MAX_VALUE },
      { value: 'b', weight: Number.MAX_VALUE },
    ]),
  ).toMatch(/^[ab]$/);
  expect(() => rng.weighted([])).toThrow(RangeError);
  expect(() => rng.weighted([{ value: 'bad', weight: Infinity }])).toThrow(RangeError);
});
