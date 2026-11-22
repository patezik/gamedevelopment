import { overlaps, type GameMinutes, type Interval } from '../common/index.ts';
import {
  ItemError,
  WorldError,
  type Actor,
  type ItemPlacement,
  type ItemRegistry,
  type LocationGraph,
} from '../world/index.ts';
import type { EntityRef } from './facts.ts';
import type { EventId, TruthEvent, TruthEventInput, TruthModel } from './truth-model.ts';

/** Number of the invariant in truth-model.md §4. */
export type InvariantNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Declaration order is also the order of codes within an invariant in the result.
const INVARIANT_OF = {
  PRESENCE_OVERLAP: 1,
  TRANSIT_OVERLAP: 1,
  ACTOR_ELSEWHERE: 1,
  TRAVEL_TOO_FAST: 2,
  TRAVEL_NO_ROUTE: 2,
  TRAVEL_UNKNOWN_LOCATION: 2,
  CAUSE_UNKNOWN: 3,
  CAUSE_SELF: 3,
  CAUSE_NOT_BEFORE_EFFECT: 3,
  CAUSE_CYCLE: 3,
  ITEM_MOVE_UNKNOWN_CAUSE: 3,
  ITEM_MOVE_BEFORE_CAUSE: 3,
  ITEM_HOLDER_OVERLAP: 4,
  ITEM_PLACEMENT_CONFLICT: 4,
  ITEM_UNKNOWN: 4,
  ACTION_AFTER_DEATH: 5,
  ACTION_SPANS_DEATH: 5,
  KEY_EVENT_UNKNOWN: 7,
  KEY_EVENT_WITHOUT_CULPRIT: 7,
} as const satisfies Record<string, InvariantNumber>;

export type InvariantViolationCode = keyof typeof INVARIANT_OF;

export interface InvariantViolation {
  /** `checkTruthInvariants` never reports invariant 6; SIM-002 checks it (truth-model.md §4). */
  readonly invariant: InvariantNumber;
  readonly code: InvariantViolationCode;
  /** The event where the violation shows first, then the events it conflicts with. */
  readonly eventIds: readonly EventId[];
  readonly subject?: EntityRef;
  readonly minute?: GameMinutes;
  readonly message: string;
}

/** The part of `WorldState` the invariants read. */
export interface InvariantWorld {
  readonly locations: Pick<LocationGraph, 'travelTime'>;
  readonly items: Pick<ItemRegistry, 'locate' | 'history'>;
}

export interface InvariantCheckOptions {
  /**
   * The log is still being written: references to events beyond the end of the log are pending,
   * and the newest event may not be mirrored in the item registry yet, because a registry move
   * needs the id that `append` returns.
   */
  readonly incremental?: boolean;
}

export class TruthInvariantError extends Error {
  readonly code = 'TRUTH_INVARIANT_VIOLATION';

  constructor(
    readonly violations: readonly InvariantViolation[],
    readonly eventId?: EventId,
  ) {
    const after = eventId === undefined ? '' : ` after ${eventId}`;
    const list = violations.map(({ code, message }) => `${code}: ${message}`).join('; ');
    super(`TRUTH_INVARIANT_VIOLATION${after}: ${list}`);
    this.name = 'TruthInvariantError';
  }
}

interface Stay {
  readonly where: string;
  readonly interval: Interval;
  readonly eventId: EventId;
  readonly order: number;
}

/** A stay from an `at` fact, or a transition from a `move` event with one location target. */
interface Segment {
  readonly kind: 'stay' | 'move';
  readonly start: string;
  readonly end: string;
  readonly interval: Interval;
  readonly eventId: EventId;
  readonly order: number;
}

interface Holding {
  readonly who: string;
  readonly interval: Interval;
  readonly eventId: EventId;
  readonly order: number;
}

interface Death {
  readonly minute: GameMinutes;
  readonly eventId: EventId;
}

interface Context {
  readonly world: InvariantWorld;
  readonly events: readonly TruthEvent[];
  readonly byId: ReadonlyMap<EventId, TruthEvent>;
  readonly incremental: boolean;
  readonly newestId: EventId;
  readonly stays: ReadonlyMap<string, readonly Stay[]>;
  readonly segments: ReadonlyMap<string, readonly Segment[]>;
  readonly holdings: ReadonlyMap<string, readonly Holding[]>;
  readonly deaths: ReadonlyMap<string, Death>;
  /** Items the truth refers to that exist in the registry, sorted by id. */
  readonly registeredItems: readonly string[];
  /** Each registered item with every container it is ever in, directly or transitively. */
  readonly chains: ReadonlyMap<string, readonly string[]>;
  readonly violations: InvariantViolation[];
}

function report(
  ctx: Context,
  code: InvariantViolationCode,
  eventIds: readonly EventId[],
  message: string,
  details: { subject?: EntityRef; minute?: GameMinutes } = {},
): void {
  ctx.violations.push({ invariant: INVARIANT_OF[code], code, eventIds, ...details, message });
}

const character = (id: string): EntityRef => ({ kind: 'character', id });
const item = (id: string): EntityRef => ({ kind: 'item', id });

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function byIntervalThenOrder(
  a: { interval: Interval; order: number },
  b: { interval: Interval; order: number },
): number {
  return a.interval.from - b.interval.from || a.interval.to - b.interval.to || a.order - b.order;
}

function sortedEntries<V>(map: ReadonlyMap<string, V>): [string, V][] {
  return [...map].sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
}

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/** Minutes an event occupies; an instantaneous event still happens during its starting minute. */
function span(event: TruthEvent): Interval {
  return { from: event.t, to: event.t + Math.max(event.duration, 1) };
}

/**
 * Death is the state `alive = false` of a character entity, starting at `interval.from`.
 * Death is irreversible, so the end of that interval does not bring the character back.
 */
function deathOf(fact: TruthEvent['facts'][number]): { who: string; minute: GameMinutes } | null {
  if (
    fact.kind !== 'state' ||
    fact.entity.kind !== 'character' ||
    fact.property !== 'alive' ||
    fact.value !== false
  ) {
    return null;
  }
  return { who: fact.entity.id, minute: fact.interval.from };
}

function eventNumber(id: string): number {
  return /^ev_[1-9][0-9]*$/.test(id) ? Number(id.slice(3)) : Number.NaN;
}

/** Event ids are sequential, so an id beyond the end of a growing log can still be appended. */
function pending(ctx: Context, id: string): boolean {
  return ctx.incremental && eventNumber(id) > ctx.events.length;
}

function isRegistered(items: InvariantWorld['items'], id: string): boolean {
  try {
    items.history(id);
    return true;
  } catch (error) {
    if (error instanceof ItemError && error.code === 'WORLD_UNKNOWN_ITEM') return false;
    throw error;
  }
}

/** The registry starts at its own minute and has no placement before it. */
function covered(items: InvariantWorld['items'], id: string, minute: GameMinutes): boolean {
  try {
    items.locate(id, minute);
    return true;
  } catch (error) {
    if (error instanceof ItemError && error.code === 'WORLD_INVALID_ITEM_TIME') return false;
    throw error;
  }
}

function firstCoveredMinute(
  items: InvariantWorld['items'],
  id: string,
  { from, to }: Interval,
): GameMinutes | undefined {
  if (covered(items, id, from)) return from;
  let low = from;
  let high = to - 1;
  if (!covered(items, id, high)) return undefined;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (covered(items, id, middle)) high = middle;
    else low = middle;
  }
  return high;
}

/** The location or character that ultimately holds an item, looking through containers. */
function rootPlacement(
  items: InvariantWorld['items'],
  id: string,
  minute: GameMinutes,
): ItemPlacement {
  const visited = new Set([id]);
  let placement = items.locate(id, minute);
  // The registry rejects container cycles; the guard only keeps a faulty registry from hanging us.
  while (placement.kind === 'container' && !visited.has(placement.id)) {
    visited.add(placement.id);
    placement = items.locate(placement.id, minute);
  }
  return placement;
}

// Far beyond any scenario, yet small enough for exact integer midpoints.
const EARLIEST_MINUTE = -(2 ** 52);
const LATEST_MINUTE = 2 ** 52;

/**
 * The item and every container it is ever inside, directly or transitively, from the start of
 * the registry on. The registry does not list its items, so the walk starts from known ids.
 */
function containmentChain(
  items: InvariantWorld['items'],
  id: string,
  registryStart: GameMinutes,
): string[] {
  const chain = new Set([id]);
  for (const current of chain) {
    const placements = [
      items.locate(current, registryStart),
      ...items.history(current).map(({ to }) => to),
    ];
    for (const placement of placements) {
      if (placement.kind === 'container') chain.add(placement.id);
    }
  }
  return [...chain];
}

/** Minutes in `window` at which the root placement of an item may change, in order. */
function placementChanges(ctx: Context, itemId: string, window: Interval): GameMinutes[] {
  const start = firstCoveredMinute(ctx.world.items, itemId, window);
  if (start === undefined) return [];
  const minutes = new Set([start]);
  for (const id of ctx.chains.get(itemId) ?? [itemId]) {
    for (const { t } of ctx.world.items.history(id)) {
      if (t > start && t < window.to) minutes.add(t);
    }
  }
  return [...minutes].sort((a, b) => a - b);
}

function collect(truth: TruthModel, world: InvariantWorld, incremental: boolean): Context {
  const events = truth.events();
  const byId = new Map(events.map((event) => [event.id, event]));
  const stays = new Map<string, Stay[]>();
  const segments = new Map<string, Segment[]>();
  const holdings = new Map<string, Holding[]>();
  const deaths = new Map<string, Death>();
  const referencedItems = new Set<string>();
  let order = 0;

  for (const event of events) {
    for (const target of event.targets) {
      if (target.kind === 'item') referencedItems.add(target.id);
    }
    const destinations = event.targets.filter(({ kind }) => kind === 'location');
    // A move names its origin as the location and its destination as the only location target
    // (SIM-001). Moves without one destination describe the trip by `at` facts only.
    if (event.verb === 'move' && destinations.length === 1) {
      order += 1;
      const interval = { from: event.t, to: event.t + event.duration };
      for (const actor of unique(event.actorIds)) {
        push(segments, actor, {
          kind: 'move',
          start: event.location,
          end: destinations[0]!.id,
          interval,
          eventId: event.id,
          order,
        });
      }
    }
    for (const fact of event.facts) {
      order += 1;
      if (fact.kind === 'at') {
        const stay = { where: fact.where, interval: fact.interval, eventId: event.id, order };
        push(stays, fact.who, stay);
        push(segments, fact.who, { kind: 'stay', start: fact.where, end: fact.where, ...stay });
      } else if (fact.kind === 'possessed') {
        referencedItems.add(fact.item);
        push(holdings, fact.item, {
          who: fact.who,
          interval: fact.interval,
          eventId: event.id,
          order,
        });
      } else if (fact.kind === 'did' && fact.target?.kind === 'item') {
        referencedItems.add(fact.target.id);
      }
      const death = deathOf(fact);
      const known = death && deaths.get(death.who);
      if (death && (!known || death.minute < known.minute)) {
        deaths.set(death.who, { minute: death.minute, eventId: event.id });
      }
    }
  }
  for (const list of [...stays.values(), ...segments.values(), ...holdings.values()]) {
    list.sort(byIntervalThenOrder);
  }

  const registeredItems = [...referencedItems].filter((id) => isRegistered(world.items, id)).sort();
  const chains = new Map<string, string[]>();
  const [anyItem] = registeredItems;
  // All items share the start minute of the registry.
  const registryStart =
    anyItem === undefined
      ? undefined
      : firstCoveredMinute(world.items, anyItem, { from: EARLIEST_MINUTE, to: LATEST_MINUTE });
  if (registryStart !== undefined) {
    for (const id of registeredItems) {
      chains.set(id, containmentChain(world.items, id, registryStart));
    }
  }

  return {
    world,
    events,
    byId,
    incremental,
    newestId: `ev_${events.length}`,
    stays,
    segments,
    holdings,
    deaths,
    registeredItems,
    chains,
    violations: [],
  };
}

/** Invariant 1: one location at a time; event actors are where the event happens. */
function checkSinglePresence(ctx: Context): void {
  for (const [who, stays] of sortedEntries(ctx.stays)) {
    for (const [index, first] of stays.entries()) {
      // Stays are sorted by start, so only the following ones that start before `first` ends overlap.
      for (const second of stays.slice(index + 1)) {
        if (second.interval.from >= first.interval.to) break;
        if (second.where === first.where) continue;
        report(
          ctx,
          'PRESENCE_OVERLAP',
          [second.eventId, first.eventId],
          `${who} is at ${first.where} and ${second.where} at minute ${second.interval.from}`,
          { subject: character(who), minute: second.interval.from },
        );
      }
    }
  }

  for (const [who, segments] of sortedEntries(ctx.segments)) {
    for (const [index, first] of segments.entries()) {
      for (const second of segments.slice(index + 1)) {
        if (second.interval.from >= first.interval.to) break;
        // Two stays are invariant 1 above; a transition must not overlap anything.
        if (first.kind === 'stay' && second.kind === 'stay') continue;
        if (!overlaps(first.interval, second.interval)) continue;
        report(
          ctx,
          'TRANSIT_OVERLAP',
          [second.eventId, first.eventId],
          `${who} is in transit and somewhere else at minute ${second.interval.from}`,
          { subject: character(who), minute: second.interval.from },
        );
      }
    }
  }

  for (const event of ctx.events) {
    const reported = new Set<string>();
    const elsewhere = (who: string, where: string, occupied: Interval): void => {
      if (reported.has(who)) return;
      const stay = ctx.stays
        .get(who)
        ?.find((entry) => entry.where !== where && overlaps(entry.interval, occupied));
      if (!stay) return;
      reported.add(who);
      const minute = Math.max(occupied.from, stay.interval.from);
      report(
        ctx,
        'ACTOR_ELSEWHERE',
        [event.id, stay.eventId],
        `${who} acts at ${where} while at ${stay.where} at minute ${minute}`,
        { subject: character(who), minute },
      );
    };

    // A move is in transit, checked above and under invariant 2.
    if (event.verb !== 'move') {
      for (const actor of unique(event.actorIds)) elsewhere(actor, event.location, span(event));
    }
    for (const fact of event.facts) {
      if (fact.kind === 'did' && fact.verb !== 'move') {
        elsewhere(fact.who, fact.where, { from: fact.at, to: fact.at + 1 });
      }
    }
  }
}

/**
 * Physical keys a character carries when departing (ADR 0016): items the registry places with
 * the character in that minute, directly or in containers the character holds. Moves recorded
 * in that minute count; a key received on the way or on arrival does not open a door already
 * passed. Possession facts are not a source of ownership, and the registry only knows items the
 * truth refers to, such as the item target of a `move`.
 */
function carriedItems(ctx: Context, who: string, departure: GameMinutes): Set<string> {
  const carried = new Set<string>();
  for (const itemId of ctx.registeredItems) {
    if (!covered(ctx.world.items, itemId, departure)) continue;
    const root = rootPlacement(ctx.world.items, itemId, departure);
    if (root.kind === 'character' && root.id === who) carried.add(itemId);
  }
  return carried;
}

interface Trip {
  readonly who: string;
  readonly origin: string;
  readonly destination: string;
  readonly departure: GameMinutes;
  readonly arrival: GameMinutes;
  readonly eventIds: readonly EventId[];
  /** The start of the first event in `eventIds`. */
  readonly minute: GameMinutes;
}

function checkTrip(ctx: Context, trip: Trip): void {
  const { who, origin, destination, departure, arrival, eventIds, minute } = trip;
  const available = arrival - departure;
  const actor: Actor = { itemIds: carriedItems(ctx, who, departure) };
  const details = { subject: character(who), minute };
  let minutes: number | null;
  try {
    minutes = ctx.world.locations.travelTime(origin, destination, actor);
  } catch (error) {
    if (!(error instanceof WorldError && error.code === 'WORLD_UNKNOWN_LOCATION')) throw error;
    report(
      ctx,
      'TRAVEL_UNKNOWN_LOCATION',
      eventIds,
      `${who} travels between ${origin} and ${destination}, which are not both in the world`,
      details,
    );
    return;
  }

  if (minutes === null) {
    report(
      ctx,
      'TRAVEL_NO_ROUTE',
      eventIds,
      `${who} reaches ${destination} from ${origin} without a route`,
      details,
    );
  } else if (minutes > available) {
    report(
      ctx,
      'TRAVEL_TOO_FAST',
      eventIds,
      `${who} travels from ${origin} to ${destination} in ${available} min, the route takes ${minutes} min`,
      details,
    );
  }
}

/**
 * Invariant 2: every recorded transition takes at least the route time, and consecutive stays
 * and transitions connect: the next one starts where the previous one ended, after the route time.
 */
function checkTravel(ctx: Context): void {
  for (const [who, segments] of sortedEntries(ctx.segments)) {
    let previous: Segment | undefined;
    for (const segment of segments) {
      const { interval } = segment;
      if (previous && previous.interval.to > interval.from) {
        // Overlaps belong to invariant 1; keep the segment that ends last as the origin.
        if (interval.to > previous.interval.to) previous = segment;
      } else {
        if (previous && previous.end !== segment.start) {
          checkTrip(ctx, {
            who,
            origin: previous.end,
            destination: segment.start,
            departure: previous.interval.to,
            arrival: interval.from,
            eventIds: [segment.eventId, previous.eventId],
            minute: interval.from,
          });
        }
        previous = segment;
      }
      if (segment.kind === 'move' && segment.start !== segment.end) {
        checkTrip(ctx, {
          who,
          origin: segment.start,
          destination: segment.end,
          departure: interval.from,
          arrival: interval.to,
          eventIds: [segment.eventId],
          minute: interval.from,
        });
      }
    }
  }
}

/**
 * Timing makes a cause chain strictly ordered unless every link is instantaneous and happens in
 * the same minute, so only such links can close a cycle.
 */
function reportCycles(ctx: Context, links: ReadonlyMap<EventId, readonly EventId[]>): void {
  const state = new Map<EventId, 'active' | 'done'>();
  const seen = new Set<string>();
  for (const root of links.keys()) {
    if (state.has(root)) continue;
    const path: EventId[] = [root];
    const next: number[] = [0];
    state.set(root, 'active');
    while (path.length > 0) {
      const current = path.at(-1)!;
      const index = next.at(-1)!;
      const causes = links.get(current) ?? [];
      if (index === causes.length) {
        state.set(current, 'done');
        path.pop();
        next.pop();
        continue;
      }
      next[next.length - 1] = index + 1;
      const cause = causes[index]!;
      if (state.get(cause) === 'active') {
        const cycle = path.slice(path.indexOf(cause));
        const key = [...cycle].sort().join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const start = cycle.indexOf(
          cycle.reduce((a, b) => (eventNumber(a) <= eventNumber(b) ? a : b)),
        );
        const ordered = [...cycle.slice(start), ...cycle.slice(0, start)];
        report(ctx, 'CAUSE_CYCLE', ordered, `Events cause each other: ${ordered.join(' <- ')}`, {
          minute: ctx.byId.get(cause)!.t,
        });
      } else if (!state.has(cause)) {
        state.set(cause, 'active');
        path.push(cause);
        next.push(0);
      }
    }
  }
}

/** Invariant 3: causes exist and end no later than their effects start; item moves follow causes. */
function checkCausality(ctx: Context): void {
  const instantLinks = new Map<EventId, EventId[]>();
  for (const event of ctx.events) {
    for (const causeId of unique(event.causes)) {
      if (causeId === event.id) {
        report(ctx, 'CAUSE_SELF', [event.id], `${event.id} lists itself as a cause`, {
          minute: event.t,
        });
        continue;
      }
      const cause = ctx.byId.get(causeId);
      if (!cause) {
        if (!pending(ctx, causeId)) {
          report(
            ctx,
            'CAUSE_UNKNOWN',
            [event.id],
            `${event.id} refers to unknown cause ${causeId}`,
            {
              minute: event.t,
            },
          );
        }
        continue;
      }
      const end = cause.t + cause.duration;
      if (end > event.t) {
        report(
          ctx,
          'CAUSE_NOT_BEFORE_EFFECT',
          [event.id, cause.id],
          `${cause.id} ends at minute ${end}, after its effect ${event.id} starts at minute ${event.t}`,
          { minute: event.t },
        );
      } else if (cause.duration === 0 && cause.t === event.t) {
        push(instantLinks, event.id, cause.id);
      }
    }
  }
  reportCycles(ctx, instantLinks);

  // Containers carry the items inside them, so their moves need valid causes too.
  const moved = [...new Set([...ctx.chains.values()].flat())].sort();
  for (const itemId of moved) {
    for (const move of ctx.world.items.history(itemId)) {
      const cause = ctx.byId.get(move.cause);
      if (!cause) {
        if (!pending(ctx, move.cause)) {
          report(
            ctx,
            'ITEM_MOVE_UNKNOWN_CAUSE',
            [],
            `${itemId} moves at minute ${move.t} because of unknown event ${move.cause}`,
            { subject: item(itemId), minute: move.t },
          );
        }
      } else if (move.t < cause.t) {
        report(
          ctx,
          'ITEM_MOVE_BEFORE_CAUSE',
          [cause.id],
          `${itemId} moves at minute ${move.t}, before its cause ${cause.id} at minute ${cause.t}`,
          { subject: item(itemId), minute: move.t },
        );
      }
    }
  }
}

function firstPlacementConflict(
  ctx: Context,
  itemId: string,
  holding: Holding,
): { minute: GameMinutes; placement: ItemPlacement } | undefined {
  // The root placement can only change when the item or one of its containers moves.
  for (const minute of placementChanges(ctx, itemId, holding.interval)) {
    const placement = rootPlacement(ctx.world.items, itemId, minute);
    if (placement.kind !== 'character' || placement.id !== holding.who) {
      return { minute, placement };
    }
  }
  return undefined;
}

/** Invariant 4: one holder at a time, and the registry agrees with every possession. */
function checkItems(ctx: Context): void {
  for (const [itemId, holdings] of sortedEntries(ctx.holdings)) {
    for (const [index, first] of holdings.entries()) {
      for (const second of holdings.slice(index + 1)) {
        if (second.interval.from >= first.interval.to) break;
        if (second.who === first.who) continue;
        report(
          ctx,
          'ITEM_HOLDER_OVERLAP',
          [second.eventId, first.eventId],
          `${itemId} is held by ${first.who} and ${second.who} at minute ${second.interval.from}`,
          { subject: item(itemId), minute: second.interval.from },
        );
      }
    }

    if (!ctx.registeredItems.includes(itemId)) {
      report(
        ctx,
        'ITEM_UNKNOWN',
        [holdings[0]!.eventId],
        `${itemId} is possessed in the truth but missing from the item registry`,
        { subject: item(itemId) },
      );
      continue;
    }
    for (const holding of holdings) {
      if (ctx.incremental && holding.eventId === ctx.newestId) continue;
      const conflict = firstPlacementConflict(ctx, itemId, holding);
      if (!conflict) continue;
      const { minute, placement } = conflict;
      report(
        ctx,
        'ITEM_PLACEMENT_CONFLICT',
        [holding.eventId],
        `${itemId} is held by ${holding.who} in the truth but is at ${placement.kind} ${placement.id} in the registry at minute ${minute}`,
        { subject: item(itemId), minute },
      );
    }
  }
}

/** Invariant 5: nobody acts at or after the minute of their death. */
function checkDeaths(ctx: Context): void {
  for (const event of ctx.events) {
    const reported = new Set<string>();
    const check = (
      who: string,
      minute: GameMinutes,
      end: GameMinutes,
      what: string,
      asActor: boolean,
    ): void => {
      const death = ctx.deaths.get(who);
      if (!death || reported.has(who)) return;
      // The event that establishes a death may name the dying character as its actor, e.g. a
      // collapse, unless it starts after the death it records. Its did facts are checked as usual.
      if (asActor && death.eventId === event.id && event.t <= death.minute) return;
      if (minute >= death.minute) {
        reported.add(who);
        report(
          ctx,
          'ACTION_AFTER_DEATH',
          [event.id, death.eventId],
          `${who} ${what} at minute ${minute}, after dying at minute ${death.minute}`,
          { subject: character(who), minute },
        );
      } else if (end > death.minute) {
        reported.add(who);
        report(
          ctx,
          'ACTION_SPANS_DEATH',
          [event.id, death.eventId],
          `${who} ${what} until minute ${end}, after dying at minute ${death.minute}`,
          { subject: character(who), minute: death.minute },
        );
      }
    };

    for (const actor of unique(event.actorIds)) {
      check(actor, event.t, event.t + event.duration, `acts in ${event.id}`, true);
    }
    for (const fact of event.facts) {
      if (fact.kind === 'did') check(fact.who, fact.at, fact.at, `does ${fact.verb}`, false);
    }
  }
}

/** Invariant 7: key events exist and each has a culprit among its actors. */
function checkIncident(ctx: Context, truth: TruthModel): void {
  const { keyEventIds, culpritIds } = truth.incident;
  for (const id of unique(keyEventIds)) {
    const event = ctx.byId.get(id);
    if (!event) {
      if (!pending(ctx, id)) {
        report(ctx, 'KEY_EVENT_UNKNOWN', [id], `Incident key event ${id} is not in the log`);
      }
    } else if (!event.actorIds.some((actor) => culpritIds.includes(actor))) {
      report(
        ctx,
        'KEY_EVENT_WITHOUT_CULPRIT',
        [id],
        `Incident key event ${id} has no culprit among its actors`,
        { minute: event.t },
      );
    }
  }
}

/**
 * Checks invariants 1–5 and 7 of truth-model.md §4.
 *
 * Invariant 6 (public events are observed by everyone present) is not checked here: observations
 * live in knowledge stores, which the truth module must not depend on (modules.md), and
 * `(truth, world)` carries no record of them. SIM-002 checks it where observations are created;
 * a validator check is open question OQ-13. See truth-model.md §4.
 *
 * Violations are ordered by invariant, then by code in the order of truth-model.md §4, then by
 * traversal: characters and items by id and then by time, events in log order (minute, then
 * event number). Equal inputs give equal results.
 */
export function checkTruthInvariants(
  truth: TruthModel,
  world: InvariantWorld,
  options: InvariantCheckOptions = {},
): InvariantViolation[] {
  const ctx = collect(truth, world, options.incremental ?? false);
  checkSinglePresence(ctx);
  checkTravel(ctx);
  checkCausality(ctx);
  checkItems(ctx);
  checkDeaths(ctx);
  checkIncident(ctx, truth);
  // Stable sort: codes in declaration order, then the traversal order of each check.
  const codeOrder = Object.keys(INVARIANT_OF);
  return ctx.violations.toSorted(
    (a, b) => a.invariant - b.invariant || codeOrder.indexOf(a.code) - codeOrder.indexOf(b.code),
  );
}

/** Throws `TruthInvariantError` when `checkTruthInvariants` finds any violation. */
export function assertInvariants(
  truth: TruthModel,
  world: InvariantWorld,
  options: InvariantCheckOptions = {},
): void {
  const violations = checkTruthInvariants(truth, world, options);
  if (violations.length > 0) throw new TruthInvariantError(violations);
}

export interface TruthWriter {
  append(input: TruthEventInput): EventId;
}

export interface InvariantDebugOptions {
  /** Check the invariants after every append. The caller decides, e.g. from its debug config. */
  readonly enabled: boolean;
}

/**
 * Appends to `truth` and, when enabled, asserts the invariants of the growing log after each
 * append. A failing event stays in the append-only log; the error names it.
 */
export function withInvariantChecks(
  truth: TruthModel,
  world: InvariantWorld,
  debug: InvariantDebugOptions,
): TruthWriter {
  if (!debug.enabled) return { append: (input) => truth.append(input) };
  return {
    append(input) {
      const id = truth.append(input);
      const violations = checkTruthInvariants(truth, world, { incremental: true });
      if (violations.length > 0) throw new TruthInvariantError(violations, id);
      return id;
    },
  };
}
