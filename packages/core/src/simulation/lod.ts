import type { GameMinutes } from '../common/index.ts';
import type { LocationGraph } from '../world/index.ts';

export type LodLevel = 'focus' | 'background';

/** Longest step of a `focus` agent (ADR 0013). `background` steps run to the next boundary. */
export const FOCUS_STEP_MINUTES = 5;

export interface SimulationLodOptions {
  /** Story-active agents (for example the culprit while concealing) are always `focus`. */
  readonly storyActive?: (characterId: string, minute: GameMinutes) => boolean;
}

/**
 * Detail level of each agent: `focus` in the player's location, next to it (a connection in
 * either direction) and for story-active agents; `background` elsewhere. The level only sets the
 * detail of future steps; truth already written never changes (ADR 0013).
 */
export class SimulationLod {
  readonly #neighbors = new Map<string, Set<string>>();
  readonly #storyActive: NonNullable<SimulationLodOptions['storyActive']>;
  #focus: string | undefined;

  constructor(world: Pick<LocationGraph, 'snapshot'>, { storyActive }: SimulationLodOptions = {}) {
    this.#storyActive = storyActive ?? (() => false);
    const { locations } = world.snapshot();
    for (const { id } of locations) this.#neighbors.set(id, new Set());
    for (const { id, connections } of locations) {
      for (const { to } of connections) {
        this.#neighbors.get(id)?.add(to);
        this.#neighbors.get(to)?.add(id);
      }
    }
  }

  get focus(): string | undefined {
    return this.#focus;
  }

  /** Sets the player's location. Takes effect for steps planned after the call. */
  setFocus(location: string): void {
    if (!this.#neighbors.has(location)) throw new RangeError(`Unknown location: ${location}`);
    this.#focus = location;
  }

  level(characterId: string, location: string, minute: GameMinutes): LodLevel {
    if (this.#storyActive(characterId, minute)) return 'focus';
    const focus = this.#focus;
    if (focus === undefined) return 'background';
    return location === focus || this.#neighbors.get(focus)?.has(location) ? 'focus' : 'background';
  }

  /** Classification of agents at `minute`, ordered by character ID. */
  classify(
    agents: Iterable<{ readonly id: string; readonly location: string }>,
    minute: GameMinutes,
  ): Map<string, LodLevel> {
    const sorted = [...agents].sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
    return new Map(sorted.map(({ id, location }) => [id, this.level(id, location, minute)]));
  }
}
