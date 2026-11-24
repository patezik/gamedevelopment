import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import { describe, expect, test } from 'vitest';
import {
  conflictGen,
  GenerationRejection,
  runPipeline,
  worldGen,
  type ConflictWorld,
  type GeneratedWorld,
  type SocialWorld,
  type Stage,
} from '../src/index.ts';
import {
  assessSeed,
  DEFAULT_STAGES,
  sweep,
  SweepAborted,
  sweepOptions,
  type InputStages,
} from './incident-sweep-lib.ts';

const minimal = loadScenarioFromDir(
  fileURLToPath(new URL('../../../content/scenarios/_test_minimal/', import.meta.url)),
);

/** A stage with the real stage's name (so the same streams), counting calls. */
function spy<I, O>(stage: Stage<I, O>, behave: (call: number) => void) {
  let calls = 0;
  const wrapped: Stage<I, O> = {
    name: stage.name,
    generate(input, context) {
      calls++;
      behave(calls);
      return stage.generate(input, context);
    },
  };
  return { stage: wrapped, calls: () => calls };
}

describe('sweepOptions', () => {
  test('defaults and valid values', () => {
    expect(sweepOptions({})).toEqual({
      scenario: 'sanatorium_winter',
      from: 0,
      count: 500,
      threshold: 0.9,
      json: false,
    });
    const last = String(Number.MAX_SAFE_INTEGER);
    expect(sweepOptions({ from: last, count: '1', threshold: '1' })).toMatchObject({
      from: Number.MAX_SAFE_INTEGER,
      count: 1,
      threshold: 1,
    });
  });

  test.each([
    ['from', { from: '-1' }],
    ['from', { from: '1.5' }],
    ['from', { from: '1e3' }],
    ['from', { from: '' }],
    ['from', { from: '007' }],
    ['from', { from: '9007199254740992' }],
    ['count', { count: '0' }],
    ['count', { count: 'many' }],
    ['range', { from: String(Number.MAX_SAFE_INTEGER), count: '2' }],
    ['range', { from: String(Number.MAX_SAFE_INTEGER - 9), count: '11' }],
    ['threshold', { threshold: '1.1' }],
    ['threshold', { threshold: '-0.1' }],
    ['threshold', { threshold: 'NaN' }],
    ['threshold', { threshold: ' ' }],
    ['scenario', { scenario: '../secrets' }],
  ])('rejects an invalid %s: %o', (_, values) => {
    expect(() => sweepOptions(values)).toThrow(RangeError);
  });
});

describe('assessSeed', () => {
  test('builds the input from attempt 1 only, with the streams of the full pipeline', () => {
    const outcome = assessSeed('3', minimal);
    if (outcome.kind !== 'assessed') throw new Error('Expected an assessed world');
    const world = worldGen.generate(undefined, {
      rng: createRng('3#1').fork('gen/WorldGen'),
      content: minimal,
      logger: { debug() {} },
    });
    expect(outcome.input.world.startLocationId).toBe(world.startLocationId);
    const conflict = runPipeline(
      [DEFAULT_STAGES.cast, DEFAULT_STAGES.social, DEFAULT_STAGES.conflict],
      undefined,
      { seed: '3', content: minimal, now: () => 0, maxAttempts: 1 },
    );
    if (!conflict.ok) throw new Error('Expected attempt 1 to succeed');
    expect(outcome.input.motives).toEqual(conflict.output.motives);
    expect(outcome.input.characters).toEqual(conflict.output.characters);
  });

  test('a rejection in attempt 1 ends the seed: no retry, no data from another attempt', () => {
    const conflict = spy<SocialWorld, ConflictWorld>(conflictGen, () => {
      throw new GenerationRejection('TEST_REJECT', 'rejected on purpose');
    });
    const stages: InputStages = { ...DEFAULT_STAGES, conflict: conflict.stage };
    expect(assessSeed('1', minimal, stages)).toEqual({
      kind: 'rejected',
      rejection: { seed: '1', stage: 'ConflictGen', code: 'TEST_REJECT' },
    });
    expect(conflict.calls()).toBe(1);
  });

  test('a world rejected in attempt 1 never runs the later stages', () => {
    const world = spy<undefined, GeneratedWorld>(worldGen, () => {
      throw new GenerationRejection('TEST_WORLD', 'rejected on purpose');
    });
    const conflict = spy<SocialWorld, ConflictWorld>(conflictGen, () => {});
    const stages: InputStages = { ...DEFAULT_STAGES, world: world.stage, conflict: conflict.stage };
    expect(assessSeed('2', minimal, stages)).toMatchObject({
      kind: 'rejected',
      rejection: { stage: 'WorldGen', code: 'TEST_WORLD' },
    });
    expect([world.calls(), conflict.calls()]).toEqual([1, 0]);
  });

  test('an unexpected exception aborts with the seed instead of counting a failed world', () => {
    const conflict = spy<SocialWorld, ConflictWorld>(conflictGen, () => {
      throw new TypeError('defect');
    });
    const stages: InputStages = { ...DEFAULT_STAGES, conflict: conflict.stage };
    const run = () => assessSeed('4', minimal, stages);
    expect(run).toThrow(SweepAborted);
    expect(run).toThrow(/Seed 4: unexpected error.*TypeError: defect/);
    try {
      run();
    } catch (error) {
      expect((error as SweepAborted).seed).toBe('4');
      expect((error as SweepAborted).cause).toBeInstanceOf(TypeError);
    }
  });
});

describe('sweep', () => {
  test('counts rejected seeds and keeps going', () => {
    const conflict = spy<SocialWorld, ConflictWorld>(conflictGen, (call) => {
      if (call === 2) throw new GenerationRejection('TEST_REJECT', 'one world');
    });
    const report = sweep(
      minimal,
      { from: 10, count: 3, threshold: 0.5 },
      {
        ...DEFAULT_STAGES,
        conflict: conflict.stage,
      },
    );
    expect(report.seeds).toEqual({ from: 10, to: 12, count: 3 });
    expect(report.rejectedSeeds).toEqual([
      { seed: '11', stage: 'ConflictGen', code: 'TEST_REJECT' },
    ]);
    expect(report.required).toBe(2);
    for (const { feasibleWorlds } of report.results) expect(feasibleWorlds).toBeLessThanOrEqual(2);
  });

  test('stops at the first unexpected exception', () => {
    const conflict = spy<SocialWorld, ConflictWorld>(conflictGen, (call) => {
      if (call === 3) throw new RangeError('defect');
    });
    expect(() =>
      sweep(
        minimal,
        { from: 0, count: 5, threshold: 0.9 },
        { ...DEFAULT_STAGES, conflict: conflict.stage },
      ),
    ).toThrow(/Seed 2: unexpected error.*RangeError: defect/);
    expect(conflict.calls()).toBe(3);
  });

  test('is deterministic', () => {
    const options = { from: 0, count: 4, threshold: 0.9 };
    expect(sweep(minimal, options)).toEqual(sweep(minimal, options));
  });
});
