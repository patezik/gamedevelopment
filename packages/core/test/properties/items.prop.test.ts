import fc from 'fast-check';
import { expect, test } from 'vitest';
import { loadScenarioFromDir } from '@hs/core/content';
import { ItemRegistry } from '@hs/core/world';
import { fileURLToPath } from 'node:url';

const content = loadScenarioFromDir(fileURLToPath(
  new URL('../../../../content/scenarios/_test_minimal', import.meta.url),
));
const initial = { kind: 'location', id: 'loc_archive' } as const;
const destinations = [
  initial,
  { kind: 'location', id: 'loc_hall' },
  { kind: 'character', id: 'ch_anna' },
] as const;

test('ordered moves always determine exactly one placement for each item and minute', () => {
  const ids = ['it_log', 'it_copy'];
  const moves = fc.array(fc.record({
    id: fc.constantFrom(...ids),
    to: fc.constantFrom(...destinations),
    elapsed: fc.integer({ min: 0, max: 5 }),
  }), { maxLength: 40 });

  fc.assert(fc.property(moves, (steps) => {
    const registry = new ItemRegistry({
      locations: content.locations,
      items: ids.map((id) => ({ id, name: id, kind: 'document', tags: [], locationId: initial.id })),
    });

    let minute = 0;
    const timeline = steps.map(({ id, to, elapsed }, index) => {
      minute += elapsed;
      const cause = `ev_${index + 1}`;
      registry.move(id, to, minute, cause);
      return { id, t: minute, to, cause };
    });

    for (const id of ids) {
      const history = timeline.filter((move) => move.id === id);
      expect(registry.history(id)).toEqual(history.map(({ t, to, cause }) => ({ t, to, cause })));
      for (let t = 0; t <= minute + 1; t++) {
        const expected = history.filter((move) => move.t <= t).at(-1)?.to ?? initial;
        expect(registry.locate(id, t)).toEqual(expected);
      }
    }
  }), { seed: 42 });
});
