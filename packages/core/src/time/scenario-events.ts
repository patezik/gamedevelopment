import type { GameMinutes } from './calendar.ts';
import { TickPhase, type ScheduledEvent } from './scheduler.ts';
import type { TickContext, TimeSystem } from './time-system.ts';

/** What a missed critical event changes in the world (time-system.md section 6). */
export type MissedEffect =
  | { readonly kind: 'static'; readonly delta: number }
  | { readonly kind: 'incident'; readonly incidentId: string }
  | { readonly kind: 'closeLocation'; readonly locationId: string };

export interface CriticalEventConfig {
  readonly id: string;
  readonly at: GameMinutes;
  /** At minute `earlierIf.at` the event is pulled forward to that minute if Static is high enough. */
  readonly earlierIf?: { readonly staticAtLeast: number; readonly at: GameMinutes };
  /** The event is missed when the player is not in `locationId` when it happens. */
  readonly requiresPresence?: { readonly locationId: string };
  readonly onMissed?: MissedEffect;
}

export interface DeadlineConfig {
  readonly id: string;
  readonly at: GameMinutes;
  readonly outcome: string;
}

export interface ScenarioEventsConfig {
  readonly criticalEvents: readonly CriticalEventConfig[];
  readonly deadlines: readonly DeadlineConfig[];
}

export interface ScenarioEventsPorts {
  /** Current Static level; SURV-002 supplies it. */
  readonly staticLevel: () => number;
  /** Whether the player is in `locationId` at the moment the event happens. */
  readonly isPlayerPresent: (locationId: string) => boolean;
}

export type ScenarioEvent =
  | { readonly type: 'CriticalEventFired'; readonly id: string; readonly at: GameMinutes }
  | {
      readonly type: 'ScheduledEventMissed';
      readonly id: string;
      readonly at: GameMinutes;
      readonly onMissed?: MissedEffect;
    }
  | {
      readonly type: 'DeadlineReached';
      readonly id: string;
      readonly at: GameMinutes;
      readonly outcome: string;
    };

interface Payload {
  readonly id: string;
}

const CRITICAL = 'scenario.critical';
const CHECK = 'scenario.earlierCheck';
const DEADLINE = 'scenario.deadline';

/**
 * Loads the preset's critical events and deadlines into the `TimeSystem` scheduler and records
 * what happened. Time moves only through `TimeSystem.advance`; this class only handles events.
 */
export class ScenarioEvents {
  readonly #deadlines: readonly DeadlineConfig[];
  readonly #ports: ScenarioEventsPorts;
  readonly #time: TimeSystem;
  readonly #byId = new Map<string, CriticalEventConfig>();
  readonly #scheduled = new Map<string, string>();
  readonly #done = new Set<string>();
  #log: ScenarioEvent[] = [];
  #outcome: string | undefined;

  constructor(time: TimeSystem, config: ScenarioEventsConfig, ports: ScenarioEventsPorts) {
    this.#time = time;
    this.#deadlines = config.deadlines;
    this.#ports = ports;
    for (const event of config.criticalEvents) {
      if (this.#byId.has(event.id)) throw new RangeError(`Duplicate critical event: ${event.id}`);
      if (event.earlierIf && event.earlierIf.at >= event.at) {
        throw new RangeError(`earlierIf.at must be before at: ${event.id}`);
      }
      this.#byId.set(event.id, event);
    }
    time.registerHandler(CRITICAL, {
      phase: TickPhase.WorldEvents,
      handle: (event) => this.#fire(event),
    });
    time.registerHandler(CHECK, {
      phase: TickPhase.WorldEvents,
      handle: (event, context) => this.#checkEarlier(event, context),
    });
    time.registerHandler(DEADLINE, {
      phase: TickPhase.Outcome,
      handle: (event) => this.#reach(event),
    });
    for (const event of config.criticalEvents) {
      this.#scheduled.set(event.id, this.#plan(CRITICAL, event.at, 0, event.id));
      if (event.earlierIf) this.#plan(CHECK, event.earlierIf.at, -1, event.id);
    }
    for (const deadline of config.deadlines) this.#plan(DEADLINE, deadline.at, 0, deadline.id);
  }

  /** The outcome of the first deadline reached, e.g. `time_up`; `undefined` while none was. */
  outcome(): string | undefined {
    return this.#outcome;
  }

  /** Returns and clears the events recorded since the last call, in the order they happened. */
  drain(): ScenarioEvent[] {
    const events = this.#log;
    this.#log = [];
    return events;
  }

  #plan(kind: string, at: GameMinutes, priority: number, id: string): string {
    return this.#time.schedule({ kind, at, priority, payload: { id } });
  }

  #checkEarlier(event: ScheduledEvent, context: TickContext): void {
    const { id } = event.payload as Payload;
    const critical = this.#byId.get(id)!;
    if (this.#done.has(id) || this.#ports.staticLevel() < critical.earlierIf!.staticAtLeast) return;
    context.cancel(this.#scheduled.get(id)!);
    const now = context.now;
    this.#scheduled.set(
      id,
      context.schedule({ kind: CRITICAL, at: now, priority: 0, payload: { id } }),
    );
  }

  #fire(event: ScheduledEvent): { interrupt: string } | undefined {
    const { id } = event.payload as Payload;
    const critical = this.#byId.get(id)!;
    this.#done.add(id);
    const presence = critical.requiresPresence;
    if (presence && !this.#ports.isPlayerPresent(presence.locationId)) {
      this.#log.push({
        type: 'ScheduledEventMissed',
        id,
        at: event.at,
        ...(critical.onMissed && { onMissed: critical.onMissed }),
      });
      return undefined;
    }
    this.#log.push({ type: 'CriticalEventFired', id, at: event.at });
    return { interrupt: `critical:${id}` };
  }

  #reach(event: ScheduledEvent): void {
    const { id } = event.payload as Payload;
    const deadline = this.#deadlines.find((candidate) => candidate.id === id)!;
    this.#outcome ??= deadline.outcome;
    this.#log.push({ type: 'DeadlineReached', id, at: event.at, outcome: deadline.outcome });
  }
}
