import { expect, test } from 'vitest';
import { createRng } from '../../rng/index.ts';
import { Calendar, TimeSystem } from '../../time/index.ts';
import { executePlot, followRoutine, GoalLoop, GoalPlanner, type Goal } from './index.ts';

const rng = createRng('goal-test');

test('selects a feasible goal by score, breaking ties by ID independent of registration order', () => {
  const simple = (id: string): Goal<null> => ({
    id,
    score: () => 2,
    plan: () => ({ duration: 1, start() {} }),
  });
  const unplanned: Goal<null> = { id: 'broken', score: () => 5, plan: () => null };
  const tooLong: Goal<null> = {
    id: 'long',
    score: () => 4,
    plan: () => ({ duration: 11, start() {} }),
  };
  const context = { agentId: 'agent', state: null, now: 0, endAt: 10 };
  for (const order of [
    [simple('beta'), simple('alpha')],
    [simple('alpha'), simple('beta')],
  ]) {
    const planner = new GoalPlanner<null>().register(unplanned).register(tooLong);
    for (const goal of order) planner.register(goal);
    expect(planner.choose(context, rng)?.id).toBe('alpha');
    expect(() => planner.register(simple('alpha'))).toThrow(/duplicate/);
  }
});

test('TimeSystem runs routine at boundaries and starts each plot step inside its window', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T08:00'), 40);
  const seen: [string, string, number][] = [];
  const planner = new GoalPlanner<null>()
    .register(followRoutine(({ agentId, now }) => seen.push([agentId, 'routine', now])))
    .register(
      executePlot(
        new Map([
          [
            'actor',
            [
              { id: 'first', window: { from: 3, to: 7 }, duration: 4 },
              { id: 'second', window: { from: 8, to: 13 }, duration: 3 },
            ],
          ],
        ]),
        ({ agentId, now }, { id }) => seen.push([agentId, id, now]),
      ),
    );
  const loop = new GoalLoop({
    rng,
    time,
    planner,
    endAt: 17,
    agents: ['witness', 'actor'].map((id) => ({
      id,
      readState: () => null,
      nextRoutineBoundary: (now) => (Math.floor(now / 5) + 1) * 5,
    })),
  });
  loop.trigger('actor', 4);
  loop.trigger('witness', 12);
  loop.trigger('witness', 12);
  expect(seen).toEqual([]);
  time.advance(17);
  expect(seen.filter(([agent]) => agent === 'actor')).toEqual([
    ['actor', 'routine', 0],
    ['actor', 'first', 3],
    ['actor', 'routine', 7],
    ['actor', 'second', 8],
    ['actor', 'routine', 11],
    ['actor', 'routine', 15],
  ]);
  expect(seen.filter(([agent]) => agent === 'witness').map(([, , minute]) => minute)).toEqual([
    0, 5, 10, 12, 15,
  ]);
  expect(seen.slice(0, 2).map(([agent]) => agent)).toEqual(['actor', 'witness']);
});

test('an expired required step prevents later steps and the routine remains available', () => {
  const time = new TimeSystem(new Calendar('2026-01-14T08:00'), 20, 4);
  const seen: string[] = [];
  const planner = new GoalPlanner<null>()
    .register(followRoutine(() => seen.push('routine')))
    .register(
      executePlot(
        new Map([
          [
            'actor',
            [
              { id: 'expired', window: { from: 1, to: 5 }, duration: 2 },
              { id: 'later', window: { from: 8, to: 12 }, duration: 1 },
            ],
          ],
        ]),
        (_context, { id }) => seen.push(id),
      ),
    );
  const loop = new GoalLoop({
    rng,
    time,
    planner,
    endAt: 20,
    agents: [{ id: 'actor', readState: () => null, nextRoutineBoundary: () => undefined }],
  });
  loop.trigger('actor', 9);
  time.advance(16);
  expect(seen).toEqual(['routine', 'routine']);
});
