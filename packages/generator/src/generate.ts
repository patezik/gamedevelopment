import type { Character } from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import { InvestigationBuilder, type Investigation } from '@hs/core/game';
import { compileDeductionRules, type HeardStatement } from '@hs/core/investigation';
import type { Question } from '@hs/core/knowledge';
import {
  DEFAULT_CHECKS,
  SOLVER_CHECKS,
  TESTIMONY_CHECKS,
  collectTestimony,
  determinismCheck,
  investigationHash,
  validateInvestigation,
  type Check,
  type Finding,
  type ValidationContext,
} from '@hs/validator';
import {
  GENERATOR_VERSION,
  runPipeline,
  type GenerationReport,
  type Stage,
} from './pipeline/index.ts';
import { castGen } from './stages/cast-gen.ts';
import { conflictGen, type ConflictWorld } from './stages/conflict-gen.ts';
import { evidenceGen } from './stages/evidence-gen.ts';
import { historySimulation } from './stages/history-sim.ts';
import { incidentSelection } from './stages/incident-selection.ts';
import { plotPlanning } from './stages/plot-planning.ts';
import { redHerrings, type RedHerringWorld } from './stages/red-herrings.ts';
import { socialGen, type SocialWorld } from './stages/social-gen.ts';
import { testimonyGen } from './stages/testimony-gen.ts';
import { worldGen, type GeneratedWorld } from './stages/world-gen.ts';

/** Checks that gate a generated investigation, in the order validation.md lists them. */
export const GENERATION_CHECKS: readonly Check[] = [
  ...DEFAULT_CHECKS.filter(({ id }) => id !== determinismCheck.id),
  ...SOLVER_CHECKS,
  ...TESTIMONY_CHECKS,
];

export interface GenerationRequest {
  readonly scenarioId: string;
  readonly seed: string;
}

export interface GenerateOptions {
  readonly maxAttempts?: number;
  /** Checks of the gate (default `GENERATION_CHECKS`; `V-DETERMINISM` is always added). */
  readonly checks?: readonly Check[];
  /** Clock for the stage timings of the report (the generator never reads the wall clock). */
  readonly now?: () => number;
}

/** What the validation gate found in one attempt. Server diagnostics: it names the truth. */
export interface AttemptValidation {
  readonly attempt: number;
  readonly ok: boolean;
  readonly findings: readonly Pick<Finding, 'checkId' | 'severity' | 'code' | 'message'>[];
}

/** Server diagnostics. Keep this out of player and phone views. */
export interface InvestigationReport extends GenerationReport {
  /** One entry per attempt that reached the gate, in attempt order. */
  readonly validations: readonly AttemptValidation[];
  /** The incident of the accepted attempt. */
  readonly chosen?: {
    readonly victimArchetype: string;
    readonly culpritArchetype: string;
    readonly template: string;
    readonly motiveType: string;
  };
  readonly feasibleCulpritCount?: number;
}

export type GenerationResult =
  | {
      readonly ok: true;
      readonly investigation: Investigation;
      readonly investigationHash: string;
      readonly report: InvestigationReport;
    }
  | {
      readonly ok: false;
      readonly error: 'GENERATION_UNSOLVABLE';
      readonly report: InvestigationReport;
    };

interface Carried<T> {
  readonly world: GeneratedWorld;
  readonly value: T;
}

/** Runs `stage` on the carried value and keeps the generated world next to the result. */
function carry<I, O>(stage: Stage<I, O>): Stage<Carried<I>, Carried<O>> {
  return {
    name: stage.name,
    generate: ({ world, value }, context) => ({ world, value: stage.generate(value, context) }),
  };
}

const cast: Stage<GeneratedWorld, Carried<Character[]>> = {
  name: castGen.name,
  generate: (world, context) => ({ world, value: castGen.generate(undefined, context) }),
};

const selection: Stage<Carried<ConflictWorld>, ReturnType<typeof incidentSelection.generate>> = {
  name: incidentSelection.name,
  generate: ({ world, value }, context) => incidentSelection.generate({ ...value, world }, context),
};

const STAGES = [
  worldGen,
  cast,
  carry<readonly Character[], SocialWorld>(socialGen),
  carry(conflictGen),
  selection,
  plotPlanning,
  historySimulation,
  evidenceGen,
  testimonyGen,
  redHerrings,
] as const;

function questionsFor(investigation: Investigation): Question[] {
  return [
    { type: 'whereWereYou', interval: investigation.truth.incident.window },
    { type: 'aboutYourself' },
    ...investigation.characters.map(({ id }) => ({
      type: 'whatDoYouKnowAbout' as const,
      characterId: id,
    })),
  ];
}

/** Packaging: the authoritative investigation (secrets keep `{ id, fact, knownBy }`). */
export function packageInvestigation(
  output: RedHerringWorld,
  req: GenerationRequest,
): Investigation {
  return new InvestigationBuilder({
    scenarioId: req.scenarioId,
    seed: req.seed,
    generatorVersion: GENERATOR_VERSION,
  })
    .withWorld(output.worldState)
    .withCharacters(output.characters)
    .withTruth(output.truth)
    .withRelationships(output.relationshipsAtStart)
    .withSecrets(output.secrets.map(({ id, fact, knownBy }) => ({ id, fact, knownBy })))
    .build();
}

function validationContext(
  output: RedHerringWorld,
  investigation: Investigation,
  content: ScenarioContent,
): ValidationContext {
  const witnesses = output.characters.map((character) => ({
    character,
    knowledge: output.knowledge.get(character.id)!,
    policy: output.liePolicies.get(character.id)!,
  }));
  const testimony = collectTestimony(witnesses, questionsFor(investigation), 0);
  const statements: HeardStatement[] = testimony.map(
    ({ id, speakerId, topic, at, proposition, templateKey }) => ({
      id,
      speakerId,
      topic,
      at,
      proposition,
      templateKey,
    }),
  );
  return {
    // The backstory of SocialGen and ConflictGen precedes the simulated history by years.
    historyStartMinutes: Math.min(
      content.preset.time.historyStartMinutes,
      ...output.truth.events().map(({ t }) => t),
    ),
    clues: output.clues,
    requiredClueIds: output.requiredClueIds,
    minQrShare: content.preset.phone.minQrShare,
    deductionRules: compileDeductionRules(content.deductionRules),
    statements,
    testimony,
    startLocationId: output.world.startLocationId,
  };
}

const brief = ({ checkId, severity, code, message }: Finding) => ({
  checkId,
  severity,
  code,
  message,
});

/**
 * Generates an investigation and hands it over only when the validator passes it (ADR 0006).
 * Attempt `n` uses the subseed `<seed>#n`; a failed attempt is repaired by generating again from
 * the first stage with the next subseed (the strategies that keep the cast are not implemented
 * yet, see generation-pipeline.md). After `maxAttempts` (8) the result is `GENERATION_UNSOLVABLE`
 * with the findings of every attempt.
 */
export function generateInvestigation(
  req: GenerationRequest,
  content: ScenarioContent,
  options: GenerateOptions = {},
): GenerationResult {
  if (req.scenarioId !== content.preset.id) {
    throw new RangeError(`Content is of scenario ${content.preset.id}, not ${req.scenarioId}`);
  }
  const { maxAttempts = 8, now = () => 0, checks = GENERATION_CHECKS } = options;
  const run = (
    firstAttempt: number,
    attempts: number,
    accepts?: (output: RedHerringWorld, attempt: number) => boolean,
  ) =>
    runPipeline(STAGES, undefined as never, {
      seed: req.seed,
      content,
      now,
      firstAttempt,
      maxAttempts: attempts,
      ...(accepts && { accepts }),
    });

  const validations: AttemptValidation[] = [];
  const result = run(1, maxAttempts, (output, attempt) => {
    const investigation = packageInvestigation(output, req);
    const context = validationContext(output, investigation, content);
    const report = validateInvestigation(investigation, { checks, context });
    let { ok, findings } = report;
    if (ok) {
      // Replaying the attempt costs a whole generation, so only a case that passed the rest pays.
      const again = validateInvestigation(investigation, {
        checks: [determinismCheck],
        context: {
          regenerate: () => {
            const replay = run(attempt, 1);
            if (!replay.ok) throw new Error('The replayed attempt was rejected');
            return packageInvestigation(replay.output, req);
          },
        },
      });
      ok = again.ok;
      findings = [...findings, ...again.findings];
    }
    validations.push({ attempt, ok, findings: findings.map(brief) });
    return ok;
  });

  if (!result.ok) {
    return { ok: false, error: result.error, report: { ...result.report, validations } };
  }
  const { output } = result;
  const investigation = packageInvestigation(output, req);
  const { chosen, feasibleCulpritCount } = output.incidentReport;
  return {
    ok: true,
    investigation,
    investigationHash: investigationHash(investigation),
    report: {
      ...result.report,
      validations,
      chosen: {
        victimArchetype: chosen.victimArchetype,
        culpritArchetype: chosen.culpritArchetype,
        template: chosen.template,
        motiveType: chosen.motiveType,
      },
      feasibleCulpritCount,
    },
  };
}
