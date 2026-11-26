#!/usr/bin/env -S node --experimental-transform-types
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_SWEEP_THRESHOLDS, renderSweepMarkdown } from '../src/index.ts';
import { defaultWorkers, runSweep } from './sweep-run.ts';

const USAGE = `Usage: hs-sweep --scenario <id> [--count 1000] [--from 0] [--out reports] [--workers n]
                [--content-dir <dir>] [--max-failure-rate 0.01] [--min-entropy-ratio 0.8]`;
const FLAGS = [
  '--scenario',
  '--count',
  '--from',
  '--out',
  '--workers',
  '--content-dir',
  '--max-failure-rate',
  '--min-entropy-ratio',
];

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const values = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i]!;
  if (!FLAGS.includes(flag)) usage(`Unknown argument ${flag}`);
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) usage(`${flag} needs a value`);
  values.set(flag, value);
}
const scenarioId = values.get('--scenario');
if (scenarioId === undefined) usage('--scenario is required');

function number(flag: string, fallback: number, integer: boolean, min: number): number {
  const text = values.get(flag);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min) {
    usage(`${flag} must be ${integer ? 'an integer' : 'a number'} >= ${min}`);
  }
  return value;
}

const count = number('--count', 1000, true, 1);
const from = number('--from', 0, true, 0);
const workers = number('--workers', defaultWorkers(), true, 1);
const out = values.get('--out') ?? 'reports';
const thresholds = {
  maxFailureRate: number('--max-failure-rate', DEFAULT_SWEEP_THRESHOLDS.maxFailureRate, false, 0),
  minEntropyRatio: number(
    '--min-entropy-ratio',
    DEFAULT_SWEEP_THRESHOLDS.minEntropyRatio,
    false,
    0,
  ),
};
const contentDir = values.get('--content-dir');

let report;
try {
  report = await runSweep({
    scenarioId,
    count,
    from,
    workers,
    thresholds,
    ...(contentDir !== undefined && { contentDir }),
  });
} catch (error) {
  process.stderr.write(`Sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const base = `${out.replace(/\/$/, '')}/sweep-${scenarioId}-${from}-${count}`;
mkdirSync(out, { recursive: true });
writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${base}.md`, renderSweepMarkdown(report));
process.stdout.write(
  `${scenarioId} seeds ${from}..${from + count - 1}: ${report.succeeded}/${report.count} generated, ` +
    `culprit entropy ${report.entropy.culpritBits.toFixed(3)}/${report.entropy.maxBits.toFixed(3)} bits, ` +
    `${(report.timing.wallMs / 1000).toFixed(1)} s\nReport: ${base}.json, ${base}.md\n`,
);
if (!report.verdict.ok) {
  const lines = report.verdict.violations.map((violation) => `- ${violation}\n`).join('');
  process.stderr.write(`Thresholds violated:\n${lines}`);
  process.exitCode = 1;
}
