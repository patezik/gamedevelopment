import { expect, test } from 'vitest';
import { Calendar, ScenarioEvents, TimeSystem } from '../time/index.ts';
import {
  StaticTimer,
  applyStaticDelta,
  createStaticState,
  restoreStaticState,
  staticLevel,
  tickStatic,
  STATIC_DELTAS,
  SurvivalError,
} from './index.ts';

const thresholds = (events: readonly { type: string; threshold?: number }[]) =>
  events.filter((e) => e.type === 'StaticThresholdReached').map((e) => e.threshold);

test('grows +1 per 60 minutes and carries the remainder regardless of how time is split', () => {
  let split = createStaticState();
  for (const m of [37, 23, 59, 1, 61]) split = tickStatic(split, m, 0).state;
  const whole = tickStatic(createStaticState(), 181, 0).state;
  expect(split).toEqual(whole);
  expect(split.level).toBe(3);
  expect(split.carryMinutes).toBe(1);
});

test('each threshold fires exactly once, even if Static falls and rises again', () => {
  let state = createStaticState(24);
  const seen: unknown[] = [];
  const push = (step: {
    state: typeof state;
    events: readonly { type: string; threshold?: number }[];
  }) => {
    state = step.state;
    seen.push(...thresholds(step.events));
  };
  push(applyStaticDelta(state, 1, 10, 'x')); // 25
  push(applyStaticDelta(state, STATIC_DELTAS.contradictionRevealed, 11, 'c')); // 22
  push(applyStaticDelta(state, 5, 12, 'x')); // 27
  push(applyStaticDelta(state, 25, 13, 'x')); // 52
  push(applyStaticDelta(state, -30, 14, 'x')); // 22
  push(applyStaticDelta(state, STATIC_DELTAS.falseAccusation + 30, 15, 'x')); // 67
  expect(seen).toEqual([25, 50]);
});

test('one jump over several thresholds reports each in ascending order', () => {
  const step = applyStaticDelta(createStaticState(), 80, 5, 'jump');
  expect(thresholds(step.events)).toEqual([25, 50, 75]);
});

test('thresholds already reached at creation are not reported again', () => {
  const step = applyStaticDelta(createStaticState(30), 1, 5, 'x');
  expect(thresholds(step.events)).toEqual([]);
});

test('level is clamped to 0..100', () => {
  expect(applyStaticDelta(createStaticState(2), -3, 0, 'x').state.level).toBe(0);
  expect(applyStaticDelta(createStaticState(90), 50, 0, 'x').state.level).toBe(100);
});

test('Static 100 ends the game by the preset rule and then freezes', () => {
  const step = applyStaticDelta(createStaticState(99), 1, 7, 'time', 'signal_wins');
  expect(step.events).toContainEqual({ type: 'StaticOverwhelmed', at: 7, ending: 'signal_wins' });
  expect(applyStaticDelta(step.state, -3, 8, 'x')).toEqual({ state: step.state, events: [] });
  expect(tickStatic(step.state, 600, 9)).toEqual({ state: step.state, events: [] });
  const dflt = applyStaticDelta(createStaticState(99), 1, 7, 'time');
  expect(dflt.events).toContainEqual({ type: 'StaticOverwhelmed', at: 7, ending: 'madness' });
});

test('invalid input is rejected', () => {
  expect(() => tickStatic(createStaticState(), -1, 0)).toThrow(RangeError);
  expect(() => applyStaticDelta(createStaticState(), 1.5, 0, 'x')).toThrow(RangeError);
  expect(() => restoreStaticState({ level: 101, carryMinutes: 0, reached: [] })).toThrow(
    SurvivalError,
  );
  const saved = applyStaticDelta(createStaticState(), 60, 0, 'x').state;
  expect(restoreStaticState(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
});

test('the timer grows Static hourly through TimeSystem.advance and interrupts at 100', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T08:00'), 10000);
  const timer = new StaticTimer(time, createStaticState(97));
  time.advance(179);
  expect(timer.level()).toBe(99);
  const result = time.advance(500, { interruptible: true });
  expect(timer.level()).toBe(100);
  expect(result.interruptedAt).toBe(180);
  expect(result.interruptReason).toBe('static');
  expect(timer.drain().map((e) => e.type)).toContain('StaticOverwhelmed');
});

test('Static pulls a critical event forward via the staticLevel port', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T08:00'), 10000);
  const timer = new StaticTimer(time, createStaticState(48));
  const events = new ScenarioEvents(
    time,
    {
      criticalEvents: [{ id: 'blackout', at: 600, earlierIf: { staticAtLeast: 50, at: 180 } }],
      deadlines: [],
    },
    {
      staticLevel: () => staticLevel(timer.state()),
      isPlayerPresent: () => true,
      applyMissedEffect: () => {},
    },
  );
  time.advance(700);
  expect(events.drain()).toEqual([{ type: 'CriticalEventFired', id: 'blackout', at: 180 }]);

  const low = new TimeSystem(new Calendar('2026-01-14T08:00'), 10000);
  const lowTimer = new StaticTimer(low, createStaticState(0));
  const lowEvents = new ScenarioEvents(
    low,
    {
      criticalEvents: [{ id: 'blackout', at: 600, earlierIf: { staticAtLeast: 50, at: 180 } }],
      deadlines: [],
    },
    {
      staticLevel: () => lowTimer.level(),
      isPlayerPresent: () => true,
      applyMissedEffect: () => {},
    },
  );
  low.advance(700);
  expect(lowEvents.drain()).toEqual([{ type: 'CriticalEventFired', id: 'blackout', at: 600 }]);
});
