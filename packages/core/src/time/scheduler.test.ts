import { describe, expect, it } from 'vitest';
import { stateHash } from '../common/index.ts';
import { Scheduler, SchedulerError, TickPhase, type ScheduledEvent } from './scheduler.ts';

type Spec = Omit<ScheduledEvent, 'id'>;
const ev = (
  at: number,
  phase: TickPhase = TickPhase.Simulation,
  priority = 0,
  kind = 'e',
): Spec => ({
  at,
  phase,
  priority,
  kind,
  payload: null,
});

const drain = (scheduler: Scheduler, until = Number.MAX_SAFE_INTEGER): string[] =>
  scheduler.popDue(until).map((e) => e.id);

describe('ordering', () => {
  it('sorts by at, then phase, then priority, then scheduling order', () => {
    const s = new Scheduler();
    const ids = {
      lateTimer: s.schedule(ev(10, TickPhase.Timers)),
      earlyAt: s.schedule(ev(5, TickPhase.Outcome)),
      lowPriority: s.schedule(ev(10, TickPhase.Simulation, 1)),
      highPriority: s.schedule(ev(10, TickPhase.Simulation, -1)),
      firstTie: s.schedule(ev(10, TickPhase.Simulation, 0)),
      secondTie: s.schedule(ev(10, TickPhase.Simulation, 0)),
      calendar: s.schedule(ev(10, TickPhase.Calendar, 9)),
    };

    expect(drain(s)).toEqual([
      ids.earlyAt, // at 5 beats everything at 10, whatever its phase
      ids.calendar, // phase beats priority
      ids.highPriority,
      ids.firstTie, // equal key: scheduling order
      ids.secondTie,
      ids.lowPriority,
      ids.lateTimer,
    ]);
  });

  it('orders every phase as listed in time-system.md', () => {
    const s = new Scheduler();
    const phases = Object.values(TickPhase);
    for (const phase of [...phases].reverse()) s.schedule(ev(0, phase, 0, String(phase)));
    expect(s.popDue(0).map((e) => e.phase)).toEqual(phases);
  });

  it('is identical for identical input', () => {
    const build = () => {
      const s = new Scheduler();
      for (const [at, phase] of [
        [3, 2],
        [1, 5],
        [3, 0],
        [1, 5],
        [2, 2],
      ] as const)
        s.schedule(ev(at, phase));
      return s.popDue(10);
    };
    expect(build()).toEqual(build());
  });
});

describe('schedule', () => {
  it('returns unique, deterministic ids', () => {
    const run = () => {
      const s = new Scheduler();
      return [s.schedule(ev(1)), s.schedule(ev(1)), s.schedule(ev(1))];
    };
    expect(new Set(run()).size).toBe(3);
    expect(run()).toEqual(run());
  });

  it('stores a frozen copy, so callers cannot reorder the queue afterwards', () => {
    const s = new Scheduler();
    const spec = ev(5);
    s.schedule(spec);
    (spec as { at: number }).at = 0;
    const [event] = s.popDue(5);
    expect(event?.at).toBe(5);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it.each([
    ['fractional at', { ...ev(1), at: 1.5 }],
    ['NaN at', { ...ev(1), at: Number.NaN }],
    ['unsafe at', { ...ev(1), at: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional priority', { ...ev(1), priority: 0.5 }],
    ['phase out of range', { ...ev(1), phase: 7 as TickPhase }],
    ['negative phase', { ...ev(1), phase: -1 as TickPhase }],
    ['empty kind', { ...ev(1), kind: '' }],
  ])('rejects %s', (_name, spec) => {
    expect(() => new Scheduler().schedule(spec)).toThrow(RangeError);
  });
});

describe('SCHEDULER_PAST_EVENT', () => {
  it('rejects events before the scheduler time, allows events at it', () => {
    const s = new Scheduler();
    s.popDue(100);
    expect(() => s.schedule(ev(99))).toThrow(SchedulerError);
    expect(() => s.schedule(ev(99))).toThrow(
      expect.objectContaining({ code: 'SCHEDULER_PAST_EVENT' }),
    );
    expect(() => s.schedule(ev(100))).not.toThrow();
  });

  it('time follows popped events: scheduling in the past of a handler fails', () => {
    const s = new Scheduler();
    s.schedule(ev(40));
    s.popNext(100);
    expect(s.now).toBe(40);
    expect(() => s.schedule(ev(39))).toThrow(SchedulerError);
  });

  it('accepts prehistory when started in the past', () => {
    const s = new Scheduler(-1440);
    expect(() => s.schedule(ev(-1000))).not.toThrow();
    expect(() => new Scheduler().schedule(ev(-1))).toThrow(SchedulerError);
  });
});

describe('cancel', () => {
  it('removes the event; a second cancel returns false', () => {
    const s = new Scheduler();
    const keep = s.schedule(ev(1));
    const drop = s.schedule(ev(1));
    expect(s.cancel(drop)).toBe(true);
    expect(s.cancel(drop)).toBe(false);
    expect(s.size).toBe(1);
    expect(drain(s)).toEqual([keep]);
  });

  it('returns false for unknown ids and for events that already fired', () => {
    const s = new Scheduler();
    const id = s.schedule(ev(1));
    expect(s.cancel('evt_999')).toBe(false);
    s.popDue(1);
    expect(s.cancel(id)).toBe(false);
  });

  it('keeps order after heavy cancellation (heap compaction)', () => {
    const s = new Scheduler();
    const ids = Array.from({ length: 500 }, (_, i) => s.schedule(ev(500 - i)));
    const kept: string[] = [];
    ids.forEach((id, i) => {
      if (i % 5 === 0) kept.push(id);
      else s.cancel(id);
    });
    expect(s.size).toBe(100);
    expect(drain(s)).toEqual(kept.reverse()); // scheduled with decreasing `at`
  });
});

describe('peek, popNext, popDue', () => {
  it('peek does not remove and skips cancelled events', () => {
    const s = new Scheduler();
    const first = s.schedule(ev(1));
    const second = s.schedule(ev(2));
    expect(s.peek()?.id).toBe(first);
    expect(s.peek()?.id).toBe(first);
    s.cancel(first);
    expect(s.peek()?.id).toBe(second);
    expect(new Scheduler().peek()).toBeUndefined();
  });

  it('popDue takes events at the target and leaves target + 1', () => {
    const s = new Scheduler();
    const atTarget = s.schedule(ev(60));
    const after = s.schedule(ev(61));
    expect(drain(s, 60)).toEqual([atTarget]);
    expect(s.peek()?.id).toBe(after);
    expect(s.now).toBe(60);
  });

  it('popDue on an empty window returns nothing but still moves time', () => {
    const s = new Scheduler();
    s.schedule(ev(500));
    expect(s.popDue(10)).toEqual([]);
    expect(s.now).toBe(10);
    expect(s.popDue(5)).toEqual([]);
    expect(s.now).toBe(10); // never moves back
  });

  it('popNext lets a handler schedule between events that are already pending', () => {
    const s = new Scheduler();
    s.schedule(ev(10, TickPhase.Simulation, 0, 'A'));
    s.schedule(ev(20, TickPhase.Simulation, 0, 'B'));

    const order: string[] = [];
    for (let e = s.popNext(30); e; e = s.popNext(30)) {
      order.push(e.kind);
      if (e.kind === 'A') s.schedule(ev(15, TickPhase.Simulation, 0, 'C'));
    }
    expect(order).toEqual(['A', 'C', 'B']);
  });

  it('popNext does not run events after the target', () => {
    const s = new Scheduler();
    s.schedule(ev(11));
    expect(s.popNext(10)).toBeUndefined();
    expect(s.now).toBe(0);
    expect(s.size).toBe(1);
  });
});

describe('serialize / restore', () => {
  const populated = () => {
    const s = new Scheduler(-10);
    s.schedule({ ...ev(5, TickPhase.Timers, 2, 'a'), payload: { n: 1, list: [1, 2] } });
    s.schedule(ev(5, TickPhase.Calendar, 0, 'b'));
    s.schedule(ev(5, TickPhase.Calendar, 0, 'c'));
    const cancelled = s.schedule(ev(7));
    s.schedule(ev(9, TickPhase.Outcome, 0, 'd'));
    s.cancel(cancelled);
    s.popNext(5); // 'b' fired: not part of the snapshot
    return s;
  };

  it('restores the same order for the remaining events', () => {
    const original = populated();
    const restored = Scheduler.restore(original.serialize());
    expect(restored.now).toBe(original.now);
    expect(restored.size).toBe(original.size);
    expect(restored.popDue(100)).toEqual(original.popDue(100));
  });

  it('keeps the seq counter: ids and tie-breaks of later events match', () => {
    const original = populated();
    const restored = Scheduler.restore(original.serialize());
    const add = (s: Scheduler) => [
      s.schedule(ev(5, TickPhase.Calendar, 0, 'later1')),
      s.schedule(ev(5, TickPhase.Calendar, 0, 'later2')),
    ];
    expect(add(restored)).toEqual(add(original));
    expect(restored.popDue(100)).toEqual(original.popDue(100));
  });

  it('round-trips through JSON and gives the same state hash', () => {
    const state = populated().serialize();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(stateHash(Scheduler.restore(state).serialize())).toBe(stateHash(state));
    expect(stateHash(populated().serialize())).toBe(stateHash(state));
  });

  it('lists events in processing order and is detached from the scheduler', () => {
    const s = populated();
    const state = s.serialize();
    expect(state.events.map((e) => e.kind)).toEqual(['c', 'a', 'd']);
    (state.events[1]?.payload as { n: number }).n = 99;
    expect(s.serialize().events[1]?.payload).toEqual({ n: 1, list: [1, 2] });
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a payload that is not canonical JSON (%s)', (_name, value) => {
    const s = new Scheduler();
    s.schedule({ ...ev(1), payload: { value } });
    expect(() => s.serialize()).toThrow();
  });

  const good = () => populated().serialize();
  const withEvent = (patch: Record<string, unknown>) => {
    const state = good();
    return { ...state, events: state.events.map((e, i) => (i === 0 ? { ...e, ...patch } : e)) };
  };

  it.each([
    ['not an object', 42],
    ['extra field', { ...good(), extra: 1 }],
    ['negative nextSeq', { ...good(), nextSeq: -1 }],
    ['fractional now', { ...good(), now: 0.5 }],
    ['phase out of range', withEvent({ phase: 9 })],
    ['id does not match seq', withEvent({ id: 'evt_77' })],
    ['seq not below nextSeq', withEvent({ seq: 1000, id: 'evt_1000' })],
    ['event before now', withEvent({ at: -999 })],
    ['missing payload', withEvent({ payload: undefined })],
    ['empty kind', withEvent({ kind: '' })],
  ])('rejects corrupt state: %s', (_name, state) => {
    expect(() => Scheduler.restore(state)).toThrow(
      expect.objectContaining({ code: 'SCHEDULER_INVALID_STATE' }),
    );
  });

  it('rejects duplicate events', () => {
    const state = good();
    const first = state.events[0];
    expect(() => Scheduler.restore({ ...state, events: [...state.events, first] })).toThrow(
      SchedulerError,
    );
  });
});

describe('performance', () => {
  it('100 000 schedule + pop in under 200 ms', () => {
    const run = (): number => {
      const s = new Scheduler();
      let x = 12345; // fixed LCG: no Math.random in core (ADR 0004)
      const start = process.hrtime.bigint();
      for (let i = 0; i < 100_000; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        s.schedule(ev(x % 4320, ((x >>> 12) % 7) as TickPhase, (x >>> 20) % 5));
      }
      let popped = 0;
      while (s.popNext(Number.MAX_SAFE_INTEGER)) popped++;
      expect(popped).toBe(100_000);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    run(); // warm-up: JIT
    expect(Math.min(run(), run(), run())).toBeLessThan(200);
  });
});
