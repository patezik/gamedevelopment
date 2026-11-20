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

type ItemErrorCode =
  | 'WORLD_UNKNOWN_ITEM'
  | 'WORLD_INVALID_PLACEMENT'
  | 'WORLD_CONTAINER_CYCLE'
  | 'WORLD_INVALID_ITEM_TIME';

export class ItemError extends Error {
  constructor(readonly code: ItemErrorCode, message: string) {
    super(message);
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
  private readonly locationIds: ReadonlySet<string>;
  private latestMinute: GameMinutes;

  constructor(
    content: Pick<ScenarioContent, 'items' | 'locations'>,
    ownerByArchetype: ReadonlyMap<string, string> = new Map(),
    private readonly initialMinute: GameMinutes = 0,
  ) {
    requireMinute(initialMinute);
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
        throw new ItemError('WORLD_INVALID_PLACEMENT', `Expected one initial placement for unique item ${id}`);
      }
      this.records.set(id, { item: { id, kind, tags: [...tags] }, initial, moves: [] });
    }

    for (const [id, { initial }] of this.records) this.validatePlacement(id, initial);
  }

  get(id: string): Item {
    const { item } = this.getRecord(id);
    return { ...item, tags: [...item.tags] };
  }

  locate(id: string, t: GameMinutes): ItemPlacement {
    requireMinute(t);
    if (t < this.initialMinute) {
      throw new ItemError('WORLD_INVALID_ITEM_TIME', `Items are not placed before minute ${this.initialMinute}`);
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
      throw new ItemError('WORLD_INVALID_ITEM_TIME', `Cannot move an item before minute ${this.latestMinute}`);
    }
    this.validatePlacement(id, to);
    record.moves.push({ t, to: { ...to }, cause });
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
