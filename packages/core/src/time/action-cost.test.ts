import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { loadScenarioFromDir } from '@hs/core/content';
import { LocationGraph } from '@hs/core/world';
import {
  ACTION_KINDS,
  ActionCostError,
  DEFAULT_ACTION_COSTS,
  createActionCostTable,
  resolveActionCost,
  type ActionKind,
  type CostContext,
  type CostModifier,
  type TravelTimeProvider,
} from './action-cost.ts';

const route = (minutes: number | null): TravelTimeProvider => ({ travelTime: () => minutes });
const move = (minutes: number): CostContext => ({
  travel: { provider: route(minutes), from: 'a', to: 'b' },
});
const multiply = (id: string, order: number, factor: number, only?: ActionKind): CostModifier => ({
  id,
  order,
  apply: (minutes, action) => (only === undefined || action === only ? minutes * factor : minutes),
});
const add = (id: string, order: number, extra: number, only: ActionKind[]): CostModifier => ({
  id,
  order,
  apply: (minutes, action) => (only.includes(action) ? minutes + extra : minutes),
});

const code = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error instanceof ActionCostError ? error.code : error;
  }
  return 'did not throw';
};

describe('defaults', () => {
  it('cover every action of game-design.md section 2', () => {
    expect([...ACTION_KINDS].sort()).toEqual(
      [
        'call',
        'captureEvidence',
        'examineHotspot',
        'examineLocation',
        'interrogate',
        'message',
        'move',
        'pickLock',
        'read',
        'rest',
        'talk',
        'useItem',
        'wait',
      ].sort(),
    );
    expect(Object.keys(DEFAULT_ACTION_COSTS).sort()).toEqual([...ACTION_KINDS].sort());
  });

  it('match the JSON table printed in time-system.md section 3', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../../../../docs/simulation/time-system.md', import.meta.url)),
      'utf8',
    );
    const block = /```json\n(\{ "move"[\s\S]*?)\n```/.exec(doc)?.[1];
    expect(block).toBeDefined();
    expect(JSON.parse(block ?? '')).toEqual(DEFAULT_ACTION_COSTS);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(DEFAULT_ACTION_COSTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ACTION_COSTS.rest)).toBe(true);
  });
});

describe('base cost without modifiers', () => {
  it.each<[string, ActionKind, CostContext, [number, number, number]]>([
    ['move uses the route time', 'move', move(8), [8, 8, 8]],
    ['move on the spot is free', 'move', move(0), [0, 0, 0]],
    ['examineLocation', 'examineLocation', {}, [15, 15, 15]],
    ['examineHotspot', 'examineHotspot', {}, [5, 5, 5]],
    ['captureEvidence', 'captureEvidence', {}, [2, 2, 2]],
    ['talk', 'talk', {}, [10, 10, 10]],
    ['interrogate', 'interrogate', {}, [20, 20, 20]],
    ['call without a known length', 'call', {}, [5, 5, 5]],
    ['call adds the conversation', 'call', { conversationMinutes: 12 }, [17, 17, 17]],
    ['message', 'message', {}, [2, 2, 2]],
    ['read', 'read', {}, [10, 10, 10]],
    ['pickLock is a range: failing costs 10 more', 'pickLock', {}, [20, 30, 20]],
    ['useItem', 'useItem', {}, [5, 5, 5]],
    ['rest preview spans the choices', 'rest', {}, [60, 240, 60]],
    ['rest 120', 'rest', { minutes: 120 }, [120, 120, 120]],
    ['wait preview spans the range', 'wait', {}, [15, 120, 15]],
    ['wait 45', 'wait', { minutes: 45 }, [45, 45, 45]],
    ['wait 120', 'wait', { minutes: 120 }, [120, 120, 120]],
  ])('%s', (_name, action, ctx, [min, max, expected]) => {
    expect(resolveActionCost(action, ctx)).toEqual({ min, max, expected });
  });
});

describe('modifiers: every action x fatigue (+25 %), rounded once', () => {
  const fatigue = [multiply('fatigue', 10, 1.25)];
  it.each<[ActionKind, CostContext, [number, number, number]]>([
    ['move', move(8), [10, 10, 10]], // 10.0
    ['examineLocation', {}, [19, 19, 19]], // 18.75
    ['examineHotspot', {}, [6, 6, 6]], // 6.25
    ['captureEvidence', {}, [3, 3, 3]], // 2.5 rounds up
    ['talk', {}, [13, 13, 13]], // 12.5
    ['interrogate', {}, [25, 25, 25]],
    ['call', { conversationMinutes: 12 }, [21, 21, 21]], // 21.25
    ['message', {}, [3, 3, 3]],
    ['read', {}, [13, 13, 13]],
    ['pickLock', {}, [25, 38, 25]], // 25, 37.5, 25
    ['useItem', {}, [6, 6, 6]],
    ['rest', { minutes: 120 }, [150, 150, 150]],
    ['wait', { minutes: 45 }, [56, 56, 56]], // 56.25
  ])('%s', (action, ctx, [min, max, expected]) => {
    expect(resolveActionCost(action, { ...ctx, modifiers: fatigue })).toEqual({
      min,
      max,
      expected,
    });
  });
});

describe('modifier order', () => {
  const fatigue = multiply('fatigue', 10, 1.25);
  const sanity = add('sanity', 20, 5, ['talk', 'interrogate', 'call']);

  it('runs by order: (10 x 1.25) + 5 = 17.5 -> 18', () => {
    expect(resolveActionCost('talk', { modifiers: [fatigue, sanity] }).expected).toBe(18);
  });

  it('is part of the contract: reversing the order changes the result', () => {
    const swapped = [
      { ...fatigue, order: 20 },
      { ...sanity, order: 10 },
    ]; // (10 + 5) x 1.25 = 18.75
    expect(resolveActionCost('talk', { modifiers: swapped }).expected).toBe(19);
  });

  it('does not depend on the order of the array', () => {
    const all = [
      fatigue,
      sanity,
      multiply('darkness', 30, 1.5, 'move'),
      multiply('trauma', 31, 1.5, 'move'),
    ];
    const expected = resolveActionCost('move', { ...move(8), modifiers: all });
    expect(expected.expected).toBe(23); // 8 x 1.25 x 1.5 x 1.5 = 22.5
    for (const shuffled of [
      [...all].reverse(),
      [all[2], all[0], all[3], all[1]],
    ] as CostModifier[][]) {
      expect(resolveActionCost('move', { ...move(8), modifiers: shuffled })).toEqual(expected);
    }
  });

  it('breaks equal orders by id', () => {
    const a = { id: 'a', order: 1, apply: (m: number) => m + 1 };
    const b = { id: 'b', order: 1, apply: (m: number) => m * 2 };
    // a first: (10 + 1) x 2 = 22; b first would give 21
    expect(resolveActionCost('talk', { modifiers: [b, a] }).expected).toBe(22);
  });
});

describe('rounding and limits', () => {
  it('rounds .5 up even when floating point lands just below it (50 x 1.15)', () => {
    expect(50 * 1.15).toBeLessThan(57.5); // 57.49999999999999: a plain Math.round would give 57
    const table = createActionCostTable({ talk: { base: 50 } });
    expect(resolveActionCost('talk', { modifiers: [multiply('m', 1, 1.15)] }, table).expected).toBe(
      58,
    );
  });

  it('never returns a negative cost', () => {
    const refund = { id: 'refund', order: 1, apply: (m: number) => m - 100 };
    expect(resolveActionCost('talk', { modifiers: [refund] })).toEqual({
      min: 0,
      max: 0,
      expected: 0,
    });
  });

  it('keeps min <= expected <= max even for a non-monotonic modifier', () => {
    const flip = { id: 'flip', order: 1, apply: (m: number) => 100 - m };
    const cost = resolveActionCost('pickLock', { modifiers: [flip] });
    expect(cost.min).toBeLessThanOrEqual(cost.expected);
    expect(cost.expected).toBeLessThanOrEqual(cost.max);
  });

  it('rejects a modifier that returns a non-finite number', () => {
    const broken = { id: 'broken', order: 1, apply: () => Number.NaN };
    expect(() => resolveActionCost('talk', { modifiers: [broken] })).toThrow(RangeError);
  });

  it('does not mutate the context or its modifier list', () => {
    const modifiers = [multiply('b', 2, 2), multiply('a', 1, 2)];
    resolveActionCost('talk', { modifiers });
    expect(modifiers.map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('ACTION_INVALID', () => {
  it.each(['accuse', 'markSuspicion', 'toString', '__proto__', 'constructor', '', 'Move'])(
    'unknown action %j',
    (action) => {
      expect(code(() => resolveActionCost(action as ActionKind))).toBe('ACTION_INVALID');
    },
  );

  it('non-string action', () => {
    expect(code(() => resolveActionCost(42 as unknown as ActionKind))).toBe('ACTION_INVALID');
  });

  it.each<[string, ActionKind, CostContext]>([
    ['move without ctx.travel', 'move', {}],
    ['move with no route', 'move', { travel: { provider: route(null), from: 'a', to: 'b' } }],
    ['fractional route time', 'move', move(2.5)],
    ['negative route time', 'move', move(-1)],
    ['rest for a duration that is not offered', 'rest', { minutes: 90 }],
    ['wait off the step', 'wait', { minutes: 20 }],
    ['wait over the range', 'wait', { minutes: 135 }],
    ['wait under the range', 'wait', { minutes: 0 }],
    ['wait fractional', 'wait', { minutes: 22.5 }],
    ['duration for a fixed-cost action', 'examineLocation', { minutes: 15 }],
    ['negative conversation', 'call', { conversationMinutes: -1 }],
    ['fractional conversation', 'call', { conversationMinutes: 1.5 }],
  ])('%s', (_name, action, ctx) => {
    expect(code(() => resolveActionCost(action, ctx))).toBe('ACTION_INVALID');
  });
});

describe('createActionCostTable', () => {
  it('without overrides equals the defaults', () => {
    expect(createActionCostTable()).toEqual(DEFAULT_ACTION_COSTS);
    expect(createActionCostTable({})).toEqual(DEFAULT_ACTION_COSTS);
  });

  it('overrides single actions and keeps the rest', () => {
    const table = createActionCostTable({
      talk: { base: 12 },
      rest: { choices: [30, 90] },
      wait: { range: [10, 40], step: 10 },
    });
    expect(resolveActionCost('talk', {}, table).expected).toBe(12);
    expect(resolveActionCost('rest', {}, table)).toEqual({ min: 30, max: 90, expected: 30 });
    expect(resolveActionCost('wait', { minutes: 30 }, table).expected).toBe(30);
    expect(resolveActionCost('interrogate', {}, table).expected).toBe(20);
  });

  it('can turn a fixed action into a route action and back', () => {
    const table = createActionCostTable({ examineHotspot: { base: 'graph' } });
    expect(code(() => resolveActionCost('examineHotspot', {}, table))).toBe('ACTION_INVALID');
    expect(resolveActionCost('examineHotspot', move(4), table).expected).toBe(4);
  });

  it('is frozen and does not touch the defaults or alias its input', () => {
    const overrides = { talk: { base: 12 } };
    const table = createActionCostTable(overrides);
    overrides.talk.base = 99;
    expect(table.talk).toEqual({ base: 12 });
    expect(Object.isFrozen(table)).toBe(true);
    expect(DEFAULT_ACTION_COSTS.talk).toEqual({ base: 10 });
  });

  it.each<[string, unknown]>([
    ['unknown action', { dance: { base: 1 } }],
    ['accuse is not a timed action', { accuse: { base: 1 } }],
    ['negative base', { talk: { base: -1 } }],
    ['fractional base', { talk: { base: 1.5 } }],
    ['string base', { talk: { base: '10' } }],
    ['extra field', { talk: { base: 10, bonus: 1 } }],
    ['empty rule', { talk: {} }],
    ['base mixed with choices', { rest: { base: 5, choices: [60] } }],
    ['empty choices', { rest: { choices: [] } }],
    ['unsorted choices', { rest: { choices: [120, 60] } }],
    ['duplicate choices', { rest: { choices: [60, 60] } }],
    ['range from > to', { wait: { range: [60, 15], step: 15 } }],
    ['step that does not reach the end', { wait: { range: [15, 120], step: 20 } }],
    ['zero step', { wait: { range: [15, 120], step: 0 } }],
    ['range without step', { wait: { range: [15, 120] } }],
    ['unknown plus', { call: { base: 5, plus: 'weather' } }],
    ['not an object', 42],
    ['null rule', { talk: null }],
  ])('rejects %s', (_name, overrides) => {
    expect(code(() => createActionCostTable(overrides))).toBe('COST_TABLE_INVALID');
  });
});

describe('with the real LocationGraph', () => {
  const content = loadScenarioFromDir(
    fileURLToPath(new URL('../../../../content/scenarios/_test_minimal', import.meta.url)),
  );
  const graph = new LocationGraph(content);

  it('satisfies TravelTimeProvider structurally', () => {
    expectTypeOf<LocationGraph>().toExtend<TravelTimeProvider>();
  });

  it('prices a move by the graph, with the darkness multiplier on top', () => {
    const ctx = { travel: { provider: graph, from: 'loc_hall', to: 'loc_archive' } };
    expect(resolveActionCost('move', ctx).expected).toBe(2);
    expect(
      resolveActionCost('move', { ...ctx, modifiers: [multiply('darkness', 1, 1.5)] }).expected,
    ).toBe(3);
  });

  it('a route that does not exist (locked door) is ACTION_INVALID', () => {
    const hall = content.locations.find(({ id }) => id === 'loc_hall');
    const archive = content.locations.find(({ id }) => id === 'loc_archive');
    if (!hall || !archive) throw new Error('fixture changed');
    const locked = new LocationGraph({
      preset: content.preset,
      locations: [
        { ...hall, connections: [{ to: archive.id, minutes: 2, locked: { itemId: 'it_key' } }] },
        { ...archive, connections: [] },
      ],
    });
    const ctx = { travel: { provider: locked, from: hall.id, to: archive.id } };
    expect(code(() => resolveActionCost('move', ctx))).toBe('ACTION_INVALID');
  });

  it("lets the provider own its errors: an unknown location is the graph's WorldError", () => {
    const ctx = { travel: { provider: graph, from: 'loc_hall', to: 'loc_nowhere' } };
    expect(code(() => resolveActionCost('move', ctx))).toEqual(
      expect.objectContaining({ code: 'WORLD_UNKNOWN_LOCATION' }),
    );
  });
});
