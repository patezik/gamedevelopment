import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import { expect, test } from 'vitest';
import { GenerationRejection, runPipeline, type Stage } from './index.ts';

const content = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/_test_minimal/', import.meta.url)),
);
const draw: Stage<string, number> = {
  name: 'draw',
  generate(input, { rng }) {
    return input.length + rng.nextU32();
  },
};
const format: Stage<number, string> = {
  name: 'format',
  generate(value, { rng }) {
    return `${value}:${rng.nextU32()}`;
  },
};

test('adding a stage preserves the earlier output and records each timing', () => {
  let tick = 0;
  const options = { seed: 'winter', content, now: () => ++tick };
  const first = runPipeline([draw], 'snow', options);
  const extended = runPipeline([draw, format], 'snow', options);
  if (!first.ok || !extended.ok) throw new Error('Expected both pipelines to succeed');

  const suffix = createRng('winter#1').fork('gen/format').nextU32();
  expect(extended.output).toBe(`${first.output}:${suffix}`);
  expect(extended.report.attempts[0]?.timingsMs).toEqual({ draw: 1, format: 1 });
});

test('retries validation with deterministic attempt seeds up to the configured limit', () => {
  const options = { seed: 'winter', content, maxAttempts: 2, now: () => 0 };
  const expected = 4 + createRng('winter#2').fork('gen/draw').nextU32();
  const result = runPipeline([draw], 'snow', {
    ...options,
    accepts: (value) => value === expected,
  });

  expect(result).toMatchObject({ ok: true, output: expected });
  expect(result.report.attempts.map(({ seed, accepted }) => [seed, accepted])).toEqual([
    ['winter#1', false],
    ['winter#2', true],
  ]);
  expect(runPipeline([draw], 'snow', { ...options, accepts: () => false })).toMatchObject({
    ok: false,
    error: 'GENERATION_UNSOLVABLE',
  });
});

test('a GenerationRejection ends the attempt; other errors propagate', () => {
  const ran: string[] = [];
  const gate: Stage<number, number> = {
    name: 'gate',
    generate(value, { rng }) {
      // Attempt 1 is rejected, attempt 2 passes.
      if (rng.nextU32() === createRng('winter#1').fork('gen/gate').nextU32()) {
        throw new GenerationRejection('TEST_REJECTED', 'nothing fits', { value });
      }
      return value;
    },
  };
  const after: Stage<number, string> = {
    name: 'after',
    generate(value) {
      ran.push(String(value));
      return String(value);
    },
  };
  const result = runPipeline([draw, gate, after], 'snow', {
    seed: 'winter',
    content,
    maxAttempts: 8,
    now: () => 0,
  });
  expect(result.ok).toBe(true);
  expect(result.report.attempts.map(({ accepted }) => accepted)).toEqual([false, true]);
  const rejected = result.report.attempts.filter(({ rejection }) => rejection);
  for (const { accepted, rejection, timingsMs } of rejected) {
    expect(accepted).toBe(false);
    expect(rejection).toMatchObject({
      stage: 'gate',
      code: 'TEST_REJECTED',
      message: 'nothing fits',
    });
    expect(rejection?.diagnostics).toHaveProperty('value');
    expect(Object.keys(timingsMs)).toEqual(['draw', 'gate']);
  }
  expect(ran).toHaveLength(1);

  const broken: Stage<number, number> = {
    name: 'broken',
    generate() {
      throw new RangeError('defect');
    },
  };
  expect(() =>
    runPipeline([draw, broken], 'snow', { seed: 'winter', content, now: () => 0 }),
  ).toThrow('defect');
});
