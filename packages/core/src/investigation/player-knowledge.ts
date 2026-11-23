import { FORBIDDEN_VIEW_KEYS } from '@hs/protocol';
import { z } from 'zod';
import type { GameMinutes } from '../common/index.ts';
import type { Statement } from '../knowledge/index.ts';

type PlayerKnowledgeErrorCode =
  'INVESTIGATION_INVALID_INPUT' | 'INVESTIGATION_UNKNOWN_CLUE' | 'INVESTIGATION_INVALID_STATE';

export class PlayerKnowledgeError extends Error {
  readonly code: PlayerKnowledgeErrorCode;

  constructor(code: PlayerKnowledgeErrorCode, message: string) {
    super(message);
    this.name = 'PlayerKnowledgeError';
    this.code = code;
  }
}

/** A clue the player has found. Nothing here points back into the truth. */
export interface DiscoveredClue {
  readonly clueId: string;
  readonly discoveredAt: GameMinutes;
  readonly location: string;
  /** True once the clue is fixed with the phone camera (`captureMode: "qr"` clues). */
  readonly captured: boolean;
}

/** A statement as the player knows it: what was said, never whether it was true. */
export type HeardStatement = Omit<Statement, 'veracity'>;

/** One automatic note of the investigation journal. Text is rendered by the clients. */
export type JournalEntry = {
  /** Order of insertion: breaks ties between entries at the same game minute. */
  readonly seq: number;
  readonly at: GameMinutes;
} & (
  | { readonly kind: 'clue'; readonly clueId: string; readonly location: string }
  | { readonly kind: 'capture'; readonly clueId: string }
  | { readonly kind: 'statement'; readonly statementId: string; readonly speakerId: string }
  | { readonly kind: 'contact'; readonly characterId: string }
);

export interface PlayerKnowledgeSnapshot {
  readonly clues: readonly DiscoveredClue[];
  readonly statements: readonly HeardStatement[];
  readonly contacts: readonly string[];
  readonly journal: readonly JournalEntry[];
  readonly nextSeq: number;
}

const id = z.string().min(1);
const minute = z.int();

const clueSchema = z.strictObject({
  clueId: id,
  discoveredAt: minute,
  location: id,
  captured: z.boolean(),
});
// The statement's `proposition` comes from the truth model, which this module must not import
// (docs/architecture/modules.md section 9), so it is checked for shape only: an object with a kind.
const statementSchema = z.strictObject({
  id,
  speakerId: id,
  proposition: z.looseObject({ kind: id }),
  topic: id,
  at: minute,
  templateKey: id,
});
const base = { seq: z.int().nonnegative(), at: minute };
const journalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('clue'), clueId: id, location: id }),
  z.strictObject({ ...base, kind: z.literal('capture'), clueId: id }),
  z.strictObject({ ...base, kind: z.literal('statement'), statementId: id, speakerId: id }),
  z.strictObject({ ...base, kind: z.literal('contact'), characterId: id }),
]);
const snapshotSchema = z.strictObject({
  clues: z.array(clueSchema),
  statements: z.array(statementSchema),
  contacts: z.array(id),
  journal: z.array(journalSchema),
  nextSeq: z.int().nonnegative(),
});

/** `Omit` applied to each member of a union, not to the union as a whole. */
type EntryBody<T> = T extends unknown ? Omit<T, 'seq'> : never;

const invalid = (message: string) =>
  new PlayerKnowledgeError('INVESTIGATION_INVALID_INPUT', message);

function wholeMinute(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value)) throw invalid(`${name} must be a whole game minute`);
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value === '')
    throw invalid(`${name} must be a non-empty string`);
}

/** Looks for keys that mark server-side truth anywhere inside a value. */
function findTruthKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTruthKey(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if ((FORBIDDEN_VIEW_KEYS as readonly string[]).includes(key)) return key;
    const found = findTruthKey(child);
    if (found) return found;
  }
  return undefined;
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Everything the player knows, and only that: clues found, statements heard (without their
 * veracity), known contacts, and an automatic journal in game-time order. The boards, the phone
 * and the accusation are built from this and never from the truth.
 *
 * Adding is idempotent: what is already known is ignored and the method returns `false`.
 */
export class PlayerKnowledge {
  readonly #clues = new Map<string, DiscoveredClue>();
  readonly #statements = new Map<string, HeardStatement>();
  readonly #contacts = new Set<string>();
  #journal: JournalEntry[] = [];
  #nextSeq = 0;

  get clues(): ReadonlyMap<string, DiscoveredClue> {
    return this.#clues;
  }

  /** In the order they were heard. */
  get statements(): readonly HeardStatement[] {
    return [...this.#statements.values()];
  }

  get contacts(): ReadonlySet<string> {
    return this.#contacts;
  }

  /** Ordered by game minute; entries of the same minute keep the order they were added in. */
  get journal(): readonly JournalEntry[] {
    return this.#journal;
  }

  #record(entry: EntryBody<JournalEntry>): void {
    const full = freeze({ ...entry, seq: this.#nextSeq++ }) as JournalEntry;
    // Insert after every entry that is not later than this one (binary search for the upper bound).
    let low = 0;
    let high = this.#journal.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.#journal[middle]?.at ?? 0) <= full.at) low = middle + 1;
      else high = middle;
    }
    this.#journal.splice(low, 0, full);
  }

  /** The player found a clue. `captured` is true if it is already on the phone. */
  addClue(clue: {
    clueId: string;
    discoveredAt: GameMinutes;
    location: string;
    captured?: boolean;
  }): boolean {
    nonEmpty(clue.clueId, 'clueId');
    nonEmpty(clue.location, 'location');
    wholeMinute(clue.discoveredAt, 'discoveredAt');
    if (this.#clues.has(clue.clueId)) return false;

    const { clueId, discoveredAt, location } = clue;
    this.#clues.set(
      clueId,
      freeze({ clueId, discoveredAt, location, captured: clue.captured ?? false }),
    );
    this.#record({ at: discoveredAt, kind: 'clue', clueId, location });
    return true;
  }

  /** The phone camera fixed a clue the player had already found. */
  markCaptured(clueId: string, at: GameMinutes): boolean {
    wholeMinute(at, 'at');
    const clue = this.#clues.get(clueId);
    if (!clue)
      throw new PlayerKnowledgeError('INVESTIGATION_UNKNOWN_CLUE', `Unknown clue ${clueId}`);
    if (clue.captured) return false;

    this.#clues.set(clueId, freeze({ ...clue, captured: true }));
    this.#record({ at, kind: 'capture', clueId });
    return true;
  }

  /**
   * The player heard a statement. Pass the engine's `Statement` as it is: its `veracity` is
   * removed here, at run time, so the truth cannot slip in through an object with extra fields.
   * Truth-marking keys anywhere else inside the statement are refused.
   */
  addStatement(statement: HeardStatement | Statement): boolean {
    const heard: Record<string, unknown> = { ...statement };
    delete heard.veracity;
    const parsed = statementSchema.safeParse(heard);
    if (!parsed.success) {
      throw invalid(
        `Not a statement: ${parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; ')}`,
      );
    }
    const leaked = findTruthKey(parsed.data);
    if (leaked) throw invalid(`A statement must not carry "${leaked}"`);
    if (this.#statements.has(parsed.data.id)) return false;

    const stored = freeze(structuredClone(parsed.data)) as HeardStatement;
    this.#statements.set(stored.id, stored);
    this.#record({
      at: stored.at,
      kind: 'statement',
      statementId: stored.id,
      speakerId: stored.speakerId,
    });
    return true;
  }

  /** The player learned how to reach a character. */
  addContact(characterId: string, at: GameMinutes): boolean {
    nonEmpty(characterId, 'characterId');
    wholeMinute(at, 'at');
    if (this.#contacts.has(characterId)) return false;

    this.#contacts.add(characterId);
    this.#record({ at, kind: 'contact', characterId });
    return true;
  }

  /** A detached, JSON-pure copy that `restore` accepts. */
  serialize(): PlayerKnowledgeSnapshot {
    return structuredClone({
      clues: [...this.#clues.values()],
      statements: [...this.#statements.values()],
      contacts: [...this.#contacts],
      journal: this.#journal,
      nextSeq: this.#nextSeq,
    });
  }

  /** Rebuilds knowledge from `serialize()` output; corrupt or truth-carrying input is refused. */
  static restore(saved: unknown): PlayerKnowledge {
    const parsed = snapshotSchema.safeParse(saved);
    const fail = (message: string) =>
      new PlayerKnowledgeError('INVESTIGATION_INVALID_STATE', message);
    if (!parsed.success) {
      throw fail(
        parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; '),
      );
    }
    const snapshot = parsed.data;
    const leaked = findTruthKey(snapshot);
    if (leaked) throw fail(`The save carries "${leaked}"`);

    const knowledge = new PlayerKnowledge();
    for (const clue of snapshot.clues) {
      if (knowledge.#clues.has(clue.clueId)) throw fail(`Duplicate clue ${clue.clueId}`);
      knowledge.#clues.set(clue.clueId, freeze(clue));
    }
    for (const statement of snapshot.statements) {
      if (knowledge.#statements.has(statement.id))
        throw fail(`Duplicate statement ${statement.id}`);
      knowledge.#statements.set(statement.id, freeze(statement) as HeardStatement);
    }
    for (const characterId of snapshot.contacts) {
      if (knowledge.#contacts.has(characterId)) throw fail(`Duplicate contact ${characterId}`);
      knowledge.#contacts.add(characterId);
    }

    const seen = new Set<number>();
    let previous: JournalEntry | undefined;
    for (const entry of snapshot.journal) {
      if (seen.has(entry.seq)) throw fail(`Duplicate journal entry ${entry.seq}`);
      seen.add(entry.seq);
      if (entry.seq >= snapshot.nextSeq)
        throw fail(`Journal entry ${entry.seq} is not below nextSeq`);
      if (
        previous &&
        (entry.at < previous.at || (entry.at === previous.at && entry.seq < previous.seq))
      ) {
        throw fail('The journal is not in game-time order');
      }
      previous = entry;
      const known =
        entry.kind === 'statement'
          ? knowledge.#statements.has(entry.statementId)
          : entry.kind === 'contact'
            ? knowledge.#contacts.has(entry.characterId)
            : knowledge.#clues.has(entry.clueId);
      if (!known) throw fail(`The journal mentions something unknown: entry ${entry.seq}`);
    }
    knowledge.#journal = snapshot.journal.map((entry) => freeze(entry) as JournalEntry);
    knowledge.#nextSeq = snapshot.nextSeq;
    return knowledge;
  }
}
