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
  readonly earlierIf?: { readonly staticAtLeast: number; readonly at: GameMinutes } | undefined;
  /** The event is missed when the player is not in `locationId` when it happens. */
  readonly requiresPresence?: { readonly locationId: string } | undefined;
  readonly onMissed?: MissedEffect | undefined;
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
  /** Applies an effect at the missed event's minute in the WorldEvents phase. */
  readonly applyMissedEffect: (effect: MissedEffect, at: GameMinutes) => void;
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

/**
 * What the module must remember to continue after a restore: which events already happened and
 * where the pending critical events stand (an `earlierIf` check may have moved one). The
 * scheduler itself is not saved. Lists are canonical (sorted by id, deadlines in config order).
 */
export interface ScenarioEventsSnapshot {
  /** Critical events already handled (fired or missed): never planned again. */
  readonly fired: readonly string[];
  /** Critical events whose `earlierIf` check already ran. */
  readonly checked: readonly string[];
  /** Critical events still ahead and the minute each is planned for. */
  readonly pending: readonly { readonly id: string; readonly at: GameMinutes }[];
  /** Deadlines already reached; the first of them in time is the outcome. */
  readonly reached: readonly string[];
}

/** Where a restored module resumes: the clock and, if it differs from the clock's story, the saved state. */
export interface ScenarioEventsResume {
  readonly now: GameMinutes;
  readonly saved?: ScenarioEventsSnapshot | undefined;
}

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
  readonly #deadlines = new Map<string, DeadlineConfig>();
  readonly #ports: ScenarioEventsPorts;
  readonly #time: TimeSystem;
  readonly #byId = new Map<string, CriticalEventConfig>();
  readonly #scheduled = new Map<string, string>();
  readonly #done = new Set<string>();
  readonly #checked = new Set<string>();
  readonly #planned = new Map<string, GameMinutes>();
  readonly #reached = new Set<string>();
  readonly #config: ScenarioEventsConfig;
  #log: ScenarioEvent[] = [];
  #outcome: string | undefined;

  constructor(
    time: TimeSystem,
    config: ScenarioEventsConfig,
    ports: ScenarioEventsPorts,
    resume?: ScenarioEventsResume,
  ) {
    this.#time = time;
    this.#config = config;
    this.#ports = ports;
    for (const event of config.criticalEvents) {
      if (this.#byId.has(event.id)) throw new RangeError(`Duplicate critical event: ${event.id}`);
      if (event.earlierIf && event.earlierIf.at >= event.at) {
        throw new RangeError(`earlierIf.at must be before at: ${event.id}`);
      }
      this.#byId.set(event.id, event);
    }
    for (const deadline of config.deadlines) {
      if (this.#deadlines.has(deadline.id)) {
        throw new RangeError(`Duplicate deadline: ${deadline.id}`);
      }
      this.#deadlines.set(deadline.id, deadline);
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
    const from = resume && (resume.saved ?? this.#derive(resume.now));
    const now = resume?.now ?? 0;
    if (from) {
      for (const id of from.fired) this.#done.add(id);
      for (const id of from.checked) this.#checked.add(id);
      for (const id of from.reached) this.#reached.add(id);
      for (const { id, at } of from.pending) this.#planned.set(id, at);
    }
    for (const event of config.criticalEvents) {
      if (this.#done.has(event.id)) continue;
      const planned = Math.max(now, this.#planned.get(event.id) ?? event.at);
      this.#planned.set(event.id, planned);
      this.#scheduled.set(event.id, this.#plan(CRITICAL, planned, 0, event.id));
      if (event.earlierIf && !this.#checked.has(event.id)) {
        this.#plan(CHECK, Math.max(now, event.earlierIf.at), -1, event.id);
      }
    }
    for (const deadline of config.deadlines) {
      if (!this.#reached.has(deadline.id)) {
        this.#plan(DEADLINE, Math.max(now, deadline.at), 0, deadline.id);
      }
    }
    this.#outcome = this.#firstOutcome();
  }

  /** The state a fresh clock at `now` implies: every event due by `now` handled, the rest as configured. */
  #derive(now: GameMinutes): ScenarioEventsSnapshot {
    const { criticalEvents, deadlines } = this.#config;
    return {
      fired: criticalEvents
        .filter(({ at }) => at <= now)
        .map(({ id }) => id)
        .sort(),
      checked: criticalEvents
        .filter(({ earlierIf }) => earlierIf && earlierIf.at <= now)
        .map(({ id }) => id)
        .sort(),
      pending: criticalEvents
        .filter(({ at }) => at > now)
        .map(({ id, at }) => ({ id, at }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      reached: deadlines.filter(({ at }) => at <= now).map(({ id }) => id),
    };
  }

  #firstOutcome(): string | undefined {
    return this.#config.deadlines
      .filter(({ id }) => this.#reached.has(id))
      .reduce<DeadlineConfig | undefined>(
        (best, candidate) => (best && best.at <= candidate.at ? best : candidate),
        undefined,
      )?.outcome;
  }

  /**
   * State to save, or `undefined` when it is exactly what the clock at `now` implies (nothing
   * moved, nothing interrupted): a restore derives it then, so the saved form stays unchanged.
   */
  snapshot(now: GameMinutes): ScenarioEventsSnapshot | undefined {
    const actual: ScenarioEventsSnapshot = {
      fired: [...this.#done].sort(),
      checked: [...this.#checked].sort(),
      pending: [...this.#planned]
        .filter(([id]) => !this.#done.has(id))
        .map(([id, at]) => ({ id, at }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      reached: this.#config.deadlines.filter(({ id }) => this.#reached.has(id)).map(({ id }) => id),
    };
    return JSON.stringify(actual) === JSON.stringify(this.#derive(now)) ? undefined : actual;
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
    this.#checked.add(id);
    if (this.#done.has(id) || this.#ports.staticLevel() < critical.earlierIf!.staticAtLeast) return;
    context.cancel(this.#scheduled.get(id)!);
    const now = context.now;
    this.#planned.set(id, now);
    this.#scheduled.set(
      id,
      context.schedule({ kind: CRITICAL, at: now, priority: 0, payload: { id } }),
    );
  }

  #fire(event: ScheduledEvent): { interrupt: string } | undefined {
    const { id } = event.payload as Payload;
    const critical = this.#byId.get(id)!;
    this.#done.add(id);
    this.#planned.delete(id);
    const presence = critical.requiresPresence;
    if (presence && !this.#ports.isPlayerPresent(presence.locationId)) {
      const { onMissed } = critical;
      this.#log.push({
        type: 'ScheduledEventMissed',
        id,
        at: event.at,
        ...(onMissed && { onMissed }),
      });
      if (onMissed) this.#ports.applyMissedEffect(onMissed, event.at);
      return undefined;
    }
    this.#log.push({ type: 'CriticalEventFired', id, at: event.at });
    return { interrupt: `critical:${id}` };
  }

  #reach(event: ScheduledEvent): void {
    const { id } = event.payload as Payload;
    const deadline = this.#deadlines.get(id)!;
    this.#reached.add(id);
    this.#outcome ??= deadline.outcome;
    this.#log.push({ type: 'DeadlineReached', id, at: event.at, outcome: deadline.outcome });
  }
}
