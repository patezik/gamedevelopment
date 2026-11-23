import { z } from 'zod';
import { contains, overlaps, sequentialId, type GameMinutes, type Interval } from '../common/index.ts';
import { entityRefSchema, factIdSchema, factSchema, matchProposition, verbSchema, type Fact, type PropositionPattern } from './facts.ts';

const id = z.string().min(1);
const eventId = z.string().regex(/^ev_[1-9][0-9]*$/);
const interval = z.strictObject({ from: z.int(), to: z.int() }).refine(({ from, to }) => from < to);
const eventInputSchema = z.strictObject({
  t: z.int(),
  duration: z.int().nonnegative(),
  verb: verbSchema,
  actorIds: z.array(id),
  location: id,
  targets: z.array(entityRefSchema),
  causes: z.array(eventId),
  facts: z.array(factSchema),
  traceIds: z.array(id),
  visibility: z.enum(['public', 'covert', 'private']),
});
const truthEventSchema = eventInputSchema.extend({ id: eventId });
const incidentRecordSchema = z.strictObject({
  type: id,
  victimIds: z.array(id),
  culpritIds: z.array(id),
  motive: factIdSchema,
  means: id,
  keyEventIds: z.array(eventId),
  window: interval,
});
const snapshotSchema = z.strictObject({
  incident: incidentRecordSchema,
  events: z.array(truthEventSchema),
});

export type TruthEventInput = z.infer<typeof eventInputSchema>;
export type TruthEvent = z.infer<typeof truthEventSchema>;
export type IncidentRecord = z.infer<typeof incidentRecordSchema>;
export type EventId = TruthEvent['id'];

export interface FactFilter {
  kind?: Fact['kind'];
  pattern?: PropositionPattern;
}

interface Presence {
  location: string;
  interval: Interval;
}
interface Possession {
  holder: string;
  interval: Interval;
}

export class TruthError extends Error {
  readonly code: 'TRUTH_UNKNOWN_EVENT' | 'TRUTH_INVALID_EVENT_ID';
  readonly eventId: EventId;

  constructor(code: TruthError['code'], eventId: EventId) {
    super(`${code}: ${eventId}`);
    this.code = code;
    this.eventId = eventId;
    this.name = 'TruthError';
  }
}

// Schemas yield detached JSON objects, so recursive freezing cannot affect the caller.
function freezeTree<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

function chronological(a: TruthEvent, b: TruthEvent): number {
  return a.t - b.t || a.id.length - b.id.length || (a.id < b.id ? -1 : Number(a.id > b.id));
}

function compareIntervals(a: { interval: Interval }, b: { interval: Interval }): number {
  return a.interval.from - b.interval.from || a.interval.to - b.interval.to;
}

function addToIndex<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const entries = index.get(key);
  if (entries) entries.push(value);
  else index.set(key, [value]);
}

export class TruthLog {
  private readonly byId = new Map<EventId, TruthEvent>();
  private readonly nextId = sequentialId('ev');

  append(input: TruthEventInput): TruthEvent {
    const payload = eventInputSchema.parse(input);
    const event = freezeTree({ ...payload, id: this.nextId() });
    this.byId.set(event.id, event);
    return event;
  }

  get(id: EventId): TruthEvent | undefined {
    return this.byId.get(id);
  }

  events(): readonly TruthEvent[] {
    return Object.freeze([...this.byId.values()].sort(chronological));
  }

  inAppendOrder(): readonly TruthEvent[] {
    return Object.freeze([...this.byId.values()]);
  }
}

export class TruthModel {
  private readonly log = new TruthLog();
  private readonly presence = new Map<string, Presence[]>();
  private readonly possessions = new Map<string, Possession[]>();
  private readonly factsByKind = new Map<Fact['kind'], Fact[]>();
  private readonly allFacts: Fact[] = [];
  private readonly incidentRecord: IncidentRecord;

  constructor(incident: IncidentRecord, history: readonly TruthEvent[] = []) {
    this.incidentRecord = freezeTree(incidentRecordSchema.parse(incident));
    for (const { id, ...input } of history) {
      if (this.append(input) !== id) throw new TruthError('TRUTH_INVALID_EVENT_ID', id);
    }
  }

  get incident(): IncidentRecord {
    return this.incidentRecord;
  }

  append(input: TruthEventInput): EventId {
    const event = this.log.append(input);
    for (const fact of event.facts) {
      this.allFacts.push(fact);
      addToIndex(this.factsByKind, fact.kind, fact);
      if (fact.kind === 'at') {
        addToIndex(this.presence, fact.who, { location: fact.where, interval: fact.interval });
      } else if (fact.kind === 'possessed') {
        addToIndex(this.possessions, fact.item, { holder: fact.who, interval: fact.interval });
      }
    }
    return event.id;
  }

  events(): readonly TruthEvent[] {
    return this.log.events();
  }

  whereWas(characterId: string, t: GameMinutes): string {
    return this.presence.get(characterId)?.find(({ interval }) => contains(interval, t))?.location ?? 'in_transit';
  }

  presenceIntervals(characterId: string): Presence[] {
    return structuredClone((this.presence.get(characterId) ?? []).toSorted(compareIntervals));
  }

  whoWasAt(locationId: string, interval: Interval): string[] {
    const characters: string[] = [];
    for (const [characterId, entries] of this.presence) {
      if (entries.some((entry) => entry.location === locationId && overlaps(entry.interval, interval))) {
        characters.push(characterId);
      }
    }
    return characters.sort();
  }

  possession(itemId: string): Possession[] {
    return structuredClone((this.possessions.get(itemId) ?? []).toSorted(compareIntervals));
  }

  causalChain(id: EventId): EventId[] {
    const event = this.log.get(id);
    if (!event) throw new TruthError('TRUTH_UNKNOWN_EVENT', id);

    const visited = new Set([id]);
    const pending = [...event.causes];
    const ancestors: TruthEvent[] = [];
    while (pending.length > 0) {
      const cause = pending.pop()!;
      if (visited.has(cause)) continue;
      visited.add(cause);
      const parent = this.log.get(cause);
      if (!parent) continue;
      ancestors.push(parent);
      for (const previous of parent.causes) pending.push(previous);
    }
    return ancestors.sort(chronological).map((parent) => parent.id);
  }

  facts(filter: FactFilter = {}): Fact[] {
    const kind = filter.kind ?? filter.pattern?.kind;
    const candidates = kind === undefined ? this.allFacts : this.factsByKind.get(kind) ?? [];
    const pattern = filter.pattern;
    return structuredClone(pattern ? candidates.filter((fact) => matchProposition(fact, pattern) !== null) : candidates);
  }

  serialize(): string {
    return JSON.stringify({ incident: this.incident, events: this.log.inAppendOrder() });
  }

  static deserialize(json: string): TruthModel {
    const { incident, events } = snapshotSchema.parse(JSON.parse(json));
    return new TruthModel(incident, events);
  }
}
