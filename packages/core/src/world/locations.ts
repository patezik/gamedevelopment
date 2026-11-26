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

export interface TimedTravelStep {
  readonly destination: string;
  readonly departAt: GameMinutes;
  readonly arriveAt: GameMinutes;
  readonly keyItemId?: string;
}

type AccessDenial = 'outside_hours' | 'archetype_not_allowed' | 'missing_item';
export type AccessCheck = { ok: true } | { ok: false; reason: AccessDenial };
type WorldErrorCode = 'WORLD_UNKNOWN_LOCATION' | 'WORLD_NO_PATH';

export class WorldError extends Error {
  readonly code: WorldErrorCode;

  constructor(code: WorldErrorCode, message: string) {
    super(message);
    this.code = code;
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
  firstStep: TimedTravelStep | undefined;
}

export class LocationGraph {
  private readonly locations = new Map<string, Location>();
  private readonly routes = new Map<string, Route | undefined>();
  private readonly clockMinutes = new Map<GameMinutes, number>();
  private readonly calendar: Calendar;
  readonly accessItemIds: readonly string[];
  readonly startDateTime: string;

  constructor(content: Pick<ScenarioContent, 'locations' | 'preset'>);
  constructor(content: LocationGraphContent);
  constructor(content: LocationGraphContent) {
    this.startDateTime = content.preset.time.startDateTime;
    this.calendar = new Calendar(this.startDateTime);
    const accessItemIds = new Set<string>();
    for (const location of content.locations) {
      this.locations.set(location.id, structuredClone(location));
      for (const { itemId } of location.access) {
        if (itemId !== undefined) accessItemIds.add(itemId);
      }
      for (const { locked } of location.connections) {
        if (locked?.itemId !== undefined) accessItemIds.add(locked.itemId);
      }
    }
    this.accessItemIds = Object.freeze([...accessItemIds].sort());
  }

  snapshot(): { startDateTime: string; locations: Location[] } {
    return {
      startDateTime: this.startDateTime,
      locations: structuredClone([...this.locations.values()]),
    };
  }

  describe(id: string): Location {
    return structuredClone(this.getLocation(id));
  }

  directConnection(
    from: string,
    to: string,
    actor: Actor = {},
  ): Location['connections'][number] | undefined {
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
    return [...route.path];
  }

  /** First edge of the earliest-arrival route, including any wait before departure. */
  nextTimedStep(from: string, to: string, actor: Actor, now: GameMinutes): TimedTravelStep | null {
    const step = this.findRoute(from, to, actor, now)?.firstStep;
    return step ? { ...step } : null;
  }

  lightingAt(id: string, period: DayPeriod): Light {
    return this.getLocation(id).lighting[period];
  }

  isAccessible(id: string, actor: Actor, t: GameMinutes): AccessCheck {
    const { access } = this.getLocation(id);
    if (access.length === 0) return { ok: true };

    const minute = this.minuteAt(t);
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

  private nextEntry(id: string, actor: Actor, earliest: GameMinutes): GameMinutes | null {
    const { access } = this.getLocation(id);
    if (access.length === 0) return earliest;

    const minute = this.minuteAt(earliest);
    const minutesPerDay = 1440;
    let next = Infinity;
    for (const rule of access) {
      if (deniedBy(rule, actor, minute) === undefined) return earliest;
      const opening = (rule.from ?? 0) % minutesPerDay;
      if (deniedBy(rule, actor, opening) === undefined) {
        next = Math.min(next, earliest + ((opening - minute + minutesPerDay) % minutesPerDay));
      }
    }
    return Number.isFinite(next) ? next : null;
  }

  private minuteAt(t: GameMinutes): number {
    const cached = this.clockMinutes.get(t);
    if (cached !== undefined) return cached;
    const { hh, mm } = this.calendar.toDisplay(t);
    const minute = hh * 60 + mm;
    if (this.clockMinutes.size >= 2048) {
      this.clockMinutes.delete(this.clockMinutes.keys().next().value!);
    }
    this.clockMinutes.set(t, minute);
    return minute;
  }

  private findRoute(from: string, to: string, actor: Actor, now?: GameMinutes): Route | undefined {
    this.getLocation(from);
    this.getLocation(to);
    // The graph is immutable. Simulated candidates repeatedly ask the same routing question;
    // retain a bounded set of answers, including failures, with every access input in the key.
    const key = JSON.stringify([
      from,
      to,
      actor.archetypeId ?? null,
      this.accessItemIds.filter((id) => actor.itemIds?.has(id)),
      now ?? null,
    ]);
    if (this.routes.has(key)) return this.routes.get(key);
    const route = this.computeRoute(from, to, actor, now);
    if (this.routes.size >= 2048) this.routes.delete(this.routes.keys().next().value!);
    this.routes.set(key, route);
    return route;
  }

  private computeRoute(
    from: string,
    to: string,
    actor: Actor,
    now?: GameMinutes,
  ): Route | undefined {
    const pending = new Map([[from, 0]]);
    const visited = new Set<string>();
    const previous = new Map<string, string>();
    const firstSteps = new Map<string, TimedTravelStep>();

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
        return { minutes, path: path.reverse(), firstStep: firstSteps.get(to) };
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
        let candidate = minutes + edge.minutes;
        if (now !== undefined) {
          // An earlier arrival can wait for every opening a later arrival could use.
          const entry = this.nextEntry(edge.to, actor, now + candidate);
          if (entry === null) continue;
          candidate = entry - now;
        }
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
        if (now !== undefined) {
          const arriveAt = now + candidate;
          firstSteps.set(
            edge.to,
            firstSteps.get(current) ?? {
              destination: edge.to,
              departAt: arriveAt - edge.minutes,
              arriveAt,
              ...(edge.locked?.itemId !== undefined && { keyItemId: edge.locked.itemId }),
            },
          );
        }
      }
    }
    return undefined;
  }
}
