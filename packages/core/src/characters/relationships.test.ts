import fc from 'fast-check';
import { expect, test } from 'vitest';
import { RelationshipGraph } from './index.ts';

const base = { a: 'ch_anna', b: 'ch_igor', trust: 0, valence: 0.5, intensity: 0.5 };

test('symmetric relationships share scores and adjustment history in both directions', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('sibling', 'spouse', 'romance', 'friendship', 'rivalry', 'past_conflict'),
      fc.array(fc.tuple(fc.integer({ min: -5, max: 5 }), fc.boolean()), { minLength: 1 }),
      (type, changes) => {
        const graph = new RelationshipGraph([{ ...base, type }]);
        const causes: string[] = [];
        for (const [amount, reverse] of changes) {
          const [a, b] = reverse ? [base.b, base.a] : [base.a, base.b];
          const cause = `ev_${causes.length}`;
          causes.push(cause);
          graph.adjust(a, b, { trust: amount, valence: amount }, cause);
          const forward = graph.get(base.a, base.b);
          expect(graph.get(base.b, base.a)).toEqual({ ...forward, a: base.b, b: base.a });
          expect(forward?.history).toEqual(causes);
          expect(forward?.trust).toBeGreaterThanOrEqual(-1);
          expect(forward?.trust).toBeLessThanOrEqual(1);
          expect(forward?.valence).toBeGreaterThanOrEqual(0);
          expect(forward?.valence).toBeLessThanOrEqual(1);
        }
      },
    ),
    { seed: 2002 },
  );
});

test('parent and child are inverse views while debt and employment stay directed', () => {
  const graph = new RelationshipGraph([
    { ...base, type: 'parent' },
    { ...base, type: 'debt' },
    { ...base, type: 'employment' },
  ]);
  expect(graph.get(base.b, base.a)?.type).toBe('child');
  expect(graph.get(base.b, base.a, 'debt')).toBeUndefined();
  expect(graph.get(base.b, base.a, 'employment')).toBeUndefined();
  expect(graph.neighbors(base.a).map(({ type }) => type)).toEqual(['parent', 'debt', 'employment']);
  expect(graph.byType('child')).toEqual([graph.get(base.b, base.a, 'child')]);
  expect(graph.byType('blackmail')).toEqual([]);
  graph.adjust(base.b, base.a, { trust: 5 }, 'ev_1', 'child');
  expect(graph.get(base.a, base.b, 'parent')).toMatchObject({ trust: 1, history: ['ev_1'] });
  expect(graph.get(base.a, base.b, 'debt')).toMatchObject({ trust: 0, history: [] });
});

test('clamps initial scores and returns detached history', () => {
  const history = ['ev_0'];
  const graph = new RelationshipGraph([
    { ...base, type: 'friendship', trust: -5, valence: 5, intensity: -1, history },
  ]);
  history.push('ev_external');
  const before = graph.get(base.a, base.b);
  graph.adjust(base.a, base.b, { trust: 5, valence: -5 }, 'ev_1');
  expect(before).toMatchObject({ trust: -1, valence: 1, intensity: 0, history: ['ev_0'] });
  expect(graph.get(base.a, base.b)).toMatchObject({
    trust: 1,
    valence: 0,
    history: ['ev_0', 'ev_1'],
  });
});

test('rejects duplicates, self edges and invalid adjustments without changing the graph', () => {
  const graph = new RelationshipGraph([{ ...base, type: 'spouse' }]);
  expect(() => graph.add({ ...base, a: base.b, b: base.a, type: 'spouse' })).toThrow(RangeError);
  expect(() => graph.add({ ...base, b: base.a, type: 'friendship' })).toThrow(RangeError);
  expect(() => graph.adjust(base.a, base.b, { trust: 1, valence: NaN }, 'ev_1')).toThrow(
    RangeError,
  );
  expect(() => graph.adjust(base.a, 'ch_other', {}, 'ev_2')).toThrow(RangeError);
  expect(graph.get(base.a, base.b)).toMatchObject({ trust: 0, valence: 0.5, history: [] });
  expect(graph.byType('spouse')).toHaveLength(2);
});
