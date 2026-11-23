import type { Interval } from '../common/index.ts';
import type { RelationshipGraph, RelationType } from '../characters/index.ts';
import type { KnowledgeStore } from '../knowledge/index.ts';
import {
  factId,
  matchProposition,
  type Proposition,
  type PropositionPattern,
  type TruthModel,
} from '../truth/index.ts';

/** Two characters must share a location for this many minutes to talk. */
export const MIN_ENCOUNTER_MINUTES = 10;
/** A retold belief is trusted less than the teller's own. */
export const TOLD_CONFIDENCE_FACTOR = 0.8;
/** The most beliefs one character tells another in a single encounter. */
export const MAX_SHARES_PER_SPEAKER = 5;

export interface Stay {
  readonly characterId: string;
  readonly location: string;
  /** Half-open `[from, to)`. */
  readonly interval: Interval;
}

export interface Encounter {
  /** `a` sorts before `b`. */
  readonly a: string;
  readonly b: string;
  readonly location: string;
  readonly from: number;
  readonly to: number;
}

export interface Talker {
  readonly id: string;
  readonly knowledge: Pick<KnowledgeStore, 'query' | 'add' | 'recall'>;
  /** Patterns from the speaker's `LiePolicy`. Matching beliefs are never told. */
  readonly conceal: readonly PropositionPattern[];
}

export interface Transfer {
  readonly from: string;
  readonly to: string;
  readonly proposition: Proposition;
  readonly confidence: number;
  readonly fuzzMinutes: number;
}

export interface EncounterResult {
  readonly encounter: Encounter;
  readonly eventId: string;
  readonly transfers: readonly Transfer[];
}

export interface EncounterOptions {
  /** Trust the listener must exceed, 0–1. Higher for more delicate propositions. */
  readonly sensitivity?: (proposition: Proposition) => number;
  readonly maxShares?: number;
}

const KINDS = ['did', 'possessed', 'relation', 'at', 'state', 'motive'] as const;
const defaultSensitivityByKind = {
  at: 0.1,
  did: 0.2,
  state: 0.3,
  possessed: 0.3,
  relation: 0.4,
  motive: 0.6,
} satisfies Record<Proposition['kind'], number>;

export const defaultSensitivity = (proposition: Proposition): number =>
  defaultSensitivityByKind[proposition.kind];

/** Per-encounter drift of an edge by type. Hostile ties cool, close ties warm. */
const DRIFT = {
  parent: { trust: 0.01, valence: 0.01 },
  child: { trust: 0.01, valence: 0.01 },
  sibling: { trust: 0.01, valence: 0.01 },
  spouse: { trust: 0.01, valence: 0.01 },
  romance: { trust: 0.01, valence: 0.01 },
  friendship: { trust: 0.01, valence: 0.01 },
  employment: { trust: 0, valence: 0 },
  debt: { trust: 0, valence: 0 },
  rivalry: { trust: -0.01, valence: -0.01 },
  past_conflict: { trust: -0.01, valence: -0.01 },
  blackmail: { trust: -0.01, valence: -0.01 },
} satisfies Record<RelationType, { trust: number; valence: number }>;
const INTENSITY_DRIFT = 0.01;
const TRANSFER_TRUST_BONUS = 0.01;

/** A full proposition is a valid pattern; only `exactOptionalPropertyTypes` objects to the cast. */
const asPattern = (proposition: Proposition): PropositionPattern =>
  proposition as PropositionPattern;

function compareText(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function mergeStays(stays: readonly Stay[]): Stay[] {
  const sorted = stays
    .filter(({ interval }) => interval.from < interval.to)
    .sort(
      (x, y) =>
        compareText(x.characterId, y.characterId) ||
        compareText(x.location, y.location) ||
        x.interval.from - y.interval.from,
    );
  const merged: { characterId: string; location: string; from: number; to: number }[] = [];
  for (const { characterId, location, interval } of sorted) {
    const last = merged.at(-1);
    if (
      last?.characterId === characterId &&
      last.location === location &&
      interval.from <= last.to
    ) {
      last.to = Math.max(last.to, interval.to);
    } else {
      merged.push({ characterId, location, from: interval.from, to: interval.to });
    }
  }
  return merged.map(({ characterId, location, from, to }) => ({
    characterId,
    location,
    interval: { from, to },
  }));
}

/**
 * Finds pairs sharing a location for at least `minMinutes`. Touching or overlapping stays of one
 * character in one location count as one stay. Result order: start, location, pair.
 */
export function detectEncounters(
  stays: readonly Stay[],
  minMinutes: number = MIN_ENCOUNTER_MINUTES,
): Encounter[] {
  if (!Number.isFinite(minMinutes) || minMinutes <= 0) {
    throw new RangeError('minMinutes must be positive');
  }
  const merged = mergeStays(stays);
  const found: Encounter[] = [];
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length; j++) {
      const x = merged[i]!;
      const y = merged[j]!;
      if (x.location !== y.location || x.characterId === y.characterId) continue;
      const from = Math.max(x.interval.from, y.interval.from);
      const to = Math.min(x.interval.to, y.interval.to);
      if (to - from < minMinutes) continue;
      const [a, b] =
        x.characterId < y.characterId
          ? [x.characterId, y.characterId]
          : [y.characterId, x.characterId];
      found.push({ a, b, location: x.location, from, to });
    }
  }
  return found.sort(
    (x, y) =>
      x.from - y.from ||
      compareText(x.location, y.location) ||
      compareText(x.a, y.a) ||
      compareText(x.b, y.b),
  );
}

function trustOf(graph: RelationshipGraph, from: string, to: string): number | undefined {
  const trusts = graph
    .neighbors(from)
    .filter((edge) => edge.b === to)
    .map((edge) => edge.trust);
  return trusts.length > 0 ? Math.max(...trusts) : undefined;
}

function candidates(
  speaker: Talker,
  listener: Talker,
  trust: number | undefined,
  t: number,
  sensitivity: (proposition: Proposition) => number,
  maxShares: number,
): Transfer[] {
  if (trust === undefined) return [];
  const shareable: Transfer[] = [];
  for (const kind of KINDS) {
    for (const { proposition, fromCharacter } of speaker.knowledge.query({
      kind,
    } as PropositionPattern)) {
      if (fromCharacter === listener.id) continue;
      if (speaker.conceal.some((pattern) => matchProposition(proposition, pattern) !== null)) {
        continue;
      }
      const threshold = sensitivity(proposition);
      if (!(threshold >= 0 && threshold <= 1)) {
        throw new RangeError('Sensitivity must be between 0 and 1');
      }
      if (!(trust > threshold)) continue;
      // Recall applies the speaker's memory decay and hides beliefs acquired after `t`.
      const recalled = speaker.knowledge.recall(asPattern(proposition), t);
      if (!recalled) continue;
      shareable.push({
        from: speaker.id,
        to: listener.id,
        proposition: recalled.proposition,
        confidence: recalled.confidence * TOLD_CONFIDENCE_FACTOR,
        fuzzMinutes: recalled.fuzzMinutes,
      });
    }
  }
  return shareable
    .sort(
      (x, y) =>
        y.confidence - x.confidence || compareText(factId(x.proposition), factId(y.proposition)),
    )
    .slice(0, maxShares);
}

function receive(listener: Talker, transfer: Transfer, t: number): boolean {
  const known = listener.knowledge.query(asPattern(transfer.proposition));
  if (known.some(({ confidence }) => confidence >= transfer.confidence)) return false;
  listener.knowledge.add({
    proposition: transfer.proposition,
    confidence: transfer.confidence,
    source: 'told',
    fromCharacter: transfer.from,
    acquiredAt: t,
    fuzzMinutes: transfer.fuzzMinutes,
  });
  return true;
}

function driftRelationships(
  graph: RelationshipGraph,
  a: string,
  b: string,
  exchanged: boolean,
  cause: string,
): void {
  // Original edges only: a symmetric type shares one state with its reverse edge.
  for (const edge of graph.snapshot()) {
    if (!((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a))) continue;
    const drift = DRIFT[edge.type];
    const bonus = exchanged && drift.trust >= 0 ? TRANSFER_TRUST_BONUS : 0;
    graph.adjust(
      edge.a,
      edge.b,
      { trust: drift.trust + bonus, valence: drift.valence, intensity: INTENSITY_DRIFT },
      cause,
      edge.type,
    );
  }
}

/**
 * One conversation. Both sides choose what to tell from their knowledge before the talk, so the
 * outcome does not depend on who speaks first. Trust is read before drift is applied. Characters
 * without a relationship edge to the listener tell nothing.
 */
export function converse(
  encounter: Encounter,
  talkers: readonly [Talker, Talker],
  graph: RelationshipGraph,
  truth: Pick<TruthModel, 'append'>,
  options: EncounterOptions = {},
): EncounterResult {
  const [first, second] = talkers;
  const { sensitivity = defaultSensitivity, maxShares = MAX_SHARES_PER_SPEAKER } = options;
  const t = encounter.from;
  const planned = [
    ...candidates(first, second, trustOf(graph, first.id, second.id), t, sensitivity, maxShares),
    ...candidates(second, first, trustOf(graph, second.id, first.id), t, sensitivity, maxShares),
  ];
  const transfers = planned.filter((transfer) =>
    receive(transfer.to === first.id ? first : second, transfer, t),
  );

  const { location } = encounter;
  const eventId = truth.append({
    t,
    duration: encounter.to - encounter.from,
    verb: 'talk',
    actorIds: [first.id, second.id],
    location,
    targets: [
      { kind: 'character', id: first.id },
      { kind: 'character', id: second.id },
    ],
    causes: [],
    facts: [
      {
        kind: 'did',
        who: first.id,
        verb: 'talk',
        target: { kind: 'character', id: second.id },
        at: t,
        where: location,
      },
      {
        kind: 'did',
        who: second.id,
        verb: 'talk',
        target: { kind: 'character', id: first.id },
        at: t,
        where: location,
      },
    ],
    traceIds: [],
    visibility: 'covert',
  });
  driftRelationships(graph, first.id, second.id, transfers.length > 0, eventId);
  return { encounter, eventId, transfers };
}

/**
 * Runs every encounter in order, so later talks see what earlier ones taught. Encounters with
 * someone who has no `Talker` (for example the player) are skipped.
 */
export function runEncounters(
  encounters: readonly Encounter[],
  talkerFor: (characterId: string) => Talker | undefined,
  graph: RelationshipGraph,
  truth: Pick<TruthModel, 'append'>,
  options: EncounterOptions = {},
): EncounterResult[] {
  const results: EncounterResult[] = [];
  for (const encounter of encounters) {
    const a = talkerFor(encounter.a);
    const b = talkerFor(encounter.b);
    if (a && b) results.push(converse(encounter, [a, b], graph, truth, options));
  }
  return results;
}
