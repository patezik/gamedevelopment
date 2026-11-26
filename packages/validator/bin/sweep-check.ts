#!/usr/bin/env -S node --experimental-transform-types
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  addFailedSeeds,
  baselineFromReport,
  compareToBaseline,
  newFailedSeeds,
  parseBaseline,
  parseCorpus,
  renderCorpus,
  type SweepReport,
} from '../src/index.ts';

// VAL-008: compares an hs-sweep JSON report with the recorded baseline and the regression corpus.
const root = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const USAGE = `Usage: sweep-check --report <sweep.json> [--baseline <file>] [--corpus <file>] [--summary <file>]
                   [--update-baseline | --add-failed]
  default check     exit 1 when the failure rate or culprit entropy is worse than the baseline
  --update-baseline write the baseline from the report (also SWEEP_BASELINE_UPDATE=1)
  --add-failed      add the failed seeds of the report to the corpus as known failures`;
const VALUE_FLAGS = ['--report', '--baseline', '--corpus', '--summary'];
const SWITCHES = ['--update-baseline', '--add-failed'];

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const values = new Map<string, string>();
const switches = new Set<string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i]!;
  if (SWITCHES.includes(flag)) {
    switches.add(flag);
  } else if (VALUE_FLAGS.includes(flag)) {
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) usage(`${flag} needs a value`);
    values.set(flag, value);
  } else {
    usage(`Unknown argument ${flag}`);
  }
}
const reportPath = values.get('--report');
if (reportPath === undefined) usage('--report is required');
const baselinePath = values.get('--baseline') ?? root('sweep-baseline.json');
const corpusPath = values.get('--corpus') ?? root('regression-seeds.json');
const summaryPath = values.get('--summary');
const update = switches.has('--update-baseline') || process.env['SWEEP_BASELINE_UPDATE'] === '1';

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    process.stderr.write(`Cannot read ${what}: ${path}\n`);
    process.exit(2);
  }
}

function fail(error: unknown): never {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

let report: SweepReport;
try {
  report = JSON.parse(read(reportPath, 'the sweep report')) as SweepReport;
} catch (error) {
  fail(error);
}
if (typeof report.scenarioId !== 'string' || !Array.isArray(report.failedSeeds)) {
  fail(new Error(`${reportPath} is not an hs-sweep JSON report`));
}

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineFromReport(report), null, 2)}\n`);
  process.stdout.write(`Baseline written: ${baselinePath}\n`);
  process.exit(0);
}

try {
  const corpus = parseCorpus(read(corpusPath, 'the regression corpus'), corpusPath);
  if (switches.has('--add-failed')) {
    if (corpus.scenarioId !== report.scenarioId) {
      fail(
        new Error(`the corpus is for ${corpus.scenarioId}, the report is for ${report.scenarioId}`),
      );
    }
    const added = newFailedSeeds(report, corpus);
    writeFileSync(corpusPath, renderCorpus(addFailedSeeds(corpus, report)));
    process.stdout.write(`Added ${added.length} failed seed(s) to ${corpusPath}\n`);
    process.exit(0);
  }

  const baseline = parseBaseline(read(baselinePath, 'the baseline'), baselinePath);
  const comparison = compareToBaseline(report, baseline);
  const fresh = corpus.scenarioId === report.scenarioId ? newFailedSeeds(report, corpus) : [];
  const lines = [
    `${report.scenarioId} seeds ${report.from}..${report.from + report.count - 1}: ` +
      `failure rate ${(report.failureRate * 100).toFixed(2)} % ` +
      `(baseline ${(baseline.failureRate * 100).toFixed(2)} % on ${baseline.count} seeds), ` +
      `culprit entropy ratio ${report.entropy.ratio.toFixed(3)} (baseline ${baseline.entropyRatio.toFixed(3)})`,
    ...comparison.regressions.map((text) => `REGRESSION: ${text}`),
    ...comparison.improvements.map(
      (text) => `Improvement: ${text}; refresh the baseline (SWEEP_BASELINE_UPDATE=1).`,
    ),
    ...(report.verdict.ok
      ? []
      : [
          `Warning: the MVP thresholds are not met (${report.verdict.violations.join('; ')}). ` +
            'This is not a regression: only worsening against the baseline fails.',
        ]),
    fresh.length === 0
      ? 'No failed seeds outside the corpus.'
      : `${fresh.length} failed seed(s) outside the corpus: ${fresh.map(({ seed }) => seed).join(', ')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (summaryPath !== undefined) {
    const table = fresh.map(({ seed, firstError }) => `| ${seed} | \`${firstError}\` |`);
    const summary = [
      `### Sweep ${report.scenarioId}: ${comparison.ok ? 'no regression' : 'REGRESSION'}`,
      '',
      ...lines.map((line) => `- ${line}`),
      '',
      ...(fresh.length > 0 ? ['| seed | first error |', '| --- | --- |', ...table, ''] : []),
    ];
    appendFileSync(summaryPath, `${summary.join('\n')}\n`);
  }
  process.exitCode = comparison.ok ? 0 : 1;
} catch (error) {
  fail(error);
}
