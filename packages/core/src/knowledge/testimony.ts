import type { Character } from '../characters/index.ts';
import { hashId, overlaps, type GameMinutes, type Interval } from '../common/index.ts';
import {
  factId,
  matchProposition,
  type Proposition,
  type PropositionPattern,
} from '@hs/core/truth/facts';
import { recallBelief, type KnowledgeStore } from './store.ts';

export type Question =
  | { type: 'whereWereYou'; interval: Interval }
  | { type: 'whatDoYouKnowAbout'; characterId: string }
  | { type: 'whatIsThis'; clue: { id: string; subjects: readonly PropositionPattern[] } }
  | { type: 'aboutYourself' }
  | { type: 'sawAnything'; interval: Interval; location: string };

export interface Fabrication {
  readonly replaces: PropositionPattern;
  readonly proposition: Proposition;
}

export interface LieMotive {
  readonly protect: readonly PropositionPattern[];
  readonly alternatives?: readonly Fabrication[];
}

export interface LiePolicy {
  readonly conceal: readonly PropositionPattern[];
  readonly fabricate: readonly Fabrication[];
}

type Speaker = Pick<Character, 'id' | 'personality'>;
type Knowledge = Pick<KnowledgeStore, 'query'>;

const matches = (proposition: Proposition, pattern: PropositionPattern): boolean =>
  matchProposition(proposition, pattern) !== null;

export function buildLiePolicy(
  character: Speaker,
  knowledge: Knowledge,
  secrets: readonly LieMotive[],
  guilt?: LieMotive,
): LiePolicy {
  const motives = guilt ? [...secrets, guilt] : secrets;
  const conceal = motives.flatMap(({ protect }) =>
    protect.filter((pattern) => knowledge.query(pattern).length > 0),
  );
  const fabricate =
    character.personality.honesty < 0.75
      ? motives.flatMap(({ alternatives = [], protect }) =>
          alternatives.filter((alternative) =>
            knowledge
              .query(alternative.replaces)
              .some(
                ({ proposition }) =>
                  factId(proposition) !== factId(alternative.proposition) &&
                  protect.some((pattern) => matches(proposition, pattern)),
              ),
          ),
        )
      : [];
  return structuredClone({ conceal, fabricate });
}

export interface SpeakerContext {
  readonly character: Speaker;
  readonly knowledge: Knowledge;
  readonly policy: LiePolicy;
  readonly now: GameMinutes;
  /** Optional server-side annotation. It does not influence what the witness says. */
  readonly isAccurate?: (proposition: Proposition) => boolean;
}

export interface Statement {
  readonly id: string;
  readonly speakerId: string;
  readonly proposition: Proposition;
  readonly veracity: 'true' | 'mistaken' | 'lie';
  readonly topic: Question['type'];
  readonly at: GameMinutes;
  readonly templateKey: string;
}

const allPropositions: readonly PropositionPattern[] = [
  { kind: 'at' },
  { kind: 'did' },
  { kind: 'possessed' },
  { kind: 'relation' },
  { kind: 'motive' },
  { kind: 'state' },
];

function concerns(proposition: Proposition, id: string): boolean {
  switch (proposition.kind) {
    case 'at':
    case 'possessed':
      return proposition.who === id;
    case 'did':
      return (
        proposition.who === id ||
        (proposition.target?.kind === 'character' && proposition.target.id === id)
      );
    case 'motive':
      return proposition.who === id || proposition.against === id;
    case 'relation':
      return proposition.a === id || proposition.b === id;
    case 'state':
      return proposition.entity.kind === 'character' && proposition.entity.id === id;
  }
}

function relevant(question: Question, speakerId: string, proposition: Proposition): boolean {
  switch (question.type) {
    case 'whereWereYou':
      return (
        proposition.kind === 'at' &&
        proposition.who === speakerId &&
        overlaps(question.interval, proposition.interval)
      );
    case 'whatDoYouKnowAbout':
      return concerns(proposition, question.characterId);
    case 'aboutYourself':
      return concerns(proposition, speakerId);
    case 'whatIsThis':
      return question.clue.subjects.some((pattern) => matches(proposition, pattern));
    case 'sawAnything':
      if (proposition.kind === 'at') {
        return (
          proposition.where === question.location &&
          proposition.who !== speakerId &&
          overlaps(proposition.interval, question.interval)
        );
      }
      return (
        proposition.kind === 'did' &&
        proposition.where === question.location &&
        proposition.who !== speakerId &&
        question.interval.from <= proposition.at &&
        proposition.at < question.interval.to
      );
  }
}

function statement(
  ctx: SpeakerContext,
  topic: Question['type'],
  proposition: Proposition,
  veracity: Statement['veracity'],
): Statement {
  const speakerId = ctx.character.id;
  const at = ctx.now;
  return {
    id: hashId('st', [speakerId, topic, at, factId(proposition), veracity], 16),
    speakerId,
    topic,
    at,
    proposition: structuredClone(proposition),
    veracity,
    templateKey: `testimony_${topic}_${proposition.kind}`,
  };
}

/** Each statement is selected from the witness's memories or an authorized alternative. */
export function answer(question: Question, ctx: SpeakerContext): Statement[] {
  const statements = new Map<string, Statement>();
  for (const pattern of allPropositions) {
    for (const belief of ctx.knowledge.query(pattern)) {
      const original = belief.proposition;
      if (
        belief.acquiredAt > ctx.now ||
        !relevant(question, ctx.character.id, original) ||
        (question.type === 'sawAnything' && belief.source !== 'observed')
      )
        continue;
      const concealed = ctx.policy.conceal.some((pattern) => matches(original, pattern));
      let reply: Statement;
      if (concealed) {
        const alternate = ctx.policy.fabricate.find(
          ({ replaces, proposition }) =>
            matches(original, replaces) && factId(proposition) !== factId(original),
        );
        if (!alternate) continue;
        reply = statement(ctx, question.type, alternate.proposition, 'lie');
      } else {
        const { proposition } = recallBelief(belief, ctx.now);
        const accurate = ctx.isAccurate?.(proposition) ?? factId(proposition) === factId(original);
        reply = statement(ctx, question.type, proposition, accurate ? 'true' : 'mistaken');
      }
      statements.set(reply.id, reply);
    }
  }
  return [...statements.values()];
}

export type Rebuttal =
  | { readonly kind: 'admit'; readonly statement: Statement }
  | { readonly kind: 'change'; readonly statement: Statement }
  | { readonly kind: 'refuse' };

/** The caller has established the contradiction and supplies the underlying belief's pattern. */
export function reactToRebuttal(
  challenged: Statement,
  original: PropositionPattern,
  ctx: SpeakerContext,
): Rebuttal {
  if (challenged.speakerId !== ctx.character.id || challenged.at > ctx.now)
    return { kind: 'refuse' };
  const belief = ctx.knowledge.query(original).find(({ acquiredAt }) => acquiredAt <= ctx.now);
  if (!belief) return { kind: 'refuse' };
  const { honesty, courage } = ctx.character.personality;
  if (challenged.veracity !== 'lie' || honesty >= 0.5 || courage < 0.25) {
    const { proposition } = belief;
    const accurate = ctx.isAccurate?.(proposition) ?? true;
    return {
      kind: 'admit',
      statement: statement(ctx, challenged.topic, proposition, accurate ? 'true' : 'mistaken'),
    };
  }
  const alternative = ctx.policy.fabricate.find(
    ({ replaces, proposition }) =>
      matches(belief.proposition, replaces) &&
      factId(proposition) !== factId(challenged.proposition) &&
      factId(proposition) !== factId(belief.proposition),
  );
  if (alternative && ctx.policy.conceal.some((pattern) => matches(belief.proposition, pattern))) {
    return {
      kind: 'change',
      statement: statement(ctx, challenged.topic, alternative.proposition, 'lie'),
    };
  }
  return { kind: 'refuse' };
}
