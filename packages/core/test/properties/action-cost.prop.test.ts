import { ACTION_KINDS, resolveActionCost, type CostModifier } from '@hs/core/time';
import fc from 'fast-check';
import { expect, test } from 'vitest';

const modifier = fc.record({
  id: fc.string({ minLength: 1, maxLength: 4 }),
  order: fc.integer({ min: 0, max: 5 }),
  factor: fc.double({ min: 0.1, max: 4, noNaN: true }),
  extra: fc.integer({ min: -20, max: 20 }),
});
type ModifierSpec = { id: string; order: number; factor: number; extra: number };
const toModifier = ({ id, order, factor, extra }: ModifierSpec): CostModifier => ({
  id,
  order,
  apply: (minutes) => minutes * factor + extra,
});

// Valid context for every action, so the property can range over all of them.
const ctxFor = (action: string) =>
  action === 'move'
    ? { travel: { provider: { travelTime: () => 7 }, from: 'a', to: 'b' } }
    : action === 'rest'
      ? { minutes: 120 }
      : action === 'wait'
        ? { minutes: 45 }
        : {};

test('any modifiers give whole, non-negative, ordered minutes', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ACTION_KINDS),
      fc.array(modifier, { maxLength: 6 }),
      (action, specs) => {
        const cost = resolveActionCost(action, {
          ...ctxFor(action),
          modifiers: specs.map(toModifier),
        });
        for (const value of [cost.min, cost.expected, cost.max]) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
        expect(cost.min).toBeLessThanOrEqual(cost.expected);
        expect(cost.expected).toBeLessThanOrEqual(cost.max);
      },
    ),
    { seed: 42 },
  );
});

test('the result does not depend on the order modifiers are listed in', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ACTION_KINDS),
      fc.uniqueArray(modifier, { maxLength: 6, selector: ({ id }) => id }),
      fc.nat(),
      (action, specs, shift) => {
        const modifiers = specs.map(toModifier);
        const rotated = modifiers.map(
          (_, i) => modifiers[(i + shift) % modifiers.length] as CostModifier,
        );
        const ctx = ctxFor(action);
        expect(resolveActionCost(action, { ...ctx, modifiers: rotated })).toEqual(
          resolveActionCost(action, { ...ctx, modifiers }),
        );
      },
    ),
    { seed: 42 },
  );
});

test('without modifiers the cost is the base cost, and a modifier-free range is ordered', () => {
  fc.assert(
    fc.property(fc.constantFrom(...ACTION_KINDS), (action) => {
      const cost = resolveActionCost(action, ctxFor(action));
      expect(cost.min).toBeLessThanOrEqual(cost.max);
      expect(resolveActionCost(action, { ...ctxFor(action), modifiers: [] })).toEqual(cost);
    }),
    { seed: 42 },
  );
});
