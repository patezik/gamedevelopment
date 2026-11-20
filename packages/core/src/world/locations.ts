import type { GameMinutes } from '../common/index.ts';
import type { ScenarioContent } from '../content/index.ts';
import { Calendar, type DayPeriod } from '../time/index.ts';

type Location = ScenarioContent['locations'][number];
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
  firstStep: TimedTravelStep | undefined;
}

export class LocationGraph {
  private readonly locations = new Map<string, Location>();
  private readonly calendar: Calendar;

  constructor(content: Pick<ScenarioContent, 'locations' | 'preset'>) {
    this.calendar = new Calendar(content.preset.time.startDateTime);
    for (const location of content.locations) {
      this.locations.set(location.id, structuredClone(location));
    }
  }

  travelTime(from: string, to: string, actor: Actor = {}): number | null {
    return this.findRoute(from, to, actor)?.minutes ?? null;
  }

  path(from: string, to: string, actor: Actor = {}): string[] {
    const route = this.findRoute(from, to, actor);
    if (!route) throw new WorldError('WORLD_NO_PATH', `No path from ${from} to ${to}`);
    return route.path;
  }

  /** First edge of the earliest-arrival route, including any wait before departure. */
  nextTimedStep(from: string, to: string, actor: Actor, now: GameMinutes): TimedTravelStep | null {
    return this.findRoute(from, to, actor, now)?.firstStep ?? null;
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

  private nextEntry(id: string, actor: Actor, earliest: GameMinutes): GameMinutes | null {
    const { access } = this.getLocation(id);
    if (access.length === 0) return earliest;

    const { hh, mm } = this.calendar.toDisplay(earliest);
    const minute = hh * 60 + mm;
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

  private findRoute(from: string, to: string, actor: Actor, now?: GameMinutes): Route | undefined {
    this.getLocation(from);
    this.getLocation(to);
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
            },
          );
        }
      }
    }
    return undefined;
  }
}
