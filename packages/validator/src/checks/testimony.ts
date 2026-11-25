import type { Character } from '@hs/core/characters';
import type { GameMinutes } from '@hs/core/common';
import {
  DEFAULT_TOLERANCE_MINUTES,
  PlayerKnowledge,
  detectContradictions,
} from '@hs/core/investigation';
import {
  answer,
  type KnowledgeStore,
  type LiePolicy,
  type Question,
  type SpeakerContext,
  type Statement,
} from '@hs/core/knowledge';
import type { Check, FindingInput } from '../check.ts';
import { discover } from '../solver/index.ts';

/** A witness as the generator holds one: memory and lie policy (KNOW-001, KNOW-002). */
export interface TestimonyWitness {
  readonly character: Pick<Character, 'id' | 'personality'>;
  readonly knowledge: Pick<KnowledgeStore, 'query'>;
  readonly policy: LiePolicy;
  readonly isAccurate?: SpeakerContext['isAccurate'];
}

/**
 * Asks every witness every question of the bank at `now` and returns the statements, with their
 * veracity, ordered by speaker and statement id. This is what the testimony checks read from
 * `ValidationContext.testimony`; the validator may see the veracity, a player never does.
 */
export function collectTestimony(
  witnesses: readonly TestimonyWitness[],
  questions: readonly Question[],
  now: GameMinutes,
): Statement[] {
  const statements = new Map<string, Statement>();
  for (const witness of witnesses) {
    for (const question of questions) {
      for (const statement of answer(question, {
        character: witness.character,
        knowledge: witness.knowledge,
        policy: witness.policy,
        now,
        ...(witness.isAccurate && { isAccurate: witness.isAccurate }),
      })) {
        statements.set(statement.id, statement);
      }
    }
  }
  return [...statements.values()].sort(
    (a, b) =>
      (a.speakerId < b.speakerId ? -1 : a.speakerId > b.speakerId ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

const missing = (check: string, what: string): FindingInput[] => [
  {
    severity: 'error',
    code: 'TESTIMONY_INPUT_MISSING',
    message: `${check} needs ${what} in the validation context`,
    eventIds: [],
  },
];

const byStatement = (a: Statement, b: Statement) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * V-TESTIMONY: an honest statement agrees with the truth. A `true` or `mistaken` statement that a
 * character was somewhere (`at`) or did something (`did`) must match a truth fact of the same
 * subject and place, with the time off by at most the memory blur of
 * `DEFAULT_TOLERANCE_MINUTES` (the blur the player forgives, see `detectContradictions`). Lies
 * are not compared: they are meant to differ. Other proposition kinds are not time-testable and
 * are skipped.
 */
export const testimonyCheck: Check = {
  id: 'V-TESTIMONY',
  description: 'Truthful testimony agrees with the truth within the memory blur',
  run(investigation, { testimony }) {
    if (testimony === undefined) return missing('V-TESTIMONY', 'testimony');
    const tolerance = DEFAULT_TOLERANCE_MINUTES;
    const { truth } = investigation;
    const findings: FindingInput[] = [];
    for (const statement of [...testimony].sort(byStatement)) {
      if (statement.veracity === 'lie') continue;
      const p = statement.proposition;
      let agrees = true;
      if (p.kind === 'at') {
        agrees = truth
          .presenceIntervals(p.who)
          .some(
            ({ location, interval }) =>
              location === p.where &&
              interval.from - tolerance <= p.interval.from &&
              p.interval.to <= interval.to + tolerance,
          );
      } else if (p.kind === 'did') {
        // Observers remember an event as `did`, but the log states a plain stay or move only as
        // presence, so an event of the same actor, verb and place counts as the truth too.
        agrees =
          truth
            .facts({ kind: 'did' })
            .some(
              (fact) =>
                fact.kind === 'did' &&
                fact.who === p.who &&
                fact.verb === p.verb &&
                fact.where === p.where &&
                Math.abs(fact.at - p.at) <= tolerance,
            ) ||
          truth
            .events()
            .some(
              (event) =>
                event.actorIds.includes(p.who) &&
                event.verb === p.verb &&
                event.location === p.where &&
                Math.abs(event.t - p.at) <= tolerance,
            );
      }
      if (!agrees) {
        findings.push({
          severity: 'error',
          code: 'TESTIMONY_CONTRADICTS_TRUTH',
          message: `Statement ${statement.id} of ${statement.speakerId} is labelled ${statement.veracity} but no truth fact matches it within ${tolerance} minutes`,
          eventIds: [...truth.incident.keyEventIds.slice(0, 1)],
          subject: { kind: 'character', id: statement.speakerId },
          data: { statementId: statement.id, veracity: statement.veracity },
        });
      }
    }
    return findings;
  },
};

/** Whom a lie is about, besides the liar: the people it points at. */
function accused(statement: Statement): string[] {
  const p = statement.proposition;
  switch (p.kind) {
    case 'at':
    case 'did':
    case 'possessed':
      return [p.who];
    case 'motive':
      return [p.who];
    default:
      return [];
  }
}

/**
 * A lie hampers the solution when the culprit tells it about themselves (a false alibi, a hidden
 * act) or when anyone throws suspicion on somebody else.
 */
function harmful(statement: Statement, culprits: ReadonlySet<string>): boolean {
  const others = accused(statement).some((id) => id !== statement.speakerId);
  return others || culprits.has(statement.speakerId);
}

/**
 * V-LIES-BREAKABLE: every harmful lie can be refuted by a reachable fact. The lie is put to a
 * player who has found every reachable clue: an `at` lie is refuted when `detectContradictions`
 * finds a clue that puts the person elsewhere (forgiving the memory blur); a `did` lie when a
 * reachable clue's source event shows its actor elsewhere at the stated minute. Lies of other
 * kinds cannot be refuted by a clue reference yet and are reported, since nothing proves they
 * can be broken.
 */
export const liesBreakableCheck: Check = {
  id: 'V-LIES-BREAKABLE',
  description: 'Every lie that hampers the solution is refuted by a reachable fact',
  run(investigation, context) {
    const { testimony, clues, startLocationId } = context;
    if (testimony === undefined || clues === undefined) {
      return missing('V-LIES-BREAKABLE', 'testimony and clues');
    }
    const culprits = new Set(investigation.truth.incident.culpritIds);
    const { reachable } = discover({
      investigation,
      clues,
      ...(startLocationId !== undefined && { startLocationId }),
    });
    const reached = new Set(reachable);
    const reachedClues = clues.filter(({ id }) => reached.has(id));
    const events = new Map(investigation.truth.events().map((event) => [event.id, event]));
    const findings: FindingInput[] = [];
    for (const statement of [...testimony].sort(byStatement)) {
      if (statement.veracity !== 'lie' || !harmful(statement, culprits)) continue;
      const p = statement.proposition;
      let broken = false;
      if (p.kind === 'at') {
        const knowledge = new PlayerKnowledge();
        for (const clue of reachedClues) {
          knowledge.addClue({
            clueId: clue.id,
            discoveredAt: 0,
            location: clue.discovery.locationId,
          });
        }
        knowledge.addStatement(statement);
        broken =
          detectContradictions(
            knowledge,
            { clues: new Map(reachedClues.map((clue) => [clue.id, clue])) },
            DEFAULT_TOLERANCE_MINUTES,
          ).length > 0;
      } else if (p.kind === 'did') {
        broken = reachedClues.some((clue) => {
          const event = events.get(clue.sourceEventId);
          return (
            event !== undefined &&
            event.actorIds.includes(p.who) &&
            event.location !== p.where &&
            event.t <= p.at &&
            p.at < event.t + Math.max(1, event.duration)
          );
        });
      }
      if (!broken) {
        findings.push({
          severity: 'error',
          code: 'LIE_UNBREAKABLE',
          message: `The lie ${statement.id} of ${statement.speakerId} is not refuted by any reachable clue`,
          eventIds: [...investigation.truth.incident.keyEventIds.slice(0, 1)],
          subject: { kind: 'character', id: statement.speakerId },
          data: {
            statementId: statement.id,
            culprit: culprits.has(statement.speakerId) ? 1 : 0,
          },
        });
      }
    }
    return findings;
  },
};

export const TESTIMONY_CHECKS: readonly Check[] = [liesBreakableCheck, testimonyCheck];
