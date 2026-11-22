import { PhoneView, PlayerView } from '@hs/protocol';
import { expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { whereShouldBe } from '../characters/index.ts';
import { stateHash } from '../common/index.ts';
import { Calendar } from '../time/index.ts';
import {
  deserializeInvestigation,
  InvestigationBuilder,
  serializeInvestigation,
  snapshotInvestigation,
} from './index.ts';

const builder = () =>
  new InvestigationBuilder({ scenarioId: 'tiny-manor', seed: 'test', generatorVersion: '0.1.0' });
const load = (data: unknown) => deserializeInvestigation(JSON.stringify(data));
const snapshot = () => snapshotInvestigation(tinyManor());

test('the builder checks required components and valid character schedules', () => {
  const { world, characters, truth } = tinyManor();
  const draft = builder();
  expect(() => draft.build()).toThrow(/world.*characters.*truth/);
  expect(() => draft.withWorld(world).withTruth(truth).build()).toThrow(/characters/);
  expect(() => draft.withCharacters([...characters, ...characters]).build()).toThrow(
    /Duplicate character/,
  );
  const cast = characters.map((character) => ({ ...character, secrets: [] }));
  expect(() =>
    draft.withCharacters(cast.map((character) => ({ ...character, routine: [] }))).build(),
  ).toThrow(/CHAR_SCHEDULE_GAP/);
  expect(draft.withCharacters(cast).build()).toMatchObject({
    scenarioId: 'tiny-manor',
    seed: 'test',
    secrets: [],
  });
});

test('repeated builds have independent relationships and character routines', () => {
  const { world, characters, relationships, truth, secrets } = tinyManor();
  const draft = builder()
    .withWorld(world)
    .withCharacters(characters)
    .withRelationships(relationships)
    .withTruth(truth)
    .withSecrets(secrets);
  const first = draft.build();
  first.relationships.adjust('ch_owner', 'ch_bursar', { trust: 0.1 }, 'ev_1', 'debt');
  first.characters[0]?.routine.pop();

  const second = draft.build();
  expect(second.relationships.get('ch_owner', 'ch_bursar')?.trust).toBe(-0.5);
  expect(second.characters[0]?.routine).toHaveLength(2);
});

test('canonical bytes and state hash survive a round trip', () => {
  const initial = tinyManor();
  const json = serializeInvestigation(initial);
  const restored = deserializeInvestigation(json);
  expect(serializeInvestigation(tinyManor())).toBe(json);
  expect(serializeInvestigation(restored)).toBe(json);
  expect(stateHash(snapshotInvestigation(restored))).toBe(
    stateHash(snapshotInvestigation(initial)),
  );
  expect(serializeInvestigation(tinyManor('another-seed'))).not.toBe(json);
});

test('restores locked routes, item locations and shared relationship scores', () => {
  const { world, relationships } = load(snapshot());
  const keys = { itemIds: new Set(['it_study_key']) };
  expect(world.locations.travelTime('loc_study', 'loc_archive')).toBeNull();
  expect(world.locations.travelTime('loc_study', 'loc_archive', keys)).toBe(4);
  expect(world.locations.isAccessible('loc_archive', keys, 0)).toEqual({ ok: true });
  expect(world.items.locate('it_ledger', -21)).toEqual({ kind: 'location', id: 'loc_study' });
  expect(world.items.locate('it_ledger', -18)).toEqual({ kind: 'character', id: 'ch_bursar' });
  expect(world.items.locate('it_ledger', 0)).toEqual({ kind: 'container', id: 'it_trunk' });

  relationships.adjust('ch_cook', 'ch_porter', { trust: 0.1 }, 'ev_2', 'friendship');
  expect(relationships.get('ch_porter', 'ch_cook')).toMatchObject({
    trust: 0.6,
    history: ['ev_2'],
  });
});

test('retains event ids and indexes when chronological order differs from append order', () => {
  const initial = tinyManor();
  const event = initial.truth.events().at(-1);
  if (!event) throw new Error('Missing fixture event');
  const { id, ...payload } = event;
  initial.truth.append({ ...payload, t: -51, targets: [], causes: [], facts: [] });

  const { truth, secrets } = load(snapshotInvestigation(initial));
  expect(truth.events()[1]?.id).toBe('ev_9');
  expect(truth.causalChain(id)).toEqual(['ev_1', 'ev_5', 'ev_6', 'ev_7']);
  expect(truth.whereWas('ch_bursar', -23)).toBe('in_transit');
  expect(truth.append({ ...payload, t: 5, causes: [id], facts: [] })).toBe('ev_10');
  expect(initial.truth.events()).toHaveLength(9);
  expect(secrets[0]?.knownBy).toEqual(['ch_owner', 'ch_bursar']);
});

test('preserves cross-item move order within one minute and relationship lookup precedence', () => {
  const investigation = tinyManor();
  const { items } = investigation.world;
  items.move('it_ledger', { kind: 'location', id: 'loc_archive' }, 0, 'ev_8');
  items.move('it_trunk', { kind: 'container', id: 'it_ledger' }, 0, 'ev_8');
  investigation.relationships.add({
    a: 'ch_owner',
    b: 'ch_bursar',
    type: 'employment',
    trust: 1,
    valence: 1,
    intensity: 0,
  });
  const restored = load(snapshotInvestigation(investigation));
  expect(restored.world.items.locate('it_trunk', 0)).toEqual({
    kind: 'container',
    id: 'it_ledger',
  });
  expect(restored.relationships.get('ch_owner', 'ch_bursar')?.type).toBe('debt');
  expect(() =>
    restored.world.items.move('it_ledger', { kind: 'location', id: 'loc_archive' }, -1, 'ev_8'),
  ).toThrow(/before minute/);
});

test('rejects invalid JSON and malformed snapshot fields', () => {
  const data = snapshot();
  expect(() => deserializeInvestigation('{')).toThrow(/INVESTIGATION_INVALID/);
  expect(() => load({ ...data, seed: undefined })).toThrow(/seed/);
  expect(() => load({ ...data, generatorVersion: '' })).toThrow(/generatorVersion/);
  expect(() => load({ ...data, culpritIds: [] })).toThrow(/culpritIds/);
  expect(() => load({ ...data, truth: { incident: null, events: [] } })).toThrow(/incident/);
});

test('rejects dangling secret, character and location references', () => {
  const data = snapshot();
  expect(() => load({ ...data, secrets: [] })).toThrow(/Unknown secret/);
  const relationship = data.relationships[0];
  if (!relationship) throw new Error('Missing fixture relationship');
  expect(() => load({ ...data, relationships: [{ ...relationship, b: 'ch_missing' }] })).toThrow(
    /Unknown character ch_missing/,
  );
  data.world.locations[0]?.connections.push({ to: 'loc_missing', minutes: 1 });
  expect(() => load(data)).toThrow(/Unknown location loc_missing/);
});

test('rejects a container cycle introduced in the serialized history', () => {
  const data = snapshot();
  data.world.items.moves.push({
    itemId: 'it_trunk',
    t: -10,
    to: { kind: 'container', id: 'it_ledger' },
    cause: 'ev_8',
  });
  expect(() => load(data)).toThrow(/Container cycle/);
});

test('the client schemas reject the server snapshot because it contains truth and secrets', () => {
  const data = snapshot();
  expect(data).toHaveProperty('truth.incident.culpritIds', ['ch_bursar']);
  for (const schema of [PlayerView, PhoneView]) {
    const issues = schema.safeParse(data).error?.issues;
    const extraKeys = issues?.find((issue) => issue.code === 'unrecognized_keys')?.keys;
    expect(extraKeys).toEqual(expect.arrayContaining(['truth', 'secrets']));
  }
});

test('tiny-manor establishes opportunity, motive and the item trail across eight events', () => {
  const { world, characters, relationships, truth } = tinyManor();
  expect(world.locations.snapshot().locations).toHaveLength(4);
  expect(characters).toHaveLength(4);
  expect(truth.events()).toHaveLength(8);
  expect(truth.incident).toMatchObject({
    type: 'theft',
    culpritIds: ['ch_bursar'],
    victimIds: ['ch_owner'],
    keyEventIds: ['ev_6', 'ev_8'],
  });
  expect(truth.facts({ kind: 'motive' })).toContainEqual(
    expect.objectContaining({ who: 'ch_bursar', against: 'ch_owner', motiveType: 'conceal_debt' }),
  );
  expect(truth.whoWasAt('loc_study', { from: -20, to: -18 })).toEqual(['ch_bursar']);
  expect(truth.whereWas('ch_owner', -20)).toBe('loc_hall');
  expect(truth.possession('it_ledger')).toEqual([
    { holder: 'ch_bursar', interval: { from: -20, to: -10 } },
  ]);
  expect(world.items.history('it_ledger').map(({ cause }) => cause)).toEqual(['ev_6', 'ev_8']);
  expect(relationships.get('ch_owner', 'ch_bursar', 'debt')?.history).toEqual(['ev_1']);
  const clock = new Calendar(world.locations.startDateTime);
  expect(characters.map((character) => whereShouldBe(character, 0, [], clock).location)).toEqual([
    'loc_hall',
    'loc_archive',
    'loc_pantry',
    'loc_hall',
  ]);
});
