import type { GameMinutes } from '../common/index.ts';
import type { ScenarioContent } from '../content/index.ts';

export type ItemPlacement =
  | { readonly kind: 'location'; readonly id: string }
  | { readonly kind: 'character'; readonly id: string }
  | { readonly kind: 'container'; readonly id: string };

export interface Item {
  readonly id: string;
  readonly kind: string;
  readonly tags: readonly string[];
}

export interface ItemMove {
  readonly t: GameMinutes;
  readonly to: ItemPlacement;
  readonly cause: string;
}

interface ItemRecord {
  item: Item;
  initial: ItemPlacement;
  moves: ItemMove[];
}

export interface ItemRegistrySnapshot {
  readonly initialMinute: GameMinutes;
  readonly initial: readonly { readonly item: Item; readonly placement: ItemPlacement }[];
  readonly moves: readonly (ItemMove & { readonly itemId: string })[];
}

type ItemErrorCode =
  | 'WORLD_UNKNOWN_ITEM'
  | 'WORLD_INVALID_PLACEMENT'
  | 'WORLD_CONTAINER_CYCLE'
  | 'WORLD_INVALID_ITEM_TIME';

export class ItemError extends Error {
  readonly code: ItemErrorCode;

  constructor(
    code: ItemErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'ItemError';
  }
}

function requireMinute(t: GameMinutes): void {
  if (!Number.isSafeInteger(t)) {
    throw new ItemError('WORLD_INVALID_ITEM_TIME', 'Expected an integer game minute');
  }
}

export class ItemRegistry {
  private readonly records = new Map<string, ItemRecord>();
  private readonly moves: (ItemMove & { readonly itemId: string })[] = [];
  private readonly locationIds: ReadonlySet<string>;
  private readonly initialMinute: GameMinutes;
  private latestMinute: GameMinutes;

  constructor(
    content: Pick<ScenarioContent, 'items' | 'locations'>,
    ownerByArchetype: ReadonlyMap<string, string> = new Map(),
    initialMinute: GameMinutes = 0,
  ) {
    requireMinute(initialMinute);
    this.initialMinute = initialMinute;
    this.latestMinute = initialMinute;
    this.locationIds = new Set(content.locations.map(({ id }) => id));

    for (const { id, kind, tags, locationId, containerId, ownerArchetype } of content.items) {
      const destinations: ItemPlacement[] = [];
      if (locationId !== undefined) destinations.push({ kind: 'location', id: locationId });
      if (containerId !== undefined) destinations.push({ kind: 'container', id: containerId });
      if (ownerArchetype !== undefined) {
        const ownerId = ownerByArchetype.get(ownerArchetype);
        if (!ownerId) {
          throw new ItemError('WORLD_INVALID_PLACEMENT', `Unresolved owner for item ${id}`);
        }
        destinations.push({ kind: 'character', id: ownerId });
      }

      const [initial] = destinations;
      if (!initial || destinations.length !== 1 || this.records.has(id)) {
        throw new ItemError(
          'WORLD_INVALID_PLACEMENT',
          `Expected one initial placement for unique item ${id}`,
        );
      }
      this.records.set(id, { item: { id, kind, tags: [...tags] }, initial, moves: [] });
    }

    for (const [id, { initial }] of this.records) this.validatePlacement(id, initial);
  }

  snapshot(): ItemRegistrySnapshot {
    return structuredClone({
      initialMinute: this.initialMinute,
      initial: Array.from(this.records.values(), ({ item, initial }) => ({
        item,
        placement: initial,
      })),
      moves: this.moves,
    });
  }

  static restore(
    snapshot: ItemRegistrySnapshot,
    locations: Pick<ScenarioContent, 'locations'>['locations'],
  ): ItemRegistry {
    const registry = new ItemRegistry({ locations, items: [] }, new Map(), snapshot.initialMinute);
    for (const { item, placement } of snapshot.initial) {
      if (registry.records.has(item.id)) {
        throw new ItemError('WORLD_INVALID_PLACEMENT', `Duplicate item ${item.id}`);
      }
      registry.records.set(item.id, {
        item: structuredClone(item),
        initial: { ...placement },
        moves: [],
      });
    }
    for (const [id, { initial }] of registry.records) registry.validatePlacement(id, initial);
    // Different items may move in the same minute. Replay the original order to preserve containment.
    for (const { itemId, to, t, cause } of snapshot.moves) registry.move(itemId, to, t, cause);
    return registry;
  }

  get(id: string): Item {
    const { item } = this.getRecord(id);
    return { ...item, tags: [...item.tags] };
  }

  idsOfKinds(kinds: ReadonlySet<string>): string[] {
    const ids: string[] = [];
    for (const [id, { item }] of this.records) {
      if (kinds.has(item.kind)) ids.push(id);
    }
    return ids;
  }

  locate(id: string, t: GameMinutes): ItemPlacement {
    requireMinute(t);
    if (t < this.initialMinute) {
      throw new ItemError(
        'WORLD_INVALID_ITEM_TIME',
        `Items are not placed before minute ${this.initialMinute}`,
      );
    }

    const { initial, moves } = this.getRecord(id);
    return { ...(moves.findLast((move) => move.t <= t)?.to ?? initial) };
  }

  history(id: string): readonly ItemMove[] {
    return this.getRecord(id).moves.map((move) => ({ ...move, to: { ...move.to } }));
  }

  move(id: string, to: ItemPlacement, t: GameMinutes, cause: string): void {
    const record = this.getRecord(id);
    requireMinute(t);
    // Historical insertion would also require rechecking every later container placement.
    if (t < this.latestMinute) {
      throw new ItemError(
        'WORLD_INVALID_ITEM_TIME',
        `Cannot move an item before minute ${this.latestMinute}`,
      );
    }
    this.validatePlacement(id, to);
    const move = { t, to: { ...to }, cause };
    record.moves.push(move);
    this.moves.push({ itemId: id, ...move });
    this.latestMinute = t;
  }

  private getRecord(id: string): ItemRecord {
    const record = this.records.get(id);
    if (!record) throw new ItemError('WORLD_UNKNOWN_ITEM', `Unknown item ${id}`);
    return record;
  }

  private validatePlacement(id: string, to: ItemPlacement): void {
    if (!to.id || (to.kind === 'location' && !this.locationIds.has(to.id))) {
      throw new ItemError('WORLD_INVALID_PLACEMENT', `Invalid destination ${to.id} for item ${id}`);
    }

    const visited = new Set([id]);
    let destination = to;
    while (destination.kind === 'container') {
      if (visited.has(destination.id)) {
        throw new ItemError('WORLD_CONTAINER_CYCLE', `Container cycle at item ${destination.id}`);
      }
      visited.add(destination.id);
      const container = this.getRecord(destination.id);
      destination = container.moves.at(-1)?.to ?? container.initial;
    }
  }
}
