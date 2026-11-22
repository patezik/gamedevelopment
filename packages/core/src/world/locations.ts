import type { GameMinutes } from '../common/index.ts';
import type { ScenarioContent } from '../content/index.ts';
import { Calendar, type DayPeriod } from '../time/index.ts';

type Location = ScenarioContent['locations'][number];
type LocationGraphContent = Pick<ScenarioContent, 'locations'> & {
  preset: { time: Pick<ScenarioContent['preset']['time'], 'startDateTime'> };
};
export type AccessRule = Location['access'][number];
export type Light = Location['lighting'][DayPeriod];

export interface Actor {
  readonly archetypeId?: string;
  readonly itemIds?: ReadonlySet<string>;
}

type AccessDenial = 'outside_hours' | 'archetype_not_allowed' | 'missing_item';
export type AccessCheck = { ok: true } | { ok: false; reason: AccessDenial };
type WorldErrorCode = 'WORLD_UNKNOWN_LOCATION' | 'WORLD_NO_PATH';

export class WorldError extends Error {
  constructor(
    readonly code: WorldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorldError';
  }
}

function deniedBy(rule: AccessRule, actor: Actor, minute: number): AccessDenial | undefined {
  const from = rule.from ?? 0;
  const to = rule.to ?? 1440;
  const open = from <= to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!open) return 'outside_hours';
  if (rule.archetypes && !rule.archetypes.some((id) => id === actor.archetypeId)) {
    return 'archetype_not_allowed';
  }
  if (rule.itemId !== undefined && !actor.itemIds?.has(rule.itemId)) return 'missing_item';
  return undefined;
}

interface Route {
  minutes: number;
  path: string[];
}

export class LocationGraph {
  private readonly locations = new Map<string, Location>();
  private readonly calendar: Calendar;
  readonly startDateTime: string;

  constructor(content: Pick<ScenarioContent, 'locations' | 'preset'>);
  constructor(content: LocationGraphContent);
  constructor(content: LocationGraphContent) {
    this.startDateTime = content.preset.time.startDateTime;
    this.calendar = new Calendar(this.startDateTime);
    for (const location of content.locations) {
      this.locations.set(location.id, structuredClone(location));
    }
  }

  snapshot(): { startDateTime: string; locations: Location[] } {
    return {
      startDateTime: this.startDateTime,
      locations: structuredClone([...this.locations.values()]),
    };
  }

  directConnection(from: string, to: string, actor: Actor = {}): Location['connections'][number] | undefined {
    const connection = this.getLocation(from).connections.find((edge) => edge.to === to);
    if (!connection || (connection.locked && !actor.itemIds?.has(connection.locked.itemId ?? ''))) {
      return undefined;
    }
    return structuredClone(connection);
  }

  travelTime(from: string, to: string, actor: Actor = {}): number | null {
    return this.findRoute(from, to, actor)?.minutes ?? null;
  }

  path(from: string, to: string, actor: Actor = {}): string[] {
    const route = this.findRoute(from, to, actor);
    if (!route) throw new WorldError('WORLD_NO_PATH', `No path from ${from} to ${to}`);
    return route.path;
  }

  lightingAt(id: string, period: DayPeriod): Light {
    return this.getLocation(id).lighting[period];
  }

  isAccessible(id: string, actor: Actor, t: GameMinutes): AccessCheck {
    const { access } = this.getLocation(id);
    if (access.length === 0) return { ok: true };

    const { hh, mm } = this.calendar.toDisplay(t);
    const minute = hh * 60 + mm;
    let firstDenial: AccessDenial | undefined;
    for (const rule of access) {
      const denial = deniedBy(rule, actor, minute);
      if (denial === undefined) return { ok: true };
      firstDenial ??= denial;
    }
    return { ok: false, reason: firstDenial! };
  }

  private getLocation(id: string): Location {
    const location = this.locations.get(id);
    if (!location) throw new WorldError('WORLD_UNKNOWN_LOCATION', `Unknown location: ${id}`);
    return location;
  }

  private findRoute(from: string, to: string, actor: Actor): Route | undefined {
    this.getLocation(from);
    this.getLocation(to);
    const pending = new Map([[from, 0]]);
    const visited = new Set<string>();
    const previous = new Map<string, string>();

    while (pending.size > 0) {
      let current: string | undefined;
      let minutes = Infinity;
      for (const [id, distance] of pending) {
        if (current === undefined || distance < minutes || (distance === minutes && id < current)) {
          current = id;
          minutes = distance;
        }
      }
      if (current === undefined) break;
      if (current === to) {
        const path: string[] = [];
        for (let id: string | undefined = to; id !== undefined; id = previous.get(id)) {
          path.push(id);
        }
        return { minutes, path: path.reverse() };
      }

      pending.delete(current);
      visited.add(current);
      for (const edge of this.getLocation(current).connections) {
        if (visited.has(edge.to)) continue;
        if (
          edge.locked &&
          (edge.locked.itemId === undefined || !actor.itemIds?.has(edge.locked.itemId))
        ) {
          continue;
        }
        const candidate = minutes + edge.minutes;
        const known = pending.get(edge.to) ?? Infinity;
        const predecessor = previous.get(edge.to);
        if (
          candidate > known ||
          (candidate === known && predecessor !== undefined && current >= predecessor)
        ) {
          continue;
        }
        pending.set(edge.to, candidate);
        previous.set(edge.to, current);
      }
    }
    return undefined;
  }
}
