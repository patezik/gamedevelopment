import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { snapshotInvestigation } from '@hs/core/game';
import type { Check } from '@hs/validator';
import { generateInvestigation, type InvestigationReport } from './generate.ts';

const USAGE = 'Usage: hs-gen --scenario <id> --seed <seed> [--debug-truth] [--content-dir <dir>]';
const SCENARIOS = new URL('../../../content/scenarios/', import.meta.url);

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Args {
  readonly scenario: string;
  readonly seed: string;
  readonly debugTruth: boolean;
  readonly contentDir: string;
}

function parse(argv: readonly string[]): Args | string {
  const values = new Map<string, string>();
  let debugTruth = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--debug-truth') debugTruth = true;
    else if (flag === '--scenario' || flag === '--seed' || flag === '--content-dir') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return `${flag} needs a value`;
      values.set(flag, value);
    } else return `Unknown argument ${flag}`;
  }
  const scenario = values.get('--scenario');
  const seed = values.get('--seed');
  if (scenario === undefined || seed === undefined) return '--scenario and --seed are required';
  return {
    scenario,
    seed,
    debugTruth,
    contentDir: values.get('--content-dir') ?? fileURLToPath(SCENARIOS),
  };
}

/** Failure reasons without the messages: those name characters, items and so the truth. */
function failures({ attempts, validations }: InvestigationReport) {
  return attempts.map(({ number, rejection }) => ({
    attempt: number,
    reasons: rejection
      ? [rejection.code]
      : (validations.find(({ attempt }) => attempt === number)?.findings ?? [])
          .filter(({ severity }) => severity === 'error')
          .map(({ checkId, code }) => `${checkId}:${code}`),
  }));
}

/**
 * `hs-gen`: generates one investigation and prints JSON. Without `--debug-truth` the output holds
 * only the public facts (hash, version, attempt count); with it, the whole investigation (the
 * truth) and the generation report, for developers. `checks` replaces the default gate (tests).
 */
export function runCli(
  argv: readonly string[],
  options: { now?: () => number; checks?: readonly Check[] } = {},
): CliResult {
  const args = parse(argv);
  if (typeof args === 'string') {
    return { code: 2, stdout: '', stderr: `${args}\n${USAGE}\n` };
  }
  let content;
  try {
    content = loadScenarioFromDir(`${args.contentDir.replace(/\/$/, '')}/${args.scenario}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { code: 2, stdout: '', stderr: `Cannot load scenario ${args.scenario}: ${reason}\n` };
  }
  const { now, checks } = options;
  const result = generateInvestigation({ scenarioId: args.scenario, seed: args.seed }, content, {
    ...(now && { now }),
    ...(checks && { checks }),
  });
  const { report } = result;
  const common = {
    scenarioId: args.scenario,
    seed: args.seed,
    generatorVersion: report.generatorVersion,
    attempts: report.attempts.length,
  };
  const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  if (!result.ok) {
    const body = { ok: false, error: result.error, ...common, failures: failures(report) };
    return { code: 1, stdout: text(args.debugTruth ? { ...body, report } : body), stderr: '' };
  }
  const body = { ok: true, ...common, investigationHash: result.investigationHash };
  return {
    code: 0,
    stdout: text(
      args.debugTruth
        ? { ...body, investigation: snapshotInvestigation(result.investigation), report }
        : body,
    ),
    stderr: '',
  };
}
