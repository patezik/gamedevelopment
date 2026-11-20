import { validateRoutine, whereShouldBe, type RoutineBlock } from '@hs/core/characters';
import { Calendar } from '@hs/core/time';
import fc from 'fast-check';
import { expect, test } from 'vitest';

const calendar = new Calendar('2026-01-14T00:00');

test('generated partitions cover every minute of the day exactly once', () => {
  const cuts = fc.uniqueArray(fc.integer({ min: 0, max: 1439 }), { minLength: 2, maxLength: 16 });
  fc.assert(fc.property(cuts, (points) => {
    const sorted = points.toSorted((a, b) => a - b);
    const routine = sorted.map((from, index): RoutineBlock => ({
      from,
      to: sorted[(index + 1) % sorted.length]!,
      location: `loc_${index}`,
      activity: 'stay',
      flexibility: 0,
    })).reverse();
    const character = { id: 'ch_generated', routine };

    validateRoutine(character);
    for (let minute = 0; minute < 1440; minute++) {
      const expected = sorted.findLastIndex((from) => from <= minute);
      const index = expected < 0 ? sorted.length - 1 : expected;
      expect(whereShouldBe(character, minute, [], calendar).location).toBe(`loc_${index}`);
    }
  }), { seed: 42 });
});
