import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadScenarioFromDir } from '../content/index.ts';
import { ItemRegistry } from './index.ts';

const hall = { kind: 'location', id: 'loc_archive' } as const;
const bag = { kind: 'container', id: 'it_bag' } as const;
const owner = { kind: 'character', id: 'ch_anna' } as const;

function content() {
  const loaded = loadScenarioFromDir(fileURLToPath(
    new URL('../../../../content/scenarios/_test_minimal', import.meta.url),
  ));
  return {
    locations: loaded.locations,
    items: [
      ...loaded.items,
      { id: bag.id, name: 'Bag', kind: 'bag', tags: ['storage'], ownerArchetype: 'arch_guard' },
      { id: 'it_key', name: 'Key', kind: 'key', tags: [], containerId: bag.id },
    ],
  };
}

test('loads and tracks one direct placement and the ordered move history', () => {
  const items = new ItemRegistry(content(), new Map([['arch_guard', owner.id]]), -20);
  expect(items.get(bag.id)).toEqual({ id: bag.id, kind: 'bag', tags: ['storage'] });
  expect(items.locate('it_key', -20)).toEqual(bag);
  expect(items.locate(bag.id, -20)).toEqual(owner);
  items.move('it_key', hall, -2, 'ev_1');
  items.move('it_key', owner, 0, 'ev_2');
  items.move('it_key', bag, 0, 'ev_3');

  expect(items.locate('it_key', -3)).toEqual(bag);
  expect(items.locate('it_key', -2)).toEqual(hall);
  expect(items.locate('it_key', 0)).toEqual(bag);
  expect(items.history('it_key')).toEqual([
    { t: -2, to: hall, cause: 'ev_1' },
    { t: 0, to: owner, cause: 'ev_2' },
    { t: 0, to: bag, cause: 'ev_3' },
  ]);
});

test('rejects initial and runtime cycles and preserves state on rejection', () => {
  const loaded = content();
  expect(() => new ItemRegistry({
    ...loaded,
    items: loaded.items.map((item) => item.id === bag.id
      ? { id: bag.id, name: 'Bag', kind: 'bag', tags: [], containerId: 'it_key' }
      : item),
  })).toThrow(expect.objectContaining({ code: 'WORLD_CONTAINER_CYCLE' }));

  const items = new ItemRegistry(loaded, new Map([['arch_guard', owner.id]]));
  expect(() => items.move(bag.id, bag, 100, 'ev_1')).toThrow(
    expect.objectContaining({ code: 'WORLD_CONTAINER_CYCLE' }),
  );
  expect(() => items.move(bag.id, { kind: 'container', id: 'it_key' }, 100, 'ev_2')).toThrow(
    expect.objectContaining({ code: 'WORLD_CONTAINER_CYCLE' }),
  );
  expect(items.history(bag.id)).toEqual([]);
  expect(items.locate(bag.id, 100)).toEqual(owner);
  items.move('it_key', hall, 5, 'ev_3');
  expect(() => items.move(bag.id, { kind: 'container', id: 'it_key' }, 4, 'ev_4')).toThrow(
    expect.objectContaining({ code: 'WORLD_INVALID_ITEM_TIME' }),
  );
  items.move(bag.id, { kind: 'container', id: 'it_key' }, 5, 'ev_5');
  expect(items.locate(bag.id, 4)).toEqual(owner);
});

test('rejects missing owners and unknown destinations', () => {
  expect(() => new ItemRegistry(content())).toThrow(
    expect.objectContaining({ code: 'WORLD_INVALID_PLACEMENT' }),
  );
  const items = new ItemRegistry(content(), new Map([['arch_guard', owner.id]]));
  expect(() => items.move('it_key', { kind: 'location', id: 'missing' }, 1, 'ev_1')).toThrow(
    expect.objectContaining({ code: 'WORLD_INVALID_PLACEMENT' }),
  );
  expect(() => items.move('it_key', { kind: 'container', id: 'missing' }, 1, 'ev_1')).toThrow(
    expect.objectContaining({ code: 'WORLD_UNKNOWN_ITEM' }),
  );
});
