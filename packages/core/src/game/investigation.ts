import { z } from 'zod';
import {
  characterSchema,
  relationshipSchema,
  RelationshipGraph,
  validateRoutine,
  type Character,
} from '../characters/index.ts';
import { canonicalJson } from '../common/index.ts';
import { itemsSchema, locationsSchema, presetSchema } from '../content/index.ts';
import { isCalendarStartIso } from '../time/index.ts';
import { factId, factSchema, TruthModel, type EntityRef } from '../truth/index.ts';
import { ItemRegistry, LocationGraph, type WorldState } from '../world/index.ts';

const id = z.string().min(1);
const metadataSchema = z.strictObject({
  scenarioId: presetSchema.shape.id,
  seed: z.string(),
  generatorVersion: id.regex(/\S/),
});
const placementSchema = z.strictObject({
  kind: z.enum(['location', 'character', 'container']),
  id,
});
const itemsSnapshotSchema = z.strictObject({
  initialMinute: z.int(),
  initial: z.array(
    z.strictObject({
      item: itemsSchema.element.pick({ id: true, kind: true, tags: true }),
      placement: placementSchema,
    }),
  ),
  moves: z.array(z.strictObject({ itemId: id, t: z.int(), to: placementSchema, cause: id })),
});
const secretSchema = z.strictObject({ id, fact: factSchema, knownBy: z.array(id) });
const snapshotSchema = metadataSchema.extend({
  world: z.strictObject({
    startDateTime: z.string().refine(isCalendarStartIso),
    durationMinutes: z.int().positive(),
    locations: locationsSchema,
    items: itemsSnapshotSchema,
  }),
  characters: z.array(characterSchema).min(1),
  relationships: z.array(relationshipSchema),
  truth: z.json(),
  secrets: z.array(secretSchema),
});

type InvestigationMetadata = z.infer<typeof metadataSchema>;
export type InvestigationSnapshot = z.infer<typeof snapshotSchema>;
export type Secret = z.infer<typeof secretSchema>;

/** Authoritative server data, including the solution and private knowledge. */
export interface Investigation extends InvestigationMetadata {
  readonly world: WorldState;
  readonly characters: readonly Character[];
  readonly relationships: RelationshipGraph;
  readonly truth: TruthModel;
  readonly secrets: readonly Secret[];
}

export class InvestigationError extends Error {
  readonly code = 'INVESTIGATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`INVESTIGATION_INVALID: ${message}`, options);
    this.name = 'InvestigationError';
  }
}

function uniqueIds(values: readonly { id: string }[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const { id } of values) {
    if (ids.has(id)) throw new InvestigationError(`Duplicate ${label} ${id}`);
    ids.add(id);
  }
  return ids;
}

function requireId(ids: ReadonlySet<string>, id: string, label: string): void {
  if (!ids.has(id)) throw new InvestigationError(`Unknown ${label} ${id}`);
}

function validateReferences(data: InvestigationSnapshot, truth: TruthModel): void {
  const locations = uniqueIds(data.world.locations, 'location');
  const characters = uniqueIds(data.characters, 'character');
  const secrets = uniqueIds(data.secrets, 'secret');
  const items = uniqueIds(
    data.world.items.initial.map(({ item }) => item),
    'item',
  );
  const events = truth.events();
  const eventIds = new Set(events.map(({ id }) => id));
  const truthCharacters = new Set([...characters, 'player']);

  const location = (id: string) => requireId(locations, id, 'location');
  const item = (id: string) => requireId(items, id, 'item');
  const character = (id: string) => requireId(characters, id, 'character');
  const actor = (id: string) => requireId(truthCharacters, id, 'character');
  const event = (id: string) => requireId(eventIds, id, 'event');
  const entity = (ref: EntityRef) => {
    // Documents have no registry at this stage.
    if (ref.kind === 'character') actor(ref.id);
    else if (ref.kind === 'location') location(ref.id);
    else if (ref.kind === 'item') item(ref.id);
  };
  for (const entry of data.world.locations) {
    for (const connection of entry.connections) {
      location(connection.to);
      if (connection.locked?.itemId !== undefined) item(connection.locked.itemId);
    }
    for (const rule of entry.access) if (rule.itemId !== undefined) item(rule.itemId);
    for (const hotspot of entry.hotspots) hotspot.itemIds?.forEach(item);
  }
  for (const entry of data.characters) {
    validateRoutine(entry);
    for (const block of entry.routine) location(block.location);
    for (const grant of entry.access) {
      if ('locationId' in grant) location(grant.locationId);
      if ('itemId' in grant) item(grant.itemId);
    }
    for (const id of entry.secrets) requireId(secrets, id, 'secret');
  }
  for (const { a, b, history } of data.relationships) {
    character(a);
    character(b);
    history.forEach(event);
  }
  for (const { placement } of data.world.items.initial) {
    if (placement.kind === 'character') actor(placement.id);
  }
  for (const { to, cause } of data.world.items.moves) {
    if (to.kind === 'character') actor(to.id);
    event(cause);
  }

  truth.incident.victimIds.forEach(character);
  truth.incident.culpritIds.forEach(character);
  if (!truth.facts({ kind: 'motive' }).some((fact) => factId(fact) === truth.incident.motive)) {
    throw new InvestigationError(`Unknown motive ${truth.incident.motive}`);
  }
  if (truth.incident.means.startsWith('it_')) item(truth.incident.means);
  for (const entry of events) {
    entry.actorIds.forEach(actor);
    location(entry.location);
    entry.targets.forEach(entity);
  }
  for (const secret of data.secrets) secret.knownBy.forEach(character);
}

/** Creates detached server data suitable for canonicalJson and stateHash. */
export function snapshotInvestigation(investigation: Investigation): InvestigationSnapshot {
  const { scenarioId, seed, generatorVersion, world, characters, relationships, truth, secrets } =
    investigation;
  const serializedTruth: unknown = JSON.parse(truth.serialize());
  return snapshotSchema.parse({
    scenarioId,
    seed,
    generatorVersion,
    world: {
      ...world.locations.snapshot(),
      durationMinutes: world.durationMinutes,
      items: world.items.snapshot(),
    },
    characters,
    relationships: relationships.snapshot(),
    truth: serializedTruth,
    secrets,
  });
}

export function serializeInvestigation(investigation: Investigation): string {
  return canonicalJson(snapshotInvestigation(investigation));
}

function restore(data: InvestigationSnapshot): Investigation {
  const { world, characters, relationships, secrets, scenarioId, seed, generatorVersion } = data;
  const truth = TruthModel.deserialize(canonicalJson(data.truth));
  validateReferences(data, truth);
  return {
    scenarioId,
    seed,
    generatorVersion,
    world: {
      locations: new LocationGraph({
        locations: world.locations,
        preset: { time: { startDateTime: world.startDateTime } },
      }),
      items: ItemRegistry.restore(world.items, world.locations),
      durationMinutes: world.durationMinutes,
    },
    characters,
    relationships: new RelationshipGraph(relationships),
    truth,
    secrets,
  };
}

export function deserializeInvestigation(json: string): Investigation {
  try {
    return restore(snapshotSchema.parse(JSON.parse(json)));
  } catch (error) {
    if (error instanceof InvestigationError) throw error;
    throw new InvestigationError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/**
 * Assembles an investigation from the same domain objects used by the engine and generator.
 *
 * @example
 * const investigation = new InvestigationBuilder({
 *   scenarioId: 'tiny-manor', seed: 'fixture', generatorVersion: '0.1.0',
 * })
 *   .withWorld({ locations, items, durationMinutes: 1440 })
 *   .withCharacters(cast)
 *   .withTruth(truthModel)
 *   .withRelationships(relationships)
 *   .withSecrets(secrets)
 *   .build();
 */
export class InvestigationBuilder {
  readonly #metadata: InvestigationMetadata;
  #world?: WorldState;
  #characters?: readonly Character[];
  #truth?: TruthModel;
  #relationships = new RelationshipGraph();
  #secrets: readonly Secret[] = [];

  constructor(metadata: InvestigationMetadata) {
    this.#metadata = metadataSchema.parse(metadata);
  }

  withWorld(world: WorldState): this {
    this.#world = world;
    return this;
  }

  withCharacters(characters: readonly Character[]): this {
    this.#characters = characters;
    return this;
  }

  withTruth(truth: TruthModel): this {
    this.#truth = truth;
    return this;
  }

  withRelationships(relationships: RelationshipGraph): this {
    this.#relationships = relationships;
    return this;
  }

  withSecrets(secrets: readonly Secret[]): this {
    this.#secrets = secrets;
    return this;
  }

  build(): Investigation {
    const world = this.#world;
    const characters = this.#characters;
    const truth = this.#truth;
    if (!world || !characters || !truth) {
      const missing = Object.entries({ world, characters, truth })
        .filter(([, value]) => value == null)
        .map(([key]) => key);
      throw new InvestigationError(`Missing required fields: ${missing.join(', ')}`);
    }
    return restore(
      snapshotInvestigation({
        ...this.#metadata,
        world,
        characters,
        truth,
        relationships: this.#relationships,
        secrets: this.#secrets,
      }),
    );
  }
}
