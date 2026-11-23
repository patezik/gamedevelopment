import type { ScenarioContent } from '@hs/core/content';
import { ItemRegistry, LocationGraph, type WorldState } from '@hs/core/world';
import type { Stage } from '../pipeline/index.ts';

type WorldOptions = NonNullable<ScenarioContent['preset']['world']>;
type Variant = NonNullable<WorldOptions['variants']>[number];

export interface GeneratedWorld extends Pick<WorldState, 'locations' | 'durationMinutes'> {
  readonly startLocationId: string;
  readonly variantId?: string;
  createWorldState(ownerByArchetype?: ReadonlyMap<string, string>): WorldState;
}

function locationsFor(content: ScenarioContent, variant: Variant | undefined) {
  const locations = structuredClone(content.locations);
  for (const { from, to, locked } of variant?.doors ?? []) {
    const edge = locations
      .find(({ id }) => id === from)
      ?.connections.find((edge) => edge.to === to);
    if (!edge) throw new RangeError(`Unknown world variant connection: ${from} → ${to}`);
    if (locked === null) delete edge.locked;
    else edge.locked = { ...locked };
  }
  return locations;
}

function itemsFor(content: ScenarioContent, variant: Variant | undefined) {
  const items = structuredClone(content.items);
  for (const { itemId, placement } of variant?.spawns ?? []) {
    const item = items.find(({ id }) => id === itemId);
    if (!item) throw new RangeError(`Unknown world variant item: ${itemId}`);
    delete item.locationId;
    delete item.containerId;
    delete item.ownerArchetype;
    switch (placement.kind) {
      case 'location':
        item.locationId = placement.id;
        break;
      case 'container':
        item.containerId = placement.id;
        break;
      case 'archetype':
        item.ownerArchetype = placement.id;
        break;
    }
  }
  return items;
}

export const worldGen: Stage<undefined, GeneratedWorld> = {
  name: 'WorldGen',
  generate(_input, { content, rng }) {
    const { preset } = content;
    const variants = preset.world?.variants;
    const variant = variants ? rng.fork('variant').pick(variants) : undefined;
    const definitions = locationsFor(content, variant);
    const items = itemsFor(content, variant);
    const startLocationId = preset.world?.startLocationId ?? definitions[0]!.id;
    const { durationMinutes, historyStartMinutes } = preset.time;
    const locations = new LocationGraph({ locations: definitions, preset });
    const itemIds = new Set(items.map(({ id }) => id));
    for (const { id } of definitions) {
      if (locations.travelTime(startLocationId, id, { itemIds }) === null) {
        throw new RangeError(`Unreachable location from ${startLocationId}: ${id}`);
      }
    }
    return {
      startLocationId,
      durationMinutes,
      locations,
      ...(variant && { variantId: variant.id }),
      createWorldState(ownerByArchetype) {
        return {
          locations,
          durationMinutes,
          items: new ItemRegistry(
            { items, locations: definitions },
            ownerByArchetype,
            historyStartMinutes,
          ),
        };
      },
    };
  },
};
