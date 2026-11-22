import { z } from 'zod';
import type { Character } from './character.ts';

type CharacterId = Character['id'];
type EventId = string;

const relationTypeSchema = z.enum([
  'parent',
  'child',
  'sibling',
  'spouse',
  'romance',
  'friendship',
  'rivalry',
  'debt',
  'employment',
  'blackmail',
  'past_conflict',
]);
const id = z.string().min(1);
export const relationshipSchema = z.strictObject({
  a: id,
  b: id,
  type: relationTypeSchema,
  trust: z.number().min(-1).max(1),
  valence: z.number().min(0).max(1),
  intensity: z.number().min(0).max(1),
  history: z.array(id),
});

export type RelationType = z.infer<typeof relationTypeSchema>;

export interface Relationship {
  readonly a: CharacterId;
  readonly b: CharacterId;
  readonly type: RelationType;
  readonly trust: number;
  readonly valence: number;
  readonly intensity: number;
  readonly history: readonly EventId[];
}

type Scores = Pick<Relationship, 'trust' | 'valence' | 'intensity'>;
type NewRelationship = Omit<Relationship, 'history'> & { history?: readonly EventId[] };
type Edge = Pick<Relationship, 'a' | 'b' | 'type'> & {
  state: Scores & { history: EventId[] };
};

const reverseTypes: Partial<Record<RelationType, RelationType>> = {
  parent: 'child',
  child: 'parent',
  sibling: 'sibling',
  spouse: 'spouse',
  romance: 'romance',
  friendship: 'friendship',
  rivalry: 'rivalry',
  past_conflict: 'past_conflict',
};

function bounded(value: number, min: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Relationship scores must be finite');
  return Math.max(min, Math.min(1, value));
}

function snapshot(edge: Edge): Relationship {
  const { state, ...identity } = edge;
  return { ...identity, ...state, history: [...state.history] };
}

export class RelationshipGraph {
  readonly #neighbors = new Map<CharacterId, Map<CharacterId, Map<RelationType, Edge>>>();
  readonly #types = new Map<RelationType, Edge[]>();
  readonly #originals: Edge[] = [];

  constructor(relationships: Iterable<NewRelationship> = []) {
    for (const relationship of relationships) this.add(relationship);
  }

  add(relationship: NewRelationship): void {
    const { a, b, type, trust, valence, intensity, history = [] } = relationship;
    const reverse = reverseTypes[type];
    if (
      a === b ||
      this.#neighbors.get(a)?.get(b)?.has(type) ||
      (reverse && this.#neighbors.get(b)?.get(a)?.has(reverse))
    ) {
      throw new RangeError(`Invalid or duplicate relationship: ${a} → ${b} (${type})`);
    }
    const state = {
      trust: bounded(trust, -1),
      valence: bounded(valence, 0),
      intensity: bounded(intensity, 0),
      history: [...history],
    };
    const edge = { a, b, type, state };
    this.#insert(edge);
    this.#originals.push(edge);
    if (reverse) this.#insert({ a: b, b: a, type: reverse, state });
  }

  /** Original edges in insertion order. The constructor reconstructs their reverse edges. */
  snapshot(): Relationship[] {
    return this.#originals.map(snapshot);
  }

  get(a: CharacterId, b: CharacterId, type?: RelationType): Relationship | undefined {
    const edge = this.#find(a, b, type);
    return edge && snapshot(edge);
  }

  neighbors(a: CharacterId): Relationship[] {
    return [...(this.#neighbors.get(a)?.values() ?? [])].flatMap((edges) =>
      Array.from(edges.values(), snapshot),
    );
  }

  byType(type: RelationType): Relationship[] {
    return (this.#types.get(type) ?? []).map(snapshot);
  }

  adjust(
    a: CharacterId,
    b: CharacterId,
    delta: Partial<Scores>,
    cause: EventId,
    type?: RelationType,
  ): void {
    const edge = this.#find(a, b, type);
    if (!edge) throw new RangeError(`No relationship from ${a} to ${b}`);
    const { state } = edge;
    const trust = bounded(state.trust + (delta.trust ?? 0), -1);
    const valence = bounded(state.valence + (delta.valence ?? 0), 0);
    const intensity = bounded(state.intensity + (delta.intensity ?? 0), 0);
    Object.assign(state, { trust, valence, intensity });
    state.history.push(cause);
  }

  #find(a: CharacterId, b: CharacterId, type?: RelationType): Edge | undefined {
    const edges = this.#neighbors.get(a)?.get(b);
    return type === undefined ? edges?.values().next().value : edges?.get(type);
  }

  #insert(edge: Edge): void {
    const neighbors =
      this.#neighbors.get(edge.a) ?? new Map<CharacterId, Map<RelationType, Edge>>();
    const edges = neighbors.get(edge.b) ?? new Map<RelationType, Edge>();
    edges.set(edge.type, edge);
    neighbors.set(edge.b, edges);
    this.#neighbors.set(edge.a, neighbors);
    const typedEdges = this.#types.get(edge.type) ?? [];
    typedEdges.push(edge);
    this.#types.set(edge.type, typedEdges);
  }
}
