import type { Character } from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import {
  assessIncidents,
  castGen,
  conflictGen,
  FEASIBILITY_CRITERIA,
  GenerationRejection,
  runPipeline,
  selectIncident,
  socialGen,
  worldGen,
  type ConflictWorld,
  type GeneratedWorld,
  type IncidentAssessment,
  type IncidentSelectionInput,
  type SocialWorld,
  type Stage,
} from '../src/index.ts';

/*
 * Incident feasibility sweep (CNT-003 acceptance). For every crime template of a scenario: the
 * seeds whose attempt-1 world has at least one feasible culprit (some victim, some character), by
 * IncidentSelection's `assessIncidents`. The output is deterministic. It holds server truth: keep
 * it out of player and phone views.
 */

export interface SweepOptions {
  readonly scenario: string;
  readonly from: number;
  readonly count: number;
  readonly threshold: number;
  readonly json: boolean;
}

/** The stages that build an IncidentSelection input; tests replace them. */
export interface InputStages {
  readonly world: Stage<undefined, GeneratedWorld>;
  readonly cast: Stage<unknown, Character[]>;
  readonly social: Stage<readonly Character[], SocialWorld>;
  readonly conflict: Stage<SocialWorld, ConflictWorld>;
}

export const DEFAULT_STAGES: InputStages = {
  world: worldGen,
  cast: castGen,
  social: socialGen,
  conflict: conflictGen,
};

/** A world that attempt 1 cannot build: a stage rejected its input (`GenerationRejection`). */
export interface RejectedSeed {
  readonly seed: string;
  readonly stage: string;
  readonly code: string;
}

export type SeedOutcome =
  | { readonly kind: 'rejected'; readonly rejection: RejectedSeed }
  | {
      readonly kind: 'assessed';
      readonly input: IncidentSelectionInput;
      readonly assessment: IncidentAssessment;
    };

/** An unexpected exception: a defect, not an unsolvable world. The sweep stops on it. */
export class SweepAborted extends Error {
  readonly seed: string;

  constructor(seed: string, cause: unknown) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(`Seed ${seed}: unexpected error, sweep stopped. ${detail}`, { cause });
    this.name = 'SweepAborted';
    this.seed = seed;
  }
}

const DIGITS = /^(0|[1-9]\d*)$/;

function wholeNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!DIGITS.test(value) || !Number.isSafeInteger(parsed)) {
    throw new RangeError(`--${name} must be a whole number within the safe integer range`);
  }
  return parsed;
}

/** Validates CLI values. The whole seed range `[from, from + count)` must stay safe integers. */
export function sweepOptions(values: {
  readonly scenario?: string | undefined;
  readonly from?: string | undefined;
  readonly count?: string | undefined;
  readonly threshold?: string | undefined;
  readonly json?: boolean | undefined;
}): SweepOptions {
  const from = wholeNumber('from', values.from ?? '0');
  const count = wholeNumber('count', values.count ?? '500');
  if (count === 0) throw new RangeError('--count must be at least 1');
  if (from > Number.MAX_SAFE_INTEGER - (count - 1)) {
    throw new RangeError('--from + --count - 1 exceeds the safe integer range');
  }
  const rawThreshold = values.threshold ?? '0.9';
  const threshold = Number(rawThreshold);
  if (rawThreshold.trim() === '' || !(threshold >= 0 && threshold <= 1)) {
    throw new RangeError('--threshold must be a number in [0, 1]');
  }
  const scenario = values.scenario ?? 'sanatorium_winter';
  if (!/^[a-z0-9_-]+$/.test(scenario)) throw new RangeError('--scenario must be a scenario id');
  return { scenario, from, count, threshold, json: values.json ?? false };
}

function rejectionOf(seed: string, stage: string, error: unknown): RejectedSeed {
  if (error instanceof GenerationRejection) return { seed, stage, code: error.code };
  throw new SweepAborted(seed, error);
}

/**
 * Builds the IncidentSelection input of attempt 1 of `seed` and assesses it. Every stage runs with
 * `maxAttempts: 1`, so all data come from the same attempt and its streams (`<seed>#1`), as in the
 * first attempt of the full pipeline. A rejection ends the seed; any other exception aborts.
 */
export function assessSeed(
  seed: string,
  content: ScenarioContent,
  stages: InputStages = DEFAULT_STAGES,
): SeedOutcome {
  const options = { seed, content, now: () => 0, maxAttempts: 1 };
  let world;
  let conflict;
  try {
    world = runPipeline([stages.world], undefined, options);
    conflict = world.ok
      ? runPipeline([stages.cast, stages.social, stages.conflict], undefined, options)
      : undefined;
  } catch (error) {
    throw new SweepAborted(seed, error);
  }
  for (const result of [world, conflict]) {
    if (result && !result.ok) {
      const rejection = result.report.attempts[0]?.rejection;
      return {
        kind: 'rejected',
        rejection: { seed, stage: rejection?.stage ?? 'unknown', code: rejection?.code ?? '' },
      };
    }
  }
  if (!world.ok || !conflict?.ok) throw new SweepAborted(seed, 'pipeline result is missing');
  const input: IncidentSelectionInput = { ...conflict.output, world: world.output };
  try {
    return { kind: 'assessed', input, assessment: assessIncidents(input, content) };
  } catch (error) {
    return { kind: 'rejected', rejection: rejectionOf(seed, 'IncidentSelection', error) };
  }
}

type Tally = Record<string, number>;

export interface TemplateResult {
  readonly template: string;
  readonly feasibleWorlds: number;
  readonly share: number;
  readonly pass: boolean;
}

export interface SweepReport {
  readonly scenario: string;
  readonly seeds: { readonly from: number; readonly to: number; readonly count: number };
  readonly threshold: number;
  readonly required: number;
  readonly results: readonly TemplateResult[];
  readonly anyTemplate: number;
  readonly withoutMotive: number;
  readonly rejectedSeeds: readonly RejectedSeed[];
  readonly motiveWorlds: Tally;
  readonly rejected: Record<string, Tally>;
  readonly victims: Record<string, Tally>;
  readonly culprits: Record<string, Tally>;
  readonly chosen: { readonly template: Tally; readonly motive: Tally; readonly culprit: Tally };
}

const add = (tally: Tally, key: string, by = 1) => (tally[key] = (tally[key] ?? 0) + by);
const perTemplate = (templates: readonly string[]) =>
  Object.fromEntries(templates.map((id): [string, Tally] => [id, {}]));

export function sweep(
  content: ScenarioContent,
  options: Pick<SweepOptions, 'from' | 'count' | 'threshold'>,
  stages: InputStages = DEFAULT_STAGES,
): SweepReport {
  const { from, count, threshold } = options;
  const minMotive = content.preset.incident.minMotive;
  const templates = content.preset.incident.templates.toSorted();
  const feasibleWorlds: Tally = Object.fromEntries(templates.map((id) => [id, 0]));
  const rejected = perTemplate(templates);
  const victims = perTemplate(templates);
  const culprits = perTemplate(templates);
  const motiveWorlds: Tally = {};
  const chosen = { template: {} as Tally, motive: {} as Tally, culprit: {} as Tally };
  const rejectedSeeds: RejectedSeed[] = [];
  let anyTemplate = 0;
  let withoutMotive = 0;

  for (let n = from; n < from + count; n++) {
    const seed = String(n);
    const outcome = assessSeed(seed, content, stages);
    if (outcome.kind === 'rejected') {
      rejectedSeeds.push(outcome.rejection);
      continue;
    }
    const { input, assessment } = outcome;
    const archetype = new Map(input.characters.map(({ id, archetypeId }) => [id, archetypeId]));
    const strong = input.motives.filter(({ strength }) => strength >= minMotive);
    if (strong.length === 0) withoutMotive++;
    for (const type of new Set(strong.map(({ motiveType }) => motiveType))) add(motiveWorlds, type);

    let any = false;
    for (const option of assessment.options) {
      const { templateId } = option;
      for (const criterion of FEASIBILITY_CRITERIA) {
        add(rejected[templateId]!, criterion, option.rejected[criterion]);
      }
      if (option.feasible.length === 0) continue;
      add(victims[templateId]!, archetype.get(option.victimId)!);
      for (const { characterId } of option.feasible) {
        add(culprits[templateId]!, archetype.get(characterId)!);
      }
    }
    for (const id of templates) {
      if (assessment.options.some((o) => o.templateId === id && o.feasible.length > 0)) {
        feasibleWorlds[id]!++;
        any = true;
      }
    }
    if (!any) continue;
    anyTemplate++;
    let incident;
    try {
      const stream = createRng(`${seed}#1`).fork('gen/IncidentSelection');
      ({ incident } = selectIncident(input, assessment, content, stream));
    } catch (error) {
      throw new SweepAborted(seed, error);
    }
    add(chosen.template, incident.templateId);
    add(chosen.motive, incident.motive.motiveType);
    add(chosen.culprit, archetype.get(incident.culpritId)!);
  }

  // Compare the boundary share directly: 0.07 * 100 rounds to 7.000000000000001.
  const belowOrAt = Math.floor(threshold * count);
  const required = belowOrAt / count >= threshold ? belowOrAt : belowOrAt + 1;
  return {
    scenario: content.preset.id,
    seeds: { from, to: from + count - 1, count },
    threshold,
    required,
    results: templates.map((template) => ({
      template,
      feasibleWorlds: feasibleWorlds[template]!,
      share: feasibleWorlds[template]! / count,
      pass: feasibleWorlds[template]! >= required,
    })),
    anyTemplate,
    withoutMotive,
    rejectedSeeds,
    motiveWorlds,
    rejected,
    victims,
    culprits,
    chosen,
  };
}

export function formatReport(report: SweepReport): string {
  const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
  const line = (tally: Tally) =>
    Object.entries(tally)
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  const { from, to, count } = report.seeds;
  const lines = [`${report.scenario}: seeds ${from}..${to}, need ${report.required}/${count}`];
  for (const { template, feasibleWorlds, share, pass } of report.results) {
    lines.push(
      `  ${pass ? 'PASS' : 'FAIL'} ${template}: ${feasibleWorlds}/${count} (${percent(share)})`,
    );
    lines.push(`       rejected by first failed criterion: ${line(report.rejected[template]!)}`);
    lines.push(`       victims (worlds): ${line(report.victims[template]!)}`);
  }
  const rejectedSeeds = report.rejectedSeeds
    .map(({ seed, stage, code }) => `${seed}:${stage}:${code}`)
    .join(', ');
  lines.push(
    `  any template: ${report.anyTemplate}/${count}; worlds without a motive: ${report.withoutMotive}`,
    `  rejected in attempt 1: ${rejectedSeeds || 'none'}`,
    `  worlds per motive type: ${line(report.motiveWorlds)}`,
    `  chosen template: ${line(report.chosen.template)}`,
    `  chosen motive: ${line(report.chosen.motive)}`,
    `  chosen culprit archetype: ${line(report.chosen.culprit)}`,
  );
  return lines.join('\n');
}
