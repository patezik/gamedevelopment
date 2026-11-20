import { z } from 'zod';
import { canonicalJson, type GameMinutes } from '../common/index.ts';

/** Processing order inside one minute; docs/simulation/time-system.md section 2. */
export const TickPhase = {
  Calendar: 0,
  Schedules: 1,
  Simulation: 2,
  WorldEvents: 3,
  Availability: 4,
  Timers: 5,
  Outcome: 6,
} as const;
export type TickPhase = (typeof TickPhase)[keyof typeof TickPhase];

export interface ScheduledEvent<K extends string = string> {
  readonly id: string;
  readonly at: GameMinutes;
  readonly phase: TickPhase;
  /** Within one phase, lower runs first. */
  readonly priority: number;
  readonly kind: K;
  /** Kept by reference and written to snapshots: treat as immutable canonical JSON. */
  readonly payload: unknown;
}

export type SchedulerErrorCode = 'SCHEDULER_PAST_EVENT' | 'SCHEDULER_INVALID_STATE';

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

export interface SerializedEvent extends ScheduledEvent {
  /** Scheduling order, the final tie-breaker of the sort key. */
  readonly seq: number;
}

export interface SchedulerState {
  readonly now: GameMinutes;
  readonly nextSeq: number;
  /** Pending events in processing order. */
  readonly events: readonly SerializedEvent[];
}

const stateSchema = z.strictObject({
  now: z.int(),
  nextSeq: z.int().nonnegative(),
  events: z.array(
    z.strictObject({
      id: z.string(),
      seq: z.int().nonnegative(),
      at: z.int(),
      phase: z.int().min(TickPhase.Calendar).max(TickPhase.Outcome),
      priority: z.int(),
      kind: z.string().min(1),
      payload: z.json(),
    }),
  ),
});

interface Entry {
  readonly event: ScheduledEvent;
  readonly seq: number;
  cancelled: boolean;
}

/** Total order: `seq` is unique, so no two entries compare equal and heap shape never matters. */
function compare(a: Entry, b: Entry): number {
  return (
    a.event.at - b.event.at ||
    a.event.phase - b.event.phase ||
    a.event.priority - b.event.priority ||
    a.seq - b.seq
  );
}

function siftUp(heap: Entry[], start: number): void {
  const entry = heap[start];
  if (!entry) return;
  let i = start;
  while (i > 0) {
    const parentIndex = (i - 1) >> 1;
    const parent = heap[parentIndex] as Entry;
    if (compare(entry, parent) >= 0) break;
    heap[i] = parent;
    i = parentIndex;
  }
  heap[i] = entry;
}

function siftDown(heap: Entry[], start: number): void {
  const entry = heap[start];
  if (!entry) return;
  let i = start;
  for (;;) {
    const left = 2 * i + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    let childIndex = left;
    let child = heap[left] as Entry;
    const rightChild = heap[right];
    if (rightChild && compare(rightChild, child) < 0) {
      childIndex = right;
      child = rightChild;
    }
    if (compare(child, entry) >= 0) break;
    heap[i] = child;
    i = childIndex;
  }
  heap[i] = entry;
}

function heapify(heap: Entry[]): void {
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(heap, i);
}

function assertInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${String(value)}`);
  }
}

function assertPhase(value: unknown): asserts value is TickPhase {
  assertInteger(value, 'phase');
  if (value < TickPhase.Calendar || value > TickPhase.Outcome) {
    throw new RangeError(`phase must be a TickPhase from 0 to 6, got ${value}`);
  }
}

const eventId = (seq: number): string => `evt_${seq}`;

/** Cancelled entries stay in the heap until they surface; rebuild once they dominate it. */
const COMPACT_MIN_CANCELLED = 32;

/**
 * Deterministic event queue. Events are processed in `(at, phase, priority, seq)` order, so
 * simultaneous events always resolve the same way (time-system.md section 2).
 *
 * The queue is a binary min-heap: schedule and pop are O(log n), against O(n) element shifts per
 * insert for a sorted array. Cancellation is lazy (O(1) now, the entry is dropped when it reaches
 * the top).
 *
 * The scheduler tracks its own time: `now` is the `at` of the last popped event, or the `t` of the
 * last `popDue`. Scheduling before `now` is an error; scheduling at `now` is allowed.
 */
export class Scheduler {
  #heap: Entry[] = [];
  #live = new Map<string, Entry>();
  #nextSeq = 0;
  #now: GameMinutes;
  #cancelled = 0;

  /** @param now the scheduler's starting time; pass `historyStartMinutes` to schedule prehistory. */
  constructor(now: GameMinutes = 0) {
    assertInteger(now, 'now');
    this.#now = now;
  }

  get now(): GameMinutes {
    return this.#now;
  }

  /** Number of pending (not cancelled, not yet popped) events. */
  get size(): number {
    return this.#live.size;
  }

  /** Schedules an event and returns its id. Throws `SCHEDULER_PAST_EVENT` when `at < now`. */
  schedule(event: Omit<ScheduledEvent, 'id'>): string {
    const { at, phase, priority, kind, payload } = event;
    assertInteger(at, 'at');
    assertPhase(phase);
    assertInteger(priority, 'priority');
    if (typeof kind !== 'string' || kind === '')
      throw new RangeError('kind must be a non-empty string');
    if (at < this.#now) {
      throw new SchedulerError(
        'SCHEDULER_PAST_EVENT',
        `Cannot schedule "${kind}" at ${at}: scheduler time is already ${this.#now}`,
      );
    }

    const seq = this.#nextSeq++;
    const id = eventId(seq);
    const entry: Entry = {
      event: Object.freeze({ id, at, phase, priority, kind, payload }),
      seq,
      cancelled: false,
    };
    this.#heap.push(entry);
    siftUp(this.#heap, this.#heap.length - 1);
    this.#live.set(id, entry);
    return id;
  }

  /** Removes a pending event. Returns false if it is unknown, already popped or already cancelled. */
  cancel(id: string): boolean {
    const entry = this.#live.get(id);
    if (!entry) return false;
    this.#live.delete(id);
    entry.cancelled = true;
    this.#cancelled++;
    if (this.#cancelled >= COMPACT_MIN_CANCELLED && this.#cancelled * 2 > this.#heap.length) {
      this.#heap = this.#heap.filter((candidate) => !candidate.cancelled);
      this.#cancelled = 0;
      heapify(this.#heap);
    }
    return true;
  }

  /** The next event without removing it. */
  peek(): ScheduledEvent | undefined {
    this.#dropCancelledTop();
    return this.#heap[0]?.event;
  }

  /**
   * Removes and returns the single next event if it is due (`at <= until`), moving `now` to its `at`.
   *
   * Use this in a loop to run handlers: a handler may schedule events at or after `now`, and they
   * are ordered against everything still pending. `popDue` cannot do that, because it returns its
   * whole batch before any handler runs.
   */
  popNext(until: GameMinutes): ScheduledEvent | undefined {
    assertInteger(until, 'until');
    this.#dropCancelledTop();
    const top = this.#heap[0];
    if (!top || top.event.at > until) return undefined;
    this.#popTop();
    this.#live.delete(top.event.id);
    this.#now = Math.max(this.#now, top.event.at);
    return top.event;
  }

  /** Removes and returns every event with `at <= t` in processing order, then moves `now` to `t`. */
  popDue(t: GameMinutes): ScheduledEvent[] {
    const due: ScheduledEvent[] = [];
    for (let event = this.popNext(t); event; event = this.popNext(t)) due.push(event);
    this.#now = Math.max(this.#now, t);
    return due;
  }

  /**
   * Detached, JSON-pure snapshot including the `seq` counter. Throws if a payload is not canonical
   * JSON (`undefined`, `NaN`, ...), so a bad payload fails at save time, not at replay.
   */
  serialize(): SchedulerState {
    const events = [...this.#live.values()].sort(compare).map(({ event, seq }) => ({
      id: event.id,
      seq,
      at: event.at,
      phase: event.phase,
      priority: event.priority,
      kind: event.kind,
      payload: event.payload,
    }));
    return JSON.parse(
      canonicalJson({ now: this.#now, nextSeq: this.#nextSeq, events }),
    ) as SchedulerState;
  }

  /** Rebuilds a scheduler from `serialize()` output. Throws `SCHEDULER_INVALID_STATE` on corrupt input. */
  static restore(state: unknown): Scheduler {
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) {
      throw new SchedulerError(
        'SCHEDULER_INVALID_STATE',
        parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; '),
      );
    }

    const { now, nextSeq, events } = parsed.data;
    const scheduler = new Scheduler(now);
    scheduler.#nextSeq = nextSeq;
    for (const { id, seq, at, phase, priority, kind, payload } of events) {
      const problem =
        id !== eventId(seq)
          ? `id ${id} does not match seq ${seq}`
          : seq >= nextSeq
            ? `seq ${seq} is not below nextSeq ${nextSeq}`
            : at < now
              ? `event ${id} is at ${at}, before now ${now}`
              : scheduler.#live.has(id)
                ? `duplicate event ${id}`
                : undefined;
      if (problem) throw new SchedulerError('SCHEDULER_INVALID_STATE', problem);

      const entry: Entry = {
        event: Object.freeze({ id, at, phase: phase as TickPhase, priority, kind, payload }),
        seq,
        cancelled: false,
      };
      scheduler.#heap.push(entry);
      scheduler.#live.set(id, entry);
    }
    heapify(scheduler.#heap);
    return scheduler;
  }

  #popTop(): void {
    const last = this.#heap.pop();
    if (last && this.#heap.length > 0) {
      this.#heap[0] = last;
      siftDown(this.#heap, 0);
    }
  }

  #dropCancelledTop(): void {
    while (this.#heap[0]?.cancelled) {
      this.#popTop();
      this.#cancelled--;
    }
  }
}
