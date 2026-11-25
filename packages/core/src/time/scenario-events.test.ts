import fc from 'fast-check';
import { expect, test } from 'vitest';
import { presetSchema } from '../content/schemas.ts';
import { Calendar, ScenarioEvents, TimeSystem, type ScenarioEventsConfig } from './index.ts';
import type { ScenarioEventsPorts } from './scenario-events.ts';

function setup(
  config: ScenarioEventsConfig,
  end = 4320,
  ports: {
    static?: () => number;
    present?: boolean;
    applyMissedEffect?: ScenarioEventsPorts['applyMissedEffect'];
  } = {},
) {
  const time = new TimeSystem(new Calendar('2026-01-14T08:00'), end);
  const events = new ScenarioEvents(time, config, {
    staticLevel: ports.static ?? (() => 0),
    isPlayerPresent: () => ports.present ?? false,
    applyMissedEffect: ports.applyMissedEffect ?? (() => {}),
  });
  return { time, events };
}

const blackout = { id: 'blackout', at: 2280, earlierIf: { staticAtLeast: 50, at: 1920 } };

test('a critical event fires exactly at its minute, not one minute earlier', () => {
  const { time, events } = setup({ criticalEvents: [{ id: 'blackout', at: 100 }], deadlines: [] });
  time.advance(99);
  expect(events.drain()).toEqual([]);
  time.advance(1);
  expect(events.drain()).toEqual([{ type: 'CriticalEventFired', id: 'blackout', at: 100 }]);
});

test('earlierIf pulls the event forward only when Static is at least the threshold', () => {
  for (const [level, at] of [
    [50, 1920],
    [49, 2280],
  ] as const) {
    const { time, events } = setup({ criticalEvents: [blackout], deadlines: [] }, 4320, {
      static: () => level,
    });
    time.advance(4320);
    expect(events.drain()).toEqual([{ type: 'CriticalEventFired', id: 'blackout', at }]);
  }
});

test('Static is read at the check minute, and the event fires once', () => {
  let level = 0;
  const { time, events } = setup({ criticalEvents: [blackout], deadlines: [] }, 4320, {
    static: () => level,
  });
  level = 90;
  time.advance(1919);
  level = 10;
  time.advance(500);
  expect(events.drain()).toEqual([{ type: 'CriticalEventFired', id: 'blackout', at: 2280 }]);
});

test('an event the player did not attend is missed and carries its onMissed effect', () => {
  const onMissed = { kind: 'static', delta: 10 } as const;
  const config = {
    criticalEvents: presetSchema.shape.criticalEvents.parse([
      { id: 'meeting', at: 780, requiresPresence: { locationId: 'greenhouse' }, onMissed },
      blackout,
    ]),
    deadlines: [],
  };
  let level = 40;
  const applyMissedEffect: ScenarioEventsPorts['applyMissedEffect'] = (effect, at) => {
    expect(effect).toEqual(onMissed);
    expect(at).toBe(780);
    if (effect.kind === 'static') level += effect.delta;
  };
  const away = setup(config, 4320, { static: () => level, applyMissedEffect });
  away.time.advance(2300);
  expect(away.events.drain()).toEqual([
    { type: 'ScheduledEventMissed', id: 'meeting', at: 780, onMissed },
    { type: 'CriticalEventFired', id: 'blackout', at: 1920 },
  ]);
  expect(level).toBe(50);
  const there = setup(config, 4320, { present: true, applyMissedEffect });
  there.time.advance(780);
  expect(there.events.drain()).toEqual([{ type: 'CriticalEventFired', id: 'meeting', at: 780 }]);
  expect(level).toBe(50);
});

test('a fired critical event interrupts an interruptible action', () => {
  const { time } = setup({ criticalEvents: [{ id: 'blackout', at: 30 }], deadlines: [] });
  const result = time.advance(60, { interruptible: true });
  expect(result).toMatchObject({ to: 30, interruptedAt: 30, interruptReason: 'critical:blackout' });
});

test('a deadline exactly at the scenario end gives time_up; one minute later it never fires', () => {
  const at = setup({
    criticalEvents: [],
    deadlines: [{ id: 'police', at: 4320, outcome: 'time_up' }],
  });
  at.time.advance(4319);
  expect(at.events.outcome()).toBeUndefined();
  at.time.advance(10);
  expect(at.events.outcome()).toBe('time_up');
  expect(at.events.drain()).toEqual([
    { type: 'DeadlineReached', id: 'police', at: 4320, outcome: 'time_up' },
  ]);
  const late = setup({
    criticalEvents: [],
    deadlines: [{ id: 'police', at: 4321, outcome: 'time_up' }],
  });
  late.time.advance(5000);
  expect(late.events.outcome()).toBeUndefined();
});

test('a deadline is handled after a critical event of the same minute', () => {
  const { time, events } = setup({
    criticalEvents: [{ id: 'last', at: 100 }],
    deadlines: [{ id: 'end', at: 100, outcome: 'time_up' }],
  });
  time.advance(100);
  expect(events.drain().map(({ type }) => type)).toEqual(['CriticalEventFired', 'DeadlineReached']);
});

test('invalid configuration is rejected', () => {
  expect(() =>
    setup({
      criticalEvents: [],
      deadlines: [
        { id: 'end', at: 5, outcome: 'time_up' },
        { id: 'end', at: 6, outcome: 'solved' },
      ],
    }),
  ).toThrow('Duplicate deadline: end');
  expect(() =>
    setup({
      criticalEvents: [
        { id: 'a', at: 5 },
        { id: 'a', at: 6 },
      ],
      deadlines: [],
    }),
  ).toThrow(RangeError);
  expect(() =>
    setup({
      criticalEvents: [{ id: 'a', at: 5, earlierIf: { staticAtLeast: 1, at: 5 } }],
      deadlines: [],
    }),
  ).toThrow(RangeError);
});

test('scenarios of 1, 3 and 7 days end with time_up exactly at their duration', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1440, 4320, 10080),
      fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: 1, maxLength: 12 }),
      (duration, steps) => {
        const { time, events } = setup(
          { criticalEvents: [], deadlines: [{ id: 'end', at: duration, outcome: 'time_up' }] },
          duration,
        );
        let spent = 0;
        for (const step of steps) {
          time.advance(step);
          spent = Math.min(duration, spent + step);
          expect(events.outcome() === 'time_up').toBe(spent === duration);
        }
        time.advance(duration);
        expect(events.outcome()).toBe('time_up');
        expect(events.drain().filter(({ type }) => type === 'DeadlineReached')).toHaveLength(1);
      },
    ),
  );
});
