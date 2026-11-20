import { z } from 'zod';
import type { GameMinutes, Interval } from '../common/index.ts';
import {
  factId,
  factSchema,
  matchProposition,
  type FactId,
  type Proposition,
  type PropositionPattern,
} from '@hs/core/truth/facts';

const gameMinuteSchema = z.int();
const beliefSchema = z.strictObject({
  proposition: factSchema,
  confidence: z.number().min(0).max(1),
  source: z.enum(['observed', 'told', 'read', 'inferred']),
  fromCharacter: z.string().min(1).optional(),
  acquiredAt: gameMinuteSchema,
  fuzzMinutes: z.int().nonnegative(),
});
const snapshotSchema = z.array(beliefSchema);
const MINUTES_PER_FUZZ_MINUTE = 60n;

export type Belief = z.infer<typeof beliefSchema>;

function compareText(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function compareRank(a: Belief, b: Belief): number {
  return b.confidence - a.confidence || b.acquiredAt - a.acquiredAt;
}

function compareDuplicates(a: Belief, b: Belief): number {
  return (
    compareRank(a, b) ||
    a.fuzzMinutes - b.fuzzMinutes ||
    compareText(a.source, b.source) ||
    compareText(a.fromCharacter ?? '', b.fromCharacter ?? '')
  );
}

function roundingStep(fuzzMinutes: number): number {
  // A grid can move an integer minute by at most half its step, rounded down.
  if (fuzzMinutes >= 30) return 60;
  if (fuzzMinutes >= 15) return 30;
  if (fuzzMinutes >= 7) return 15;
  return 1;
}

function roundMinute(minute: GameMinutes, step: number): GameMinutes {
  const offset = ((minute % step) + step) % step;
  const rounded = minute + (offset * 2 < step ? -offset : step - offset);
  return Number.isSafeInteger(rounded) ? rounded : minute;
}

function roundInterval(interval: Interval, step: number): Interval {
  const from = roundMinute(interval.from, step);
  const to = roundMinute(interval.to, step);
  if (from < to) return { from, to };

  // Moving both ends together preserves a short interval that collapsed on the grid.
  const shiftedTo = interval.to + (from - interval.from);
  return Number.isSafeInteger(shiftedTo) ? { from, to: shiftedTo } : interval;
}

function roundProposition(proposition: Proposition, step: number): Proposition {
  switch (proposition.kind) {
    case 'did':
      return { ...proposition, at: roundMinute(proposition.at, step) };
    case 'relation':
      return proposition.since === undefined
        ? proposition
        : { ...proposition, since: roundMinute(proposition.since, step) };
    case 'at':
    case 'possessed':
    case 'state':
      return { ...proposition, interval: roundInterval(proposition.interval, step) };
    case 'motive':
      return proposition;
  }
}

/** A character's subjective knowledge, keyed by the original proposition. */
export class KnowledgeStore {
  readonly #beliefs = new Map<FactId, Belief>();

  add(belief: Belief): void {
    this.#insert(beliefSchema.parse(belief));
  }

  query(pattern: PropositionPattern): Belief[] {
    return this.#matches(pattern).map((belief) => structuredClone(belief));
  }

  /**
   * Matches the original proposition and recalls the best belief acquired by now.
   * Fuzz grows by one minute per completed game hour since acquisition:
   * min(MAX_SAFE_INTEGER, baseFuzz + floor((now - acquiredAt) / 60)).
   * Only the returned proposition's times and its fuzz are changed.
   */
  recall(pattern: PropositionPattern, now: GameMinutes): Belief | undefined {
    const minute = gameMinuteSchema.parse(now);
    const match = this.#matches(pattern).find(({ acquiredAt }) => acquiredAt <= minute);
    if (!match) return undefined;

    const memory = structuredClone(match);
    // Subtract in integers even when prehistory and now span more than MAX_SAFE_INTEGER.
    const elapsed = BigInt(minute) - BigInt(memory.acquiredAt);
    memory.fuzzMinutes = Math.min(
      Number.MAX_SAFE_INTEGER,
      memory.fuzzMinutes + Number(elapsed / MINUTES_PER_FUZZ_MINUTE),
    );
    const step = roundingStep(memory.fuzzMinutes);
    if (step > 1) memory.proposition = roundProposition(memory.proposition, step);
    return memory;
  }

  serialize(): string {
    const entries = [...this.#beliefs.entries()].sort(([a], [b]) => compareText(a, b));
    return JSON.stringify(entries.map(([, belief]) => belief));
  }

  static deserialize(json: string): KnowledgeStore {
    const beliefs = snapshotSchema.parse(JSON.parse(json));
    const store = new KnowledgeStore();
    for (const belief of beliefs) store.#insert(belief);
    return store;
  }

  #insert(belief: Belief): void {
    // Normalize explicit undefined values to the same shape a JSON round trip produces.
    if (belief.fromCharacter === undefined) delete belief.fromCharacter;
    const { proposition } = belief;
    if (proposition.kind === 'did' && proposition.target === undefined) delete proposition.target;
    if (proposition.kind === 'relation' && proposition.since === undefined)
      delete proposition.since;

    const id = factId(proposition);
    const existing = this.#beliefs.get(id);
    if (!existing || compareDuplicates(belief, existing) < 0) this.#beliefs.set(id, belief);
  }

  #matches(pattern: PropositionPattern): Belief[] {
    return [...this.#beliefs.entries()]
      .filter(([, { proposition }]) => matchProposition(proposition, pattern) !== null)
      .sort(([aId, a], [bId, b]) => compareRank(a, b) || compareText(aId, bId))
      .map(([, belief]) => belief);
  }
}
