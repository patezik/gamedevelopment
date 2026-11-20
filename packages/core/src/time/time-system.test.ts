import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Calendar, TimeSystem, TickPhase, type PhaseHandler } from './index.ts';

const request = (kind: string, at: number, priority = 0, payload: unknown = null) => ({
  kind,
  at,
  priority,
  payload,
});

test('reports hour, day and period boundaries in the interval actually advanced', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T23:59'), 1440);
  expect(time.advance(1).events).toEqual([
    { type: 'ClockAdvanced', from: 0, to: 1 },
    { type: 'DayChanged', at: 1, from: 1, to: 2 },
  ]);
  expect(time.advance(1320).events).toEqual([
    { type: 'ClockAdvanced', from: 1, to: 1321 },
    { type: 'PeriodChanged', at: 361, from: 'night', to: 'morning' },
    { type: 'PeriodChanged', at: 721, from: 'morning', to: 'day' },
    { type: 'PeriodChanged', at: 1081, from: 'day', to: 'evening' },
    { type: 'PeriodChanged', at: 1321, from: 'evening', to: 'night' },
  ]);
  const morningEdge = new TimeSystem(new Calendar('2026-01-14T05:00'), 60);
  expect(morningEdge.advance(59).events).toEqual([{ type: 'ClockAdvanced', from: 0, to: 59 }]);
  expect(morningEdge.advance(1).events[1]).toEqual({
    type: 'PeriodChanged',
    at: 60,
    from: 'night',
    to: 'morning',
  });
});

test('processes all crossed midnights and handles prehistory', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T00:00'), 2880, -1);
  expect(time.advance(2881).events.filter((event) => event.type === 'DayChanged')).toEqual([
    { type: 'DayChanged', at: 0, from: 0, to: 1 },
    { type: 'DayChanged', at: 1440, from: 1, to: 2 },
    { type: 'DayChanged', at: 2880, from: 2, to: 3 },
  ]);
});

test('dispatches by phase, priority and sequence and handles new events through the target', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T08:00'), 100);
  const seen: unknown[] = [];
  const handle: PhaseHandler['handle'] = (event, ctx) => {
    expect(ctx.now).toBe(event.at);
    expect(time.now()).toBe(event.at);
    seen.push(event.payload);
    if (event.payload === 'first') {
      ctx.schedule(request('simulation', 7, 0, 'added'));
      ctx.schedule(request('simulation', 11, 0, 'after target'));
    }
  };
  time.registerHandler('simulation', { phase: TickPhase.Simulation, handle });
  time.registerHandler('calendar', { phase: TickPhase.Calendar, handle });
  time.schedule(request('simulation', 5, 1, 'last at five'));
  time.schedule(request('simulation', 5, 0, 'first'));
  time.schedule(request('simulation', 5, 0, 'second'));
  time.schedule(request('calendar', 5, 100, 'earliest phase'));
  time.schedule(request('simulation', 10, 0, 'target'));

  expect(time.advance(10)).toMatchObject({ from: 0, to: 10, processed: 6 });
  expect(seen).toEqual(['earliest phase', 'first', 'second', 'last at five', 'added', 'target']);
  expect(time.advance(1)).toMatchObject({ from: 10, to: 11, processed: 1 });
  expect(seen.at(-1)).toBe('after target');
});

test('interrupts at the handler minute, leaves pending events intact, and supports proportional effects', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T05:30'), 100);
  const seen: unknown[] = [];
  time.registerHandler('disturbance', {
    phase: TickPhase.WorldEvents,
    handle(event) {
      seen.push(event.payload);
      return { interrupt: 'phone call' };
    },
  });
  time.schedule(request('disturbance', 37, 0, 'first'));
  time.schedule(request('disturbance', 37, 0, 'second'));
  time.schedule(request('disturbance', 60, 0, 'later'));
  const elapsed = time.advance(60, { interruptible: true });
  expect(elapsed).toEqual({
    from: 0,
    to: 37,
    processed: 1,
    interruptedAt: 37,
    interruptReason: 'phone call',
    events: [
      { type: 'ClockAdvanced', from: 0, to: 37 },
      { type: 'PeriodChanged', at: 30, from: 'night', to: 'morning' },
    ],
  });
  expect((60 * (elapsed.to - elapsed.from)) / 60).toBe(37);
  expect(seen).toEqual(['first']);
  expect(time.advance(23, { interruptible: false })).toMatchObject({
    from: 37,
    to: 60,
    processed: 2,
  });
  expect(seen).toEqual(['first', 'second', 'later']);
});

test('caps advancement for one-, three- and seven-day scenarios and runs Outcome at the deadline', () => {
  fc.assert(
    fc.property(fc.constantFrom(1, 3, 7), fc.nat(1000), (days, excess) => {
      const end = days * 1440;
      const time = new TimeSystem(new Calendar('2026-01-14T00:00'), end);
      const seen: number[] = [];
      time.registerHandler('end', {
        phase: TickPhase.Outcome,
        handle(event) {
          seen.push(event.at);
        },
      });
      time.schedule(request('end', end));
      time.schedule(request('end', end + 1));
      const result = time.advance(end + excess);
      expect(result).toMatchObject({ to: end, processed: 1 });
      expect(result.limit).toBe(excess > 0 ? 'TIME_BEYOND_SCENARIO_END' : undefined);
      expect(time.advance(1)).toMatchObject({
        to: end,
        processed: 0,
        limit: 'TIME_BEYOND_SCENARIO_END',
      });
      expect(seen).toEqual([end]);
    }),
    { seed: 3003 },
  );
});

test('rejects invalid advance requests without moving the clock', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T00:00'), 100);
  expect(() => time.advance(-1)).toThrow(
    expect.objectContaining({ code: 'TIME_NEGATIVE_ADVANCE' }),
  );
  expect(() => time.advance(0.5)).toThrow(RangeError);
  expect(time.now()).toBe(0);
});
