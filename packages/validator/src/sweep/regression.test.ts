import { describe, expect, it } from 'vitest';
import {
  addFailedSeeds,
  checkCorpus,
  compareToBaseline,
  newFailedSeeds,
  parseBaseline,
  parseCorpus,
  type RegressionCorpus,
  type SweepBaseline,
} from './regression.ts';

const baseline: SweepBaseline = {
  scenarioId: 's',
  from: 0,
  count: 1000,
  failureRate: 0.04,
  entropyRatio: 0.99,
};
const sweep = (failureRate: number, ratio = 0.99, count = 1000, scenarioId = 's') => ({
  scenarioId,
  count,
  failureRate,
  entropy: { culpritBits: 0, maxBits: 0, ratio, archetypeBits: 0 },
});

describe('compareToBaseline', () => {
  it('accepts the baseline itself, small noise and the failure rate within tolerance', () => {
    expect(compareToBaseline(sweep(0.04), baseline).ok).toBe(true);
    expect(compareToBaseline(sweep(0.044), baseline).ok).toBe(true);
    expect(compareToBaseline(sweep(0.04, 0.975), baseline).ok).toBe(true);
  });

  it('catches a failure rate worse than the baseline by more than the tolerance', () => {
    const verdict = compareToBaseline(sweep(0.06), baseline);
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions).toHaveLength(1);
    expect(verdict.regressions[0]).toContain('failure rate');
  });

  it('catches a culprit entropy drop', () => {
    const verdict = compareToBaseline(sweep(0.04, 0.9), baseline);
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions[0]).toContain('entropy');
  });

  it('accepts an improvement and reports it', () => {
    const verdict = compareToBaseline(sweep(0.005), baseline);
    expect(verdict.ok).toBe(true);
    expect(verdict.improvements).toHaveLength(1);
  });

  it('does not enforce the absolute threshold: 4 % failures pass against a 4 % baseline', () => {
    expect(compareToBaseline(sweep(0.04), baseline).ok).toBe(true);
  });

  it('rejects another scenario and an empty sweep', () => {
    expect(compareToBaseline(sweep(0.04, 0.99, 1000, 'other'), baseline).ok).toBe(false);
    expect(compareToBaseline(sweep(0, 0.99, 0), baseline).ok).toBe(false);
  });
});

describe('parseBaseline and parseCorpus', () => {
  it('parse valid files', () => {
    expect(parseBaseline(JSON.stringify(baseline))).toEqual(baseline);
    const corpus = parseCorpus(
      JSON.stringify({ scenarioId: 's', seeds: [{ seed: '7', expect: 'pass', note: 'why' }] }),
    );
    expect(corpus.seeds[0]?.seed).toBe('7');
  });

  it('give clear errors for broken input', () => {
    expect(() => parseBaseline('{', 'b.json')).toThrow('b.json is not valid JSON');
    expect(() => parseBaseline('{"scenarioId":"s"}')).toThrow('"from" must be');
    expect(() => parseBaseline(JSON.stringify({ ...baseline, failureRate: 4 }))).toThrow(
      '"failureRate" must be',
    );
    expect(() => parseCorpus('[]')).toThrow('must be a JSON object');
    expect(() => parseCorpus('{"scenarioId":"s","seeds":{}}')).toThrow('"seeds" must be an array');
    const entry = (seed: unknown, expectation: unknown) =>
      JSON.stringify({ scenarioId: 's', seeds: [{ seed, expect: expectation, note: 'n' }] });
    expect(() => parseCorpus(entry('x1', 'pass'))).toThrow('decimal string');
    expect(() => parseCorpus(entry('1', 'maybe'))).toThrow('"pass" or "fail"');
    const twice = { seed: '1', expect: 'pass', note: 'n' };
    expect(() => parseCorpus(JSON.stringify({ scenarioId: 's', seeds: [twice, twice] }))).toThrow(
      'duplicate seed 1',
    );
  });
});

describe('corpus', () => {
  const corpus: RegressionCorpus = {
    scenarioId: 's',
    seeds: [
      { seed: '1', expect: 'pass', note: 'a' },
      { seed: '2', expect: 'fail', note: 'b' },
    ],
  };

  it('flags a pass seed that stopped generating and notes a fixed known failure', () => {
    expect(
      checkCorpus(
        corpus,
        new Map([
          ['1', true],
          ['2', false],
        ]),
      ),
    ).toEqual({ ok: true, regressions: [], fixed: [] });
    expect(
      checkCorpus(
        corpus,
        new Map([
          ['1', false],
          ['2', true],
        ]),
      ),
    ).toEqual({ ok: false, regressions: ['1'], fixed: ['2'] });
    expect(() => checkCorpus(corpus, new Map())).toThrow('no outcome for corpus seed 1');
  });

  it('adds only unknown failed seeds, sorted by seed', () => {
    const report = {
      failedSeeds: [
        { seed: '2', firstError: 'known' },
        { seed: '10', firstError: 'V-UNIQUE:NOT_UNIQUE' },
        { seed: '3', firstError: 'X:Y' },
      ],
    };
    expect(newFailedSeeds(report, corpus).map(({ seed }) => seed)).toEqual(['10', '3']);
    const next = addFailedSeeds(corpus, report);
    expect(next.seeds.map(({ seed }) => seed)).toEqual(['1', '2', '3', '10']);
    expect(next.seeds[3]).toEqual({ seed: '10', expect: 'fail', note: 'V-UNIQUE:NOT_UNIQUE' });
    expect(addFailedSeeds(next, report)).toEqual(next);
  });
});
