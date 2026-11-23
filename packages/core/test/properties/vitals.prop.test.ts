import {
  VITALS_LIMITS,
  applyDelta,
  rest,
  tickAwake,
  trustedTalk,
  type SurvivalEvent,
  type VitalsState,
  type VitalsStep,
} from '@hs/core/survival';
import { Calendar } from '@hs/core/time';
import fc from 'fast-check';
import { expect, test } from 'vitest';

const startState = fc.record({
  health: fc.integer({ min: 0, max: 10 }),
  sanity: fc.integer({ min: 0, max: 10 }),
  fatigue: fc.integer({ min: 0, max: 100 }),
});
const initial = startState.map((vitals): VitalsState => ({
  vitals,
  awakeMinutes: 0,
  restedMinutes: 0,
  trustedTalkDay: null,
}));

type Op =
  | { op: 'delta'; health: number; sanity: number; fatigue: number }
  | { op: 'awake'; minutes: number }
  | { op: 'rest'; minutes: number };
const operation: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant('delta' as const),
    health: fc.integer({ min: -5, max: 5 }),
    sanity: fc.integer({ min: -5, max: 5 }),
    fatigue: fc.integer({ min: -40, max: 40 }),
  }),
  fc.record({ op: fc.constant('awake' as const), minutes: fc.integer({ min: 0, max: 400 }) }),
  fc.record({ op: fc.constant('rest' as const), minutes: fc.integer({ min: 0, max: 600 }) }),
);

const run = (state: VitalsState, op: Op, at: number): VitalsStep =>
  op.op === 'delta'
    ? applyDelta(state, { health: op.health, sanity: op.sanity, fatigue: op.fatigue }, at, 'x')
    : op.op === 'awake'
      ? tickAwake(state, op.minutes, at)
      : rest(state, op.minutes, at);

test('whatever happens, vitals stay whole numbers inside their limits', () => {
  fc.assert(
    fc.property(initial, fc.array(operation, { maxLength: 40 }), (start, ops) => {
      let state = start;
      ops.forEach((op, i) => {
        state = run(state, op, i).state;
        for (const key of ['health', 'sanity', 'fatigue'] as const) {
          const value = state.vitals[key];
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(VITALS_LIMITS[key].min);
          expect(value).toBeLessThanOrEqual(VITALS_LIMITS[key].max);
        }
        expect(state.awakeMinutes).toBeGreaterThanOrEqual(0);
        expect(state.awakeMinutes).toBeLessThan(6);
        expect(state.restedMinutes).toBeGreaterThanOrEqual(0);
        expect(state.restedMinutes).toBeLessThan(240);
      });
    }),
    { seed: 42, numRuns: 300 },
  );
});

test('events describe exactly what changed, and the ending is announced once', () => {
  fc.assert(
    fc.property(initial, fc.array(operation, { maxLength: 40 }), (start, ops) => {
      let state = start;
      const incapacitated: SurvivalEvent[] = [];
      ops.forEach((op, i) => {
        const step = run(state, op, i);
        const changed = JSON.stringify(step.state.vitals) !== JSON.stringify(state.vitals);
        const changes = step.events.filter((event) => event.type === 'VitalsChanged');
        expect(changes).toHaveLength(changed ? 1 : 0);
        for (const event of changes) {
          if (event.type !== 'VitalsChanged') continue;
          expect(event.before).toEqual(state.vitals);
          expect(event.after).toEqual(step.state.vitals);
        }
        incapacitated.push(...step.events.filter((event) => event.type === 'PlayerIncapacitated'));
        state = step.state;
      });
      expect(incapacitated.length).toBeLessThanOrEqual(1);
    }),
    { seed: 42, numRuns: 300 },
  );
});

test('rest and awake time give the same result however they are split', () => {
  const split = fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 8 });
  fc.assert(
    fc.property(
      initial,
      split,
      fc.constantFrom('awake' as const, 'rest' as const),
      (start, parts, kind) => {
        const apply = (state: VitalsState, minutes: number): VitalsState =>
          (kind === 'awake' ? tickAwake(state, minutes, 0) : rest(state, minutes, 0)).state;
        const total = parts.reduce((sum, part) => sum + part, 0);
        const stepwise = parts.reduce(apply, start);
        expect(stepwise).toEqual(apply(start, total));
      },
    ),
    { seed: 42, numRuns: 300 },
  );
});

test('after the game ends nothing moves any more', () => {
  fc.assert(
    fc.property(initial, fc.array(operation, { maxLength: 40 }), (start, ops) => {
      let state = start;
      let over = false;
      ops.forEach((op, i) => {
        const step = run(state, op, i);
        if (over) expect(step.state).toBe(state);
        state = step.state;
        over = over || state.vitals.health === 0 || state.vitals.sanity === 0;
      });
    }),
    { seed: 42, numRuns: 300 },
  );
});

test('trusted talks restore at most 1 sanity per game day, however often they are tried', () => {
  const calendar = new Calendar('2026-01-14T08:00:00');
  fc.assert(
    fc.property(
      initial,
      fc.array(fc.integer({ min: 0, max: 700 }), { minLength: 1, maxLength: 40 }),
      (start, gaps) => {
        let state = start;
        let at = -300; // starts in prehistory, so day 0 is covered too
        const days = new Set<number>();
        let gained = 0;
        for (const gap of gaps) {
          at += gap;
          const step = trustedTalk(state, at, calendar);
          for (const event of step.events) {
            if (event.type === 'VitalsChanged') {
              gained += event.after.sanity - event.before.sanity;
              days.add(calendar.toDisplay(at).day);
            }
          }
          state = step.state;
        }
        expect(gained).toBeLessThanOrEqual(days.size);
        expect(gained).toBeLessThanOrEqual(1 + Math.floor((at + 300) / 1440) + 1);
      },
    ),
    { seed: 42, numRuns: 300 },
  );
});
