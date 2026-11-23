import { fileURLToPath } from 'node:url';
import { stateHash } from '@hs/core/common';
import { crossCheck, loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { expect, test } from 'vitest';
import { runPipeline, worldGen } from '../index.ts';

const root = new URL('../../../../content/scenarios/', import.meta.url);
const minimal = loadScenarioFromDir(fileURLToPath(new URL('_test_minimal/', root)));
const sanatorium = loadScenarioFromDir(fileURLToPath(new URL('sanatorium_winter/', root)));
const owners = new Map([
  ['caretaker', 'ch_caretaker'],
  ['head_doctor', 'ch_doctor'],
  ['nurse', 'ch_nurse'],
]);

function generate(content: ScenarioContent, seed: string) {
  const result = runPipeline([worldGen], undefined, { content, seed, now: () => 0 });
  if (!result.ok) throw new Error('Expected WorldGen to succeed');
  return result.output;
}

test('golden world snapshots for three seeds of _test_minimal', () => {
  const content = structuredClone(minimal);
  content.preset.world = {
    variants: [
      { id: 'base' },
      { id: 'closed', doors: [{ from: 'loc_archive', to: 'loc_hall', locked: {} }] },
      {
        id: 'moved',
        spawns: [{ itemId: 'it_log', placement: { kind: 'location', id: 'loc_hall' } }],
      },
    ],
  };
  const hashes = ['0', '1', '2'].map((seed) => {
    const draft = generate(content, seed);
    const world = draft.createWorldState();
    return [
      draft.variantId,
      stateHash({
        start: draft.startLocationId,
        duration: world.durationMinutes,
        graph: world.locations.snapshot(),
        items: world.items.snapshot(),
      }),
    ];
  });
  expect(hashes).toEqual([
    ['base', '8d630f7c5dadbe7f6d4d15a49a54d4aebec87dc4bdef17dfd1e393fc5206671c'],
    ['closed', '90452ee075af4deb0f5979d18e3ba44576730a531b5a96a4df25ffdd414583a2'],
    ['moved', '82ddd4c4d34ae88d7476af88fdce7a44b61621d9b18058c7108c8001f37f222b'],
  ]);
});

test('500 seeds preserve reachability and deferred item ownership in the sanatorium', () => {
  const content = structuredClone(sanatorium);
  content.preset.world = {
    startLocationId: 'loc_hall',
    variants: [
      { id: 'base' },
      {
        id: 'open_archive',
        doors: [{ from: 'loc_doctor_office', to: 'loc_archive', locked: null }],
      },
    ],
  };
  const choices = new Set<string | undefined>();
  const itemIds = new Set(content.items.map(({ id }) => id));
  const start = content.preset.time.historyStartMinutes;
  for (let seed = 0; seed < 500; seed++) {
    const draft = generate(content, String(seed));
    choices.add(draft.variantId);
    for (const { id } of content.locations) {
      expect(draft.locations.travelTime(draft.startLocationId, id, { itemIds })).not.toBeNull();
    }
    const world = draft.createWorldState(owners);
    expect(world.items.locate('it_key_boiler', start)).toEqual({
      kind: 'character',
      id: 'ch_caretaker',
    });
    expect(world.items.snapshot().initial).toHaveLength(content.items.length);
    expect(Boolean(draft.locations.directConnection('loc_doctor_office', 'loc_archive'))).toBe(
      draft.variantId === 'open_archive',
    );
  }
  expect(choices).toEqual(new Set(['base', 'open_archive']));
  expect(() => generate(content, 'no owners').createWorldState()).toThrow(/Unresolved owner/);
});

test('invalid references and disconnected variants are rejected', () => {
  const content = structuredClone(minimal);
  content.preset.world = {
    variants: [{ id: 'closed', doors: [{ from: 'loc_hall', to: 'loc_archive', locked: {} }] }],
  };
  expect(() => generate(content, 'disconnected')).toThrow(/Unreachable location/);
  content.preset.world.startLocationId = 'loc_missing';
  expect(crossCheck(content)).toContainEqual(
    expect.objectContaining({
      code: 'CONTENT_DANGLING_REF',
      path: 'preset.world.startLocationId',
    }),
  );
});
