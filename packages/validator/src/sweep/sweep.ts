/**
 * Seed sweep (validation.md §5): per-seed records, the aggregated report and the CI thresholds.
 * Pure and deterministic: no clock, no I/O. The runner (`bin/`) measures time and writes files.
 * The report names culprits, so it is server diagnostics and never reaches a client view.
 */

/** The part of a generation result a sweep reads (structural: `@hs/generator` is not imported). */
export interface SweepGeneration {
  readonly ok: boolean;
  readonly investigationHash?: string;
  readonly investigation?: {
    readonly characters: readonly unknown[];
    readonly truth: { readonly incident: { readonly culpritIds: readonly string[] } };
  };
  readonly report: {
    readonly attempts: readonly SweepAttempt[];
    readonly validations: readonly {
      readonly attempt: number;
      readonly findings: readonly {
        readonly checkId: string;
        readonly severity: string;
        readonly code: string;
      }[];
    }[];
    readonly chosen?: {
      readonly victimArchetype: string;
      readonly culpritArchetype: string;
      readonly template: string;
      readonly motiveType: string;
    };
  };
}

interface SweepAttempt {
  readonly number: number;
  readonly rejection?: { readonly stage: string; readonly code: string };
}

/** Outcome of one seed. Contains no timings, so it does not depend on the machine. */
export interface SweepRecord {
  readonly seed: string;
  readonly ok: boolean;
  readonly attempts: number;
  /** Failed seeds: why the first attempt was rejected (`stage:code` or `checkId:code`). */
  readonly firstError?: string;
  /** Failed seeds: the rejection reason of every attempt. */
  readonly errors?: readonly string[];
  readonly investigationHash?: string;
  readonly characters?: number;
  readonly culpritIds?: readonly string[];
  readonly culpritArchetype?: string;
  readonly victimArchetype?: string;
  readonly template?: string;
  readonly motiveType?: string;
}

export interface SweepThresholds {
  /** Failed seeds must stay strictly below this share (validation.md §5: 1 %). */
  readonly maxFailureRate: number;
  /** Culprit entropy must be at least this share of log2(characters) (validation.md §5: 0.8). */
  readonly minEntropyRatio: number;
}

export const DEFAULT_SWEEP_THRESHOLDS: SweepThresholds = {
  maxFailureRate: 0.01,
  minEntropyRatio: 0.8,
};

export interface SweepTiming {
  readonly meanMs: number;
  readonly maxMs: number;
  readonly maxSeed: string;
  /** Wall-clock time of the whole sweep. */
  readonly wallMs: number;
}

export interface SweepParams {
  readonly scenarioId: string;
  readonly from: number;
  readonly generatorVersion: string;
}

export type Distribution = Readonly<Record<string, number>>;

export interface SweepReport {
  readonly scenarioId: string;
  readonly generatorVersion: string;
  readonly from: number;
  readonly count: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly successRate: number;
  readonly failureRate: number;
  /** Seeds accepted by the first attempt, that is, passing the gate without repair. */
  readonly firstAttemptRate: number;
  /** Attempts per seed: how many seeds needed that many attempts (failed seeds used them all). */
  readonly attempts: Distribution;
  /** Rejection reasons over every attempt of every failed seed: what the gate rejects most. */
  readonly attemptRejections: Distribution;
  readonly culpritsByCharacter: Distribution;
  readonly culpritsByArchetype: Distribution;
  readonly victimsByArchetype: Distribution;
  readonly motives: Distribution;
  readonly incidentTemplates: Distribution;
  readonly entropy: {
    /** Shannon entropy of the culprit character, bits. */
    readonly culpritBits: number;
    /** log2 of the cast size. */
    readonly maxBits: number;
    readonly ratio: number;
    readonly archetypeBits: number;
  };
  readonly failedSeeds: readonly { readonly seed: string; readonly firstError: string }[];
  readonly thresholds: SweepThresholds;
  readonly verdict: { readonly ok: boolean; readonly violations: readonly string[] };
  /** The only machine-dependent part of the report. */
  readonly timing: SweepTiming;
}

function attemptError(result: SweepGeneration, attempt: SweepAttempt): string {
  if (attempt.rejection) return `${attempt.rejection.stage}:${attempt.rejection.code}`;
  const finding = result.report.validations
    .find((entry) => entry.attempt === attempt.number)
    ?.findings.find(({ severity }) => severity === 'error');
  return finding ? `${finding.checkId}:${finding.code}` : 'unknown';
}

export function sweepRecord(seed: string, result: SweepGeneration): SweepRecord {
  const attempts = result.report.attempts.length;
  const { investigation } = result;
  if (!result.ok || !investigation) {
    const errors = result.report.attempts.map((attempt) => attemptError(result, attempt));
    return { seed, ok: false, attempts, firstError: errors[0] ?? 'unknown', errors };
  }
  const { chosen } = result.report;
  return {
    seed,
    ok: true,
    attempts,
    ...(result.investigationHash !== undefined && { investigationHash: result.investigationHash }),
    characters: investigation.characters.length,
    culpritIds: [...investigation.truth.incident.culpritIds],
    ...(chosen && {
      culpritArchetype: chosen.culpritArchetype,
      victimArchetype: chosen.victimArchetype,
      template: chosen.template,
      motiveType: chosen.motiveType,
    }),
  };
}

/** Shannon entropy in bits of a histogram. */
export function entropyBits(counts: Iterable<number>): number {
  const values = [...counts].filter((count) => count > 0);
  const total = values.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  const bits = -values.reduce((sum, count) => sum + (count / total) * Math.log2(count / total), 0);
  // -0 for a single outcome; keep the report free of it.
  return bits === 0 ? 0 : bits;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function histogram(keys: Iterable<string>): Distribution {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a, x], [b, y]) => y - x || compare(a, b)));
}

function numericHistogram(keys: Iterable<number>): Distribution {
  const counts = new Map<number, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => a - b));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function evaluateThresholds(
  report: Pick<SweepReport, 'failureRate' | 'entropy' | 'count'>,
  thresholds: SweepThresholds,
): SweepReport['verdict'] {
  const violations: string[] = [];
  if (report.count === 0) violations.push('no seeds were swept');
  if (report.failureRate >= thresholds.maxFailureRate) {
    violations.push(
      `failure rate ${(report.failureRate * 100).toFixed(2)} % is not below ${(thresholds.maxFailureRate * 100).toFixed(2)} %`,
    );
  }
  const minimum = thresholds.minEntropyRatio * report.entropy.maxBits;
  if (report.entropy.culpritBits < minimum) {
    violations.push(
      `culprit entropy ${report.entropy.culpritBits.toFixed(3)} bits is below ${minimum.toFixed(3)} (${thresholds.minEntropyRatio} * log2 of the cast, ${report.entropy.maxBits.toFixed(3)})`,
    );
  }
  return { ok: violations.length === 0, violations };
}

/** Aggregates the records (in any order: they are sorted by seed first) into the report. */
export function aggregateSweep(
  records: readonly SweepRecord[],
  params: SweepParams,
  timing: SweepTiming,
  thresholds: SweepThresholds = DEFAULT_SWEEP_THRESHOLDS,
): SweepReport {
  const sorted = [...records].sort(
    (a, b) => a.seed.length - b.seed.length || compare(a.seed, b.seed),
  );
  const accepted = sorted.filter(({ ok }) => ok);
  const failedRecords = sorted.filter(({ ok }) => !ok);
  const count = sorted.length;
  const culprits = histogram(accepted.flatMap(({ culpritIds }) => culpritIds ?? []));
  const archetypes = histogram(accepted.flatMap(({ culpritArchetype }) => culpritArchetype ?? []));
  const castSize = Math.max(0, ...accepted.map(({ characters }) => characters ?? 0));
  const maxBits = castSize > 1 ? Math.log2(castSize) : 0;
  const culpritBits = entropyBits(Object.values(culprits));
  const failureRate = round(count === 0 ? 0 : failedRecords.length / count);
  const entropy = {
    culpritBits: round(culpritBits),
    maxBits: round(maxBits),
    ratio: round(maxBits === 0 ? 0 : culpritBits / maxBits),
    archetypeBits: round(entropyBits(Object.values(archetypes))),
  };
  return {
    scenarioId: params.scenarioId,
    generatorVersion: params.generatorVersion,
    from: params.from,
    count,
    succeeded: accepted.length,
    failed: failedRecords.length,
    successRate: round(count === 0 ? 0 : accepted.length / count),
    failureRate,
    firstAttemptRate: round(
      count === 0 ? 0 : accepted.filter(({ attempts }) => attempts === 1).length / count,
    ),
    attempts: numericHistogram(sorted.map(({ attempts }) => attempts)),
    attemptRejections: histogram(sorted.flatMap(({ errors }) => errors ?? [])),
    culpritsByCharacter: culprits,
    culpritsByArchetype: archetypes,
    victimsByArchetype: histogram(accepted.flatMap(({ victimArchetype }) => victimArchetype ?? [])),
    motives: histogram(accepted.flatMap(({ motiveType }) => motiveType ?? [])),
    incidentTemplates: histogram(accepted.flatMap(({ template }) => template ?? [])),
    entropy,
    failedSeeds: failedRecords.map(({ seed, firstError }) => ({
      seed,
      firstError: firstError ?? 'unknown',
    })),
    thresholds,
    // The unrounded rate decides: 0.995 % must not round up to a pass or down to a failure.
    verdict: evaluateThresholds(
      {
        count,
        failureRate: count === 0 ? 0 : failedRecords.length / count,
        entropy: { ...entropy, culpritBits, maxBits },
      },
      thresholds,
    ),
    timing,
  };
}

function table(title: string, distribution: Distribution, total: number): string[] {
  const rows = Object.entries(distribution);
  if (rows.length === 0) return [`### ${title}`, '', '_нет данных_', ''];
  return [
    `### ${title}`,
    '',
    '| Значение | Число | Доля |',
    '|----------|------:|-----:|',
    ...rows.map(
      ([key, value]) =>
        `| \`${key}\` | ${value} | ${total === 0 ? '0' : ((value / total) * 100).toFixed(1)} % |`,
    ),
    '',
  ];
}

const FAILED_LIST_LIMIT = 50;

/** Markdown view of the report (validation.md §5). */
export function renderSweepMarkdown(report: SweepReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(2)} %`;
  const { entropy, timing, verdict } = report;
  const rejections = Object.values(report.attemptRejections).reduce((a, b) => a + b, 0);
  const lines = [
    `# Seed sweep: ${report.scenarioId}, seed ${report.from}..${report.from + report.count - 1}`,
    '',
    `Генератор \`${report.generatorVersion}\`. Отчёт называет виновников: это диагностика сервера, не для клиентов.`,
    '',
    `## Вердикт: ${verdict.ok ? 'пороги выполнены' : 'ПОРОГИ НАРУШЕНЫ'}`,
    '',
    ...(verdict.violations.length > 0
      ? verdict.violations.map((text) => `- ${text}`)
      : ['- нарушений нет']),
    '',
    `Пороги: неудач < ${percent(report.thresholds.maxFailureRate)}; энтропия виновников >= ${report.thresholds.minEntropyRatio} * log2(N).`,
    '',
    '## Генерация',
    '',
    `- Seed: ${report.count}, успешно ${report.succeeded} (${percent(report.successRate)}), неудач ${report.failed} (${percent(report.failureRate)}).`,
    `- Принято с первой попытки: ${percent(report.firstAttemptRate)}.`,
    `- Время на seed: среднее ${timing.meanMs.toFixed(1)} мс, максимум ${timing.maxMs.toFixed(1)} мс (seed ${timing.maxSeed}); всего ${(timing.wallMs / 1000).toFixed(1)} с.`,
    '',
    ...table('Число попыток на seed', report.attempts, report.count),
    ...table('Причины отклонения попыток проваленных seed', report.attemptRejections, rejections),
    '## Виновники',
    '',
    `- Энтропия по персонажам: ${entropy.culpritBits.toFixed(3)} бит из ${entropy.maxBits.toFixed(3)} (${percent(entropy.ratio)}); по архетипам: ${entropy.archetypeBits.toFixed(3)} бит.`,
    '',
    ...table('По персонажам', report.culpritsByCharacter, report.succeeded),
    ...table('По архетипам', report.culpritsByArchetype, report.succeeded),
    ...table('Жертвы по архетипам', report.victimsByArchetype, report.succeeded),
    ...table('Мотивы', report.motives, report.succeeded),
    ...table('Типы инцидентов', report.incidentTemplates, report.succeeded),
    '## Проваленные seed',
    '',
    ...(report.failedSeeds.length === 0
      ? ['_нет_']
      : [
          '| Seed | Первая ошибка |',
          '|------|---------------|',
          ...report.failedSeeds
            .slice(0, FAILED_LIST_LIMIT)
            .map(({ seed, firstError }) => `| ${seed} | \`${firstError}\` |`),
          ...(report.failedSeeds.length > FAILED_LIST_LIMIT
            ? [
                '',
                `Показаны первые ${FAILED_LIST_LIMIT} из ${report.failedSeeds.length}; полный список в JSON.`,
              ]
            : []),
        ]),
    '',
  ];
  return lines.join('\n');
}
