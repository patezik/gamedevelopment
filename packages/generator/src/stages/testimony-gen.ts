import type { Character } from '@hs/core/characters';
import {
  buildLiePolicy,
  KnowledgeStore,
  type Fabrication,
  type LieMotive,
  type LiePolicy,
} from '@hs/core/knowledge';
import type { Rng } from '@hs/core/rng';
import { factId } from '@hs/core/truth';
import type { Fact, PropositionPattern } from '@hs/core/truth/facts';
import type { Stage } from '../pipeline/index.ts';
import type { EvidenceWorld } from './evidence-gen.ts';
import type { SocialSecret } from './social-gen.ts';

type CharacterId = Character['id'];

/** The verb of a cover story: "I just stayed there". */
export const IDLE_VERB = 'stay';

export interface TestimonyReport {
  /** Characters with a motive to hide something they know (non-empty `conceal`). */
  readonly concealing: number;
  /** Characters whose policy lets them lie (non-empty `fabricate`). */
  readonly lying: number;
  /** Characters whose policy is empty: they have nothing to hide or know nothing of it. */
  readonly honest: number;
  /** Secret beliefs written into the stores. */
  readonly secretBeliefs: number;
}

export interface TestimonyWorld extends EvidenceWorld {
  /** Stores of `EvidenceWorld` plus the beliefs of each secret in its `knownBy`. */
  readonly knowledge: ReadonlyMap<CharacterId, KnowledgeStore>;
  /** Why each character may hide something: their secrets and, for a culprit, their guilt. */
  readonly lieMotives: ReadonlyMap<CharacterId, readonly LieMotive[]>;
  /** The lie policy of every character of the cast. */
  readonly liePolicies: ReadonlyMap<CharacterId, LiePolicy>;
  readonly testimonyReport: TestimonyReport;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * The pattern of one fact: every field of the fact is fixed. A memory of a deed keeps no target
 * (the runner records who did what, when and where), so the target of a `did` is left open.
 */
export function exactPattern(fact: Fact): PropositionPattern {
  const copy = structuredClone(fact);
  if (copy.kind === 'did') delete copy.target;
  return copy as PropositionPattern;
}

/** A secret is denied: the same state with the value negated. */
function secretMotive(secret: SocialSecret): LieMotive {
  const fact = secret.fact;
  if (fact.kind !== 'state') return { protect: [exactPattern(fact)] };
  const denial: Fact = { ...fact, value: false };
  const pattern = exactPattern(fact);
  return { protect: [pattern], alternatives: [{ replaces: pattern, proposition: denial }] };
}

/** The cover story for a deed: the character only stayed where they were, over the same minute. */
export function idleAlternative(fact: Fact): Fabrication | undefined {
  if (fact.kind !== 'did') return undefined;
  return {
    replaces: exactPattern(fact),
    proposition: { kind: 'did', who: fact.who, verb: IDLE_VERB, at: fact.at, where: fact.where },
  };
}

/** What the culprit did during the key events, why, and with what: all hidden, the deeds covered. */
function guiltMotive(world: EvidenceWorld, culprit: CharacterId): LieMotive {
  const { truth } = world;
  const protect: PropositionPattern[] = [
    { kind: 'motive', who: culprit },
    { kind: 'possessed', who: culprit, item: truth.incident.means },
  ];
  const alternatives: Fabrication[] = [];
  const keys = new Set(truth.incident.keyEventIds);
  for (const event of truth.events()) {
    if (!keys.has(event.id)) continue;
    for (const fact of event.facts) {
      if (fact.kind !== 'did' || fact.who !== culprit) continue;
      protect.push(exactPattern(fact));
      const cover = idleAlternative(fact);
      if (cover) alternatives.push(cover);
    }
  }
  return { protect, alternatives };
}

/**
 * A lie of the culprit is handed out only when a clue of the case can refute it (V-LIES-BREAKABLE):
 * a `did` cover story is refuted by a clue whose source event puts the actor elsewhere at that
 * minute. Anything else (a denied state, "I just stayed there" at the very scene of the deed) has
 * no refutation, so the culprit keeps silent about it instead of lying.
 */
function refutable(alternative: Fabrication, world: EvidenceWorld): boolean {
  const p = alternative.proposition;
  if (p.kind !== 'did') return false;
  const events = new Map(world.truth.events().map((event) => [event.id, event]));
  return world.clues.some((clue) => {
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

function withoutUnbreakable(motive: LieMotive, world: EvidenceWorld): LieMotive {
  return {
    ...motive,
    alternatives: (motive.alternatives ?? []).filter((alternative) =>
      refutable(alternative, world),
    ),
  };
}

/**
 * Who heard of the culprit's motive against the victim (OQ-20): a living character who is neither
 * culprit nor victim, drawn from the sorted cast. Their `motive` belief is hearsay from the
 * culprit; asked about the culprit they repeat it, and it becomes `testimony` for the solver.
 */
function motiveWitness(world: EvidenceWorld, rng: Rng): CharacterId | undefined {
  const { culpritIds, victimIds } = world.truth.incident;
  const pool = world.characters
    .map(({ id }) => id)
    .filter((id) => !culpritIds.includes(id) && !victimIds.includes(id))
    .sort(compare);
  return pool.length === 0 ? undefined : pool[rng.int(0, pool.length - 1)];
}

/**
 * TestimonyGen: writes the secrets into the stores of those who know them and builds the
 * `LiePolicy` of every character (KNOW-002). A character hides only what they know and have a
 * motive to hide: their own secrets (denied when the character is not scrupulously honest) and,
 * for the culprit, the deeds, presence, means and motive of the incident. Without a motive a
 * character's policy is empty, so every statement of theirs is the truth or a memory error.
 */
export const testimonyGen: Stage<EvidenceWorld, TestimonyWorld> = {
  name: 'TestimonyGen',
  generate(input, { rng }) {
    const knowledge = new Map<CharacterId, KnowledgeStore>();
    for (const [id, store] of input.knowledge)
      knowledge.set(id, KnowledgeStore.deserialize(store.serialize()));

    let secretBeliefs = 0;
    for (const secret of [...input.secrets].sort((a, b) => compare(a.id, b.id))) {
      const acquiredAt = secret.fact.kind === 'state' ? secret.fact.interval.from : 0;
      for (const who of secret.knownBy) {
        const store = knowledge.get(who);
        if (!store) continue;
        const told = who !== secret.about;
        store.add({
          proposition: structuredClone(secret.fact),
          confidence: 1,
          source: told ? 'told' : 'observed',
          ...(told && { fromCharacter: secret.about }),
          acquiredAt,
          fuzzMinutes: 0,
        });
        secretBeliefs++;
      }
    }

    const culprits = new Set(input.truth.incident.culpritIds);
    const motiveFacts = input.truth
      .facts({ kind: 'motive' })
      .filter((fact) => fact.kind === 'motive' && culprits.has(fact.who));
    const witness = motiveWitness(input, rng.fork('motive-witness'));
    const store = witness === undefined ? undefined : knowledge.get(witness);
    for (const fact of motiveFacts) {
      if (!store || fact.kind !== 'motive') continue;
      store.add({
        proposition: structuredClone(fact),
        confidence: 1,
        source: 'told',
        fromCharacter: fact.who,
        acquiredAt:
          input.truth.events().find((e) => e.facts.some((f) => factId(f) === factId(fact)))?.t ?? 0,
        fuzzMinutes: 0,
      });
      secretBeliefs++;
    }

    const lieMotives = new Map<CharacterId, readonly LieMotive[]>();
    const liePolicies = new Map<CharacterId, LiePolicy>();
    let concealing = 0;
    let lying = 0;
    let honest = 0;
    for (const character of [...input.characters].sort((a, b) => compare(a.id, b.id))) {
      let motives = input.secrets
        .filter(({ about }) => about === character.id)
        .sort((a, b) => compare(a.id, b.id))
        .map(secretMotive);
      if (culprits.has(character.id)) {
        motives.push(guiltMotive(input, character.id));
        motives = motives.map((motive) => withoutUnbreakable(motive, input));
      }
      const policy = buildLiePolicy(
        character,
        knowledge.get(character.id) ?? new KnowledgeStore(),
        motives,
      );
      lieMotives.set(character.id, motives);
      liePolicies.set(character.id, policy);
      if (policy.conceal.length > 0) concealing++;
      if (policy.fabricate.length > 0) lying++;
      if (policy.conceal.length === 0) honest++;
    }
    return {
      ...input,
      knowledge,
      lieMotives,
      liePolicies,
      testimonyReport: { concealing, lying, honest, secretBeliefs },
    };
  },
};
