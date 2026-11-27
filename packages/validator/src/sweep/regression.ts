/**
 * Sweep regression control (VAL-008, validation.md §5, testing-strategy.md §2).
 * Pure and deterministic: files are parsed from text here, read and written by the callers.
 *
 * Two files sit next to each other in `packages/validator`:
 * - `regression-seeds.json`: the corpus of seeds that must keep the recorded outcome;
 * - `sweep-baseline.json`: the recorded quality of a sweep (failure rate, culprit entropy).
 */
import type { SweepReport } from './sweep.ts';

export type SeedExpectation = 'pass' | 'fail';

export interface CorpusSeed {
  readonly seed: string;
  /** `pass`: generation must succeed (a regression otherwise); `fail`: a known failure. */
  readonly expect: SeedExpectation;
  /** Why the seed is here: the first rejection reason, or the bug it caught. */
  readonly note: string;
}

export interface RegressionCorpus {
  readonly scenarioId: string;
  readonly seeds: readonly CorpusSeed[];
}

export interface SweepBaseline {
  readonly scenarioId: string;
  /** The range the numbers were measured on (rates stay comparable across ranges). */
  readonly from: number;
  readonly count: number;
  readonly failureRate: number;
  readonly entropyRatio: number;
}

export interface BaselineTolerance {
  /** Absolute growth of the failure rate that is still accepted. */
  readonly failureRate: number;
  /** Absolute drop of the entropy ratio that is still accepted. */
  readonly entropyRatio: number;
}

export const DEFAULT_BASELINE_TOLERANCE: BaselineTolerance = {
  failureRate: 0.005,
  entropyRatio: 0.02,
};

export interface BaselineComparison {
  readonly ok: boolean;
  readonly regressions: readonly string[];
  readonly improvements: readonly string[];
}

function parseJson(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return asObject(value, what);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function field<T>(
  source: Record<string, unknown>,
  name: string,
  what: string,
  valid: (value: unknown) => value is T,
  expected: string,
): T {
  const value = source[name];
  if (!valid(value)) throw new Error(`${what}: "${name}" must be ${expected}`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isRate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseBaseline(text: string, what = 'sweep baseline'): SweepBaseline {
  const source = parseJson(text, what);
  return {
    scenarioId: field(source, 'scenarioId', what, isString, 'a non-empty string'),
    from: field(source, 'from', what, isCount, 'a non-negative integer'),
    count: field(source, 'count', what, isCount, 'a non-negative integer'),
    failureRate: field(source, 'failureRate', what, isRate, 'a number in [0, 1]'),
    entropyRatio: field(source, 'entropyRatio', what, isRate, 'a number in [0, 1]'),
  };
}

export function parseCorpus(text: string, what = 'regression corpus'): RegressionCorpus {
  const source = parseJson(text, what);
  const scenarioId = field(source, 'scenarioId', what, isString, 'a non-empty string');
  const list = source['seeds'];
  if (!Array.isArray(list)) throw new Error(`${what}: "seeds" must be an array`);
  const seen = new Set<string>();
  const seeds = list.map((entry: unknown, index): CorpusSeed => {
    const where = `${what}: seeds[${index}]`;
    const item = asObject(entry, where);
    const seed = field(item, 'seed', where, isString, 'a non-empty string');
    if (!/^\d+$/.test(seed)) throw new Error(`${where}: "seed" must be a decimal string`);
    if (seen.has(seed)) throw new Error(`${where}: duplicate seed ${seed}`);
    seen.add(seed);
    const expect = item['expect'];
    if (expect !== 'pass' && expect !== 'fail') {
      throw new Error(`${where}: "expect" must be "pass" or "fail"`);
    }
    return { seed, expect, note: field(item, 'note', where, isString, 'a non-empty string') };
  });
  return { scenarioId, seeds };
}

export function baselineFromReport(report: SweepReport): SweepBaseline {
  return {
    scenarioId: report.scenarioId,
    from: report.from,
    count: report.count,
    failureRate: report.failureRate,
    entropyRatio: report.entropy.ratio,
  };
}

const percent = (value: number) => `${(value * 100).toFixed(2)} %`;

/**
 * Compares a sweep with the recorded baseline. A regression is a failure rate above the baseline
 * by more than the tolerance, or culprit entropy below it by more than the tolerance. Anything
 * not worse is accepted, so the absolute MVP threshold (failures < 1 %) is not enforced here.
 */
export function compareToBaseline(
  report: Pick<SweepReport, 'scenarioId' | 'failureRate' | 'entropy' | 'count'>,
  baseline: SweepBaseline,
  tolerance: BaselineTolerance = DEFAULT_BASELINE_TOLERANCE,
): BaselineComparison {
  const regressions: string[] = [];
  const improvements: string[] = [];
  if (report.scenarioId !== baseline.scenarioId) {
    regressions.push(
      `the baseline is for ${baseline.scenarioId}, the sweep is for ${report.scenarioId}`,
    );
  }
  if (report.count === 0) regressions.push('no seeds were swept');
  if (regressions.length > 0) return { ok: false, regressions, improvements };

  const failureDelta = report.failureRate - baseline.failureRate;
  if (failureDelta > tolerance.failureRate) {
    regressions.push(
      `failure rate ${percent(report.failureRate)} is above the baseline ${percent(baseline.failureRate)} by more than ${percent(tolerance.failureRate)}`,
    );
  } else if (failureDelta < -tolerance.failureRate) {
    improvements.push(
      `failure rate ${percent(report.failureRate)} is below the baseline ${percent(baseline.failureRate)}`,
    );
  }
  const entropyDelta = report.entropy.ratio - baseline.entropyRatio;
  if (entropyDelta < -tolerance.entropyRatio) {
    regressions.push(
      `culprit entropy ratio ${report.entropy.ratio.toFixed(3)} is below the baseline ${baseline.entropyRatio.toFixed(3)} by more than ${tolerance.entropyRatio}`,
    );
  } else if (entropyDelta > tolerance.entropyRatio) {
    improvements.push(
      `culprit entropy ratio ${report.entropy.ratio.toFixed(3)} is above the baseline ${baseline.entropyRatio.toFixed(3)}`,
    );
  }
  return { ok: regressions.length === 0, regressions, improvements };
}

export interface CorpusVerdict {
  readonly ok: boolean;
  /** `pass` seeds that no longer generate. */
  readonly regressions: readonly string[];
  /** `fail` seeds that now generate: not an error, the entry should be moved to `pass`. */
  readonly fixed: readonly string[];
}

/** Checks the corpus against the outcomes (`seed -> generated`) of a run. */
export function checkCorpus(
  corpus: RegressionCorpus,
  generated: ReadonlyMap<string, boolean>,
): CorpusVerdict {
  const regressions: string[] = [];
  const fixed: string[] = [];
  for (const { seed, expect } of corpus.seeds) {
    const ok = generated.get(seed);
    if (ok === undefined) throw new Error(`no outcome for corpus seed ${seed}`);
    if (expect === 'pass' && !ok) regressions.push(seed);
    if (expect === 'fail' && ok) fixed.push(seed);
  }
  return { ok: regressions.length === 0, regressions, fixed };
}

/** Failed seeds of the report that the corpus does not know yet. */
export function newFailedSeeds(
  report: Pick<SweepReport, 'failedSeeds'>,
  corpus: RegressionCorpus,
): readonly { readonly seed: string; readonly firstError: string }[] {
  const known = new Set(corpus.seeds.map(({ seed }) => seed));
  return report.failedSeeds.filter(({ seed }) => !known.has(seed));
}

/** The corpus plus the new failed seeds of the report as `fail` entries, sorted by seed. */
export function addFailedSeeds(
  corpus: RegressionCorpus,
  report: Pick<SweepReport, 'failedSeeds'>,
): RegressionCorpus {
  const added: CorpusSeed[] = newFailedSeeds(report, corpus).map(({ seed, firstError }) => ({
    seed,
    expect: 'fail',
    note: firstError,
  }));
  const seeds = [...corpus.seeds, ...added].sort((a, b) => Number(a.seed) - Number(b.seed));
  return { scenarioId: corpus.scenarioId, seeds };
}

export function renderCorpus(corpus: RegressionCorpus): string {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}
