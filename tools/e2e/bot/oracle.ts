import type { PlayerAction } from '@hs/protocol';
import { evaluateClaims, PlayerKnowledge } from '@hs/core/investigation';
import { solutionSource, solve } from '@hs/validator';
import { generatedPlannerCase } from '../../bench-planner-generated.ts';

/**
 * What only a test may know: the plan of the investigation and the case file that proves it.
 * The bot gets it by generating the same case as the server (generation is deterministic,
 * ADR 0004) and running the VAL-003 planner on it. The truth stays here and never reaches a
 * client: the bot sends the server nothing but ordinary player actions.
 */
export interface Oracle {
  readonly seed: string;
  /** The `SolutionPath` of the planner: desktop actions and `captureEvidence` steps. */
  readonly path: readonly PlayerAction[];
  /** The game minute the planner ends at, and the time budget it searched under. */
  readonly minutes: number;
  readonly budget: number;
  /** Case file claims for the accusation, as the planner's knowledge proves them. */
  readonly accusedIds: readonly string[];
  readonly claims: {
    readonly motive: string;
    readonly means: string;
    readonly opportunity: string;
  };
  /** Clue ids the twin engine holds at the end: the bot checks the server shows the same. */
  readonly clueIds: readonly string[];
}

/** A seed with no game to play: the generator's gate refuses it (the server answers 422) or the bounded planner finds no path. */
export class SeedUnavailableError extends Error {}

export function buildOracle(seed: string): Oracle {
  let generated: ReturnType<typeof generatedPlannerCase>;
  try {
    generated = generatedPlannerCase(seed);
  } catch (error) {
    throw new SeedUnavailableError(`Seed ${seed}: the generator gate refused it`, { cause: error });
  }
  const { investigation, options, createEngine } = generated;
  const path = solve(investigation, options);
  if (!path) throw new SeedUnavailableError(`Seed ${seed}: the planner found no solution path`);

  // The twin: replay the path on a local engine to read what the player knows at the end.
  const engine = createEngine();
  for (const action of path) {
    const result = engine.dispatch(solutionSource(action), action);
    if (!result.ok || result.outcome)
      throw new Error(`Seed ${seed}: the twin rejected ${action.type}`);
  }
  const snapshot = engine.snapshot();
  const knowledge = PlayerKnowledge.restore(snapshot.desktop?.knowledge);
  const claims = evaluateClaims(knowledge, options.deductionRules, {
    clues: new Map(options.clues.map((clue) => [clue.id, clue])),
    ...(options.knownIncident && { incident: options.knownIncident }),
  });
  const accusedIds = [...investigation.truth.incident.culpritIds];
  const pick = (kind: 'motive' | 'means' | 'opportunity') => {
    const claim = claims.find((c) => c.kind === kind && accusedIds.includes(c.subject));
    if (!claim) throw new Error(`Seed ${seed}: no proven ${kind} claim`);
    return claim.claim;
  };
  return {
    seed,
    path,
    minutes: snapshot.minute,
    budget: options.timeBudget,
    accusedIds,
    claims: { motive: pick('motive'), means: pick('means'), opportunity: pick('opportunity') },
    clueIds: engine.playerView().caseBoard.clues.map(({ id }) => id),
  };
}

const cache = new Map<string, Oracle>();
/** Plans are deterministic and cost seconds: build each seed once per process. */
export function oracleFor(seed: string): Oracle {
  let oracle = cache.get(seed);
  if (!oracle) {
    oracle = buildOracle(seed);
    cache.set(seed, oracle);
  }
  return oracle;
}
