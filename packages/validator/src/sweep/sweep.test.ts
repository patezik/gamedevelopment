import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWEEP_THRESHOLDS,
  aggregateSweep,
  entropyBits,
  evaluateThresholds,
  renderSweepMarkdown,
  sweepRecord,
  type SweepGeneration,
  type SweepRecord,
} from './sweep.ts';

const timing = { meanMs: 1, maxMs: 2, maxSeed: '3', wallMs: 10 };
const params = { scenarioId: 's', from: 0, generatorVersion: 'v' };

const accepted = (seed: string, culprit: string, attempts = 1): SweepRecord => ({
  seed,
  ok: true,
  attempts,
  characters: 4,
  culpritIds: [culprit],
  culpritArchetype: `arch_${culprit}`,
  victimArchetype: 'victim',
  template: 'poisoning',
  motiveType: 'debt',
});
const failed = (seed: string, firstError: string): SweepRecord => ({
  seed,
  ok: false,
  attempts: 2,
  firstError,
  errors: [firstError, 'V-UNIQUE:NOT_UNIQUE'],
});

describe('entropyBits', () => {
  it('is log2 of a uniform histogram, 0 for one outcome and for nothing', () => {
    expect(entropyBits([5, 5, 5, 5])).toBeCloseTo(2);
    expect(Object.is(entropyBits([7]), 0)).toBe(true);
    expect(entropyBits([])).toBe(0);
    expect(entropyBits([0, 3, 3])).toBeCloseTo(1);
  });
});

describe('sweepRecord', () => {
  it('keeps the facts of an accepted seed', () => {
    const record = sweepRecord('7', {
      ok: true,
      investigationHash: 'h',
      investigation: {
        characters: [{}, {}, {}],
        truth: { incident: { culpritIds: ['ch_a'] } },
      },
      report: {
        attempts: [{ number: 1 }],
        validations: [],
        chosen: { victimArchetype: 'v', culpritArchetype: 'c', template: 't', motiveType: 'm' },
      },
    });
    expect(record).toEqual({
      seed: '7',
      ok: true,
      attempts: 1,
      investigationHash: 'h',
      characters: 3,
      culpritIds: ['ch_a'],
      culpritArchetype: 'c',
      victimArchetype: 'v',
      template: 't',
      motiveType: 'm',
    });
  });

  it('names the first error of each rejected attempt: a stage rejection or a gate finding', () => {
    const result: SweepGeneration = {
      ok: false,
      report: {
        attempts: [
          { number: 1, rejection: { stage: 'IncidentSelection', code: 'NO_CULPRIT' } },
          { number: 2 },
          { number: 3 },
        ],
        validations: [
          {
            attempt: 2,
            findings: [
              { checkId: 'V-X', severity: 'warning', code: 'IGNORED' },
              { checkId: 'V-UNIQUE', severity: 'error', code: 'NOT_UNIQUE' },
            ],
          },
        ],
      },
    };
    expect(sweepRecord('9', result)).toEqual({
      seed: '9',
      ok: false,
      attempts: 3,
      firstError: 'IncidentSelection:NO_CULPRIT',
      errors: ['IncidentSelection:NO_CULPRIT', 'V-UNIQUE:NOT_UNIQUE', 'unknown'],
    });
  });
});

describe('aggregateSweep', () => {
  const records = [
    accepted('10', 'a'),
    accepted('2', 'b'),
    accepted('3', 'c', 2),
    accepted('4', 'd'),
    failed('11', 'V-UNIQUE:NOT_UNIQUE'),
    failed('5', 'IncidentSelection:NO_CULPRIT'),
  ];

  it('does not depend on the order of the records', () => {
    const forward = aggregateSweep(records, params, timing);
    const backward = aggregateSweep([...records].reverse(), params, timing);
    expect(backward).toEqual(forward);
    expect(forward.failedSeeds.map(({ seed }) => seed)).toEqual(['5', '11']);
  });

  it('counts rates, attempts, distributions and entropy', () => {
    const report = aggregateSweep(records, params, timing);
    expect(report).toMatchObject({
      count: 6,
      succeeded: 4,
      failed: 2,
      successRate: 0.6667,
      failureRate: 0.3333,
      firstAttemptRate: 0.5,
      attempts: { 1: 3, 2: 3 },
      motives: { debt: 4 },
      incidentTemplates: { poisoning: 4 },
      entropy: { culpritBits: 2, maxBits: 2, ratio: 1 },
    });
    expect(report.attemptRejections).toEqual({
      'IncidentSelection:NO_CULPRIT': 1,
      'V-UNIQUE:NOT_UNIQUE': 3,
    });
  });

  it('fails the verdict on the failure rate and on a skewed culprit', () => {
    const report = aggregateSweep(records, params, timing);
    expect(report.verdict.ok).toBe(false);
    expect(report.verdict.violations).toHaveLength(1);
    expect(report.verdict.violations[0]).toContain('failure rate 33.33 %');

    const skewed = aggregateSweep(
      Array.from({ length: 100 }, (_, n) => accepted(String(n), n < 90 ? 'a' : n < 95 ? 'b' : 'c')),
      params,
      timing,
    );
    expect(skewed.verdict.ok).toBe(false);
    expect(skewed.verdict.violations.join()).toContain('culprit entropy');
  });

  it('passes a clean uniform sweep, and an empty one never passes', () => {
    const clean = aggregateSweep(
      Array.from({ length: 100 }, (_, n) => accepted(String(n), 'abcd'[n % 4]!)),
      params,
      timing,
    );
    expect(clean.verdict).toEqual({ ok: true, violations: [] });
    expect(aggregateSweep([], params, timing).verdict.ok).toBe(false);
  });

  it('judges the failure rate strictly: exactly 1 % fails, below passes', () => {
    const entropy = { culpritBits: 2, maxBits: 2, ratio: 1, archetypeBits: 2 };
    expect(
      evaluateThresholds({ count: 100, failureRate: 0.01, entropy }, DEFAULT_SWEEP_THRESHOLDS).ok,
    ).toBe(false);
    expect(
      evaluateThresholds({ count: 1000, failureRate: 0.009, entropy }, DEFAULT_SWEEP_THRESHOLDS).ok,
    ).toBe(true);
  });
});

describe('renderSweepMarkdown', () => {
  it('shows the verdict, the metrics and the failed seeds', () => {
    const text = renderSweepMarkdown(
      aggregateSweep([accepted('1', 'a'), failed('2', 'V-UNIQUE:NOT_UNIQUE')], params, timing),
    );
    expect(text).toContain('# Seed sweep: s, seed 0..1');
    expect(text).toContain('ПОРОГИ НАРУШЕНЫ');
    expect(text).toContain('| 2 | `V-UNIQUE:NOT_UNIQUE` |');
    expect(text).toContain('### По персонажам');
  });
});
