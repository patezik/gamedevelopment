import { Calendar, type DayPeriod, type GameMinutes } from './calendar.ts';
import { Scheduler, type ScheduledEvent, type TickPhase } from './scheduler.ts';

export type ClockEvent =
  | { type: 'ClockAdvanced'; from: GameMinutes; to: GameMinutes }
  | { type: 'PeriodChanged'; at: GameMinutes; from: DayPeriod; to: DayPeriod }
  | { type: 'DayChanged'; at: GameMinutes; from: number; to: number };

type EventRequest = Omit<ScheduledEvent, 'id' | 'phase'>;

export interface TickContext {
  readonly now: GameMinutes;
  schedule(event: EventRequest): string;
  cancel(id: string): boolean;
}

export interface PhaseHandler {
  readonly phase: TickPhase;
  handle(event: ScheduledEvent, context: TickContext): void | { interrupt: string };
}

export interface AdvanceResult {
  from: GameMinutes;
  to: GameMinutes;
  processed: number;
  events: ClockEvent[];
  interruptedAt?: GameMinutes;
  interruptReason?: string;
  limit?: 'TIME_BEYOND_SCENARIO_END';
}

export class TimeSystem {
  readonly #calendar: Calendar;
  readonly #scenarioEnd: GameMinutes;
  readonly #scheduler: Scheduler;
  readonly #handlers = new Map<string, PhaseHandler>();
  #advancing = false;

  constructor(calendar: Calendar, scenarioEnd: GameMinutes, start: GameMinutes = 0) {
    if (!Number.isSafeInteger(scenarioEnd) || scenarioEnd < 0 || start > scenarioEnd) {
      throw new RangeError('Scenario end must be a non-negative integer at or after start');
    }
    this.#calendar = calendar;
    this.#scenarioEnd = scenarioEnd;
    this.#scheduler = new Scheduler(start);
  }

  now(): GameMinutes {
    return this.#scheduler.now;
  }

  registerHandler(kind: string, handler: PhaseHandler): void {
    if (!kind || this.#handlers.has(kind)) {
      throw new RangeError(`Invalid or already registered event kind: ${kind}`);
    }
    this.#handlers.set(kind, { phase: handler.phase, handle: handler.handle.bind(handler) });
  }

  schedule(event: EventRequest): string {
    const handler = this.#handlers.get(event.kind);
    if (!handler) throw new RangeError(`No handler registered for ${event.kind}`);
    return this.#scheduler.schedule({ ...event, phase: handler.phase });
  }

  cancel(id: string): boolean {
    return this.#scheduler.cancel(id);
  }

  advance(minutes: number, opts?: { interruptible: boolean }): AdvanceResult {
    if (minutes < 0) {
      throw Object.assign(new RangeError('Cannot advance time by negative minutes'), {
        code: 'TIME_NEGATIVE_ADVANCE' as const,
      });
    }
    if (!Number.isSafeInteger(minutes)) throw new RangeError('Minutes must be a safe integer');
    if (this.#advancing) throw new Error('Cannot advance time from an event handler');

    const from = this.now();
    const clamped = minutes > this.#scenarioEnd - from;
    const target = clamped ? this.#scenarioEnd : from + minutes;
    let processed = 0;
    let interruption: Pick<AdvanceResult, 'interruptedAt' | 'interruptReason'> = {};
    this.#advancing = true;
    try {
      for (
        let event = this.#scheduler.popNext(target);
        event;
        event = this.#scheduler.popNext(target)
      ) {
        const result = this.#handlers.get(event.kind)!.handle(event, {
          now: event.at,
          schedule: (request) => this.schedule(request),
          cancel: (id) => this.cancel(id),
        });
        processed++;
        if (opts?.interruptible && result) {
          interruption = { interruptedAt: event.at, interruptReason: result.interrupt };
          break;
        }
      }
      if (interruption.interruptedAt === undefined) this.#scheduler.popDue(target);
    } finally {
      this.#advancing = false;
    }

    const to = this.now();
    return {
      from,
      to,
      processed,
      events: this.#clockEvents(from, to),
      ...interruption,
      ...(clamped && to === target ? { limit: 'TIME_BEYOND_SCENARIO_END' as const } : {}),
    };
  }

  #clockEvents(from: GameMinutes, to: GameMinutes): ClockEvent[] {
    const events: ClockEvent[] = [{ type: 'ClockAdvanced', from, to }];
    let previous = this.#calendar.toDisplay(from);
    for (let at = from + 60 - previous.mm; at <= to; at += 60) {
      const next = this.#calendar.toDisplay(at);
      if (next.day !== previous.day) {
        events.push({ type: 'DayChanged', at, from: previous.day, to: next.day });
      }
      if (next.period !== previous.period) {
        events.push({ type: 'PeriodChanged', at, from: previous.period, to: next.period });
      }
      previous = next;
    }
    return events;
  }
}
