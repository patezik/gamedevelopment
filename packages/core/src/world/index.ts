import type { ItemRegistry } from './items.ts';
import type { LocationGraph } from './locations.ts';

export interface WorldState {
  readonly locations: LocationGraph;
  readonly items: ItemRegistry;
  readonly durationMinutes: number;
}

export {
  LocationGraph,
  WorldError,
  type AccessCheck,
  type AccessRule,
  type Actor,
  type Light,
} from './locations.ts';

export {
  ItemError,
  ItemRegistry,
  type Item,
  type ItemMove,
  type ItemPlacement,
  type ItemRegistrySnapshot,
} from './items.ts';
