import { FORBIDDEN_VIEW_KEYS, PhoneView, PlayerView } from '@hs/protocol';
import { expect, test } from 'vitest';
import { tinyManor, tinyManorWithClues } from '../../test/fixtures/tiny-manor.ts';
import { createPhoneState } from '../phone/index.ts';
import { createActionCostTable } from '../time/index.ts';
import { GameEngine } from './engine.ts';

const startLocationId = 'loc_hall';

test('desktop payloads validate and omit the server solution and unseen characters in 100 states', () => {
  for (let index = 0; index < 100; index++) {
    const investigation = tinyManor(String(index));
    const engine = GameEngine.create(investigation, { startLocationId });
    for (let remaining = Math.floor(index / 3) * 15; remaining > 0; remaining -= 120) {
      const minutes = Math.min(remaining, 120);
      expect(engine.dispatch('desktop', { type: 'wait', minutes }).ok).toBe(true);
    }
    const destination = [undefined, 'loc_pantry', 'loc_study'][index % 3];
    if (destination) {
      expect(engine.dispatch('desktop', { type: 'move', locationId: destination }).ok).toBe(true);
    }

    const view = engine.playerView();
    expect(view.presentCharacters.map(({ id }) => id)).toEqual(
      index === 0 ? ['ch_owner', 'ch_porter'] : [],
    );
    const json = JSON.stringify(view);
    expect(PlayerView.parse(JSON.parse(json))).toEqual(view);
    for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}":`);
    const visibleIds = new Set(view.presentCharacters.map(({ id }) => id));
    for (const { id } of investigation.characters) {
      if (!visibleIds.has(id)) expect(json).not.toContain(id);
    }
  }
});

test('known map holds visited locations and the exits shown, nothing else', () => {
  const engine = GameEngine.create(tinyManor(), { startLocationId });
  const first = engine.playerView().knownMap;
  expect(first?.locations.filter(({ visited }) => visited).map(({ id }) => id)).toEqual([
    startLocationId,
  ]);
  const exitIds = engine.playerView().location.exits.map(({ locationId }) => locationId);
  expect(first?.locations.map(({ id }) => id).sort()).toEqual([startLocationId, ...exitIds].sort());
  expect(first?.links.every(({ from }) => from === startLocationId)).toBe(true);

  expect(engine.dispatch('desktop', { type: 'move', locationId: 'loc_study' }).ok).toBe(true);
  const second = engine.playerView().knownMap;
  const visited = second?.locations.filter(({ visited: seen }) => seen).map(({ id }) => id);
  expect(visited?.sort()).toEqual(['loc_hall', 'loc_study']);
  expect(second?.links).toContainEqual({ from: 'loc_hall', to: 'loc_study' });
  expect(second?.links).toContainEqual({ from: 'loc_study', to: 'loc_archive' });
  const restored = GameEngine.restore(engine.snapshot(), tinyManor(), { startLocationId });
  expect(restored.playerView().knownMap).toEqual(second);
  expect(restored.stateHash()).toBe(engine.stateHash());
});

test('clock and action previews reflect the engine, including locked exits and expiration', () => {
  const fixture = tinyManor();
  const investigation = { ...fixture, world: { ...fixture.world, durationMinutes: 25 } };
  const actionCosts = createActionCostTable({ move: { base: 7 }, wait: { choices: [0, 20] } });
  const engine = GameEngine.create(investigation, { startLocationId, actionCosts });
  const initial = engine.playerView();
  expect(initial.clock).toEqual({
    t: 0,
    day: 1,
    time: '08:00',
    period: 'morning',
    remainingMinutes: 25,
  });
  const move = initial.availableActions.find(
    ({ action }) => action.type === 'move' && action.locationId === 'loc_study',
  )!;
  expect(move.costPreview).toEqual({ min: 7, max: 7 });
  expect(engine.dispatch('desktop', move.action).minutesSpent).toBe(7);

  const study = engine.playerView();
  expect(study.location.exits).toContainEqual({
    locationId: 'loc_archive',
    name: 'Archive',
    minutes: 7,
    blockedReason: 'locked',
  });
  expect(study.availableActions.map(({ action }) => action)).toEqual([
    { type: 'move', locationId: 'loc_hall' },
    { type: 'examineLocation' },
    { type: 'rest', minutes: 60 },
    { type: 'wait', minutes: 20 },
  ]);
  expect(engine.dispatch('desktop', { type: 'wait', minutes: 20 }).outcome).toBe('time_expired');
  expect(engine.playerView()).toMatchObject({
    clock: { t: 25, remainingMinutes: 0 },
    availableActions: [],
  });
});

test('QR overlay exposes only the active token, presentation label and remaining time', () => {
  const investigation = tinyManorWithClues();
  const engine = GameEngine.create(investigation, {
    startLocationId: 'loc_study',
    evidenceTokens: { issue: () => 'token', revoke: () => undefined },
  });
  const clue = investigation.clues[0]!;
  engine.requestEvidenceCapture(clue, { action: clue.discovery.action, has: () => true });
  expect(engine.playerView().pendingCapture).toEqual({
    tokenId: 'token',
    clueTitle: 'Фиксация улики',
    expiresInMinutes: 120,
  });
  engine.dispatch('desktop', { type: 'move', locationId: startLocationId });
  expect(engine.playerView().pendingCapture).toBeUndefined();
});

test('an open interrogation holds the hero: no move, rest or pickLock offered; a plain talk keeps them', () => {
  const engine = GameEngine.create(tinyManor(), { startLocationId });
  expect(
    engine.dispatch('desktop', { type: 'talk', characterId: 'ch_owner', topicId: 'self' }).ok,
  ).toBe(true);
  const offered = (e: GameEngine) =>
    new Set(e.playerView().availableActions.map(({ action }) => action.type));
  expect(offered(engine)).toContain('move');
  expect(offered(engine)).toContain('rest');

  const snapshot = structuredClone(engine.snapshot());
  const { interaction } = snapshot.desktop ?? {};
  if (!interaction) throw new Error('no open dialogue');
  interaction.interrogation = true;
  const held = GameEngine.restore(snapshot, tinyManor(), { startLocationId });
  const types = offered(held);
  for (const blocked of ['move', 'rest', 'pickLock']) expect(types).not.toContain(blocked);
  expect(types).toContain('wait');
  // What the view hides, the engine rejects.
  expect(held.dispatch('desktop', { type: 'move', locationId: 'loc_study' })).toMatchObject({
    ok: false,
    blockedReason: 'interrogation_open',
  });
});

test('ENG-008: presentCharacters carry the portraitRef of the character, "" without one', () => {
  const manor = tinyManor('0');
  const investigation = {
    ...manor,
    characters: manor.characters.map((character) =>
      character.id === 'ch_owner' ? { ...character, portraitRef: 'owner.m1' } : character,
    ),
  };
  const view = GameEngine.create(investigation, { startLocationId }).playerView();
  expect(view.presentCharacters.map(({ id, portraitRef }) => [id, portraitRef])).toEqual([
    ['ch_owner', 'owner.m1'],
    ['ch_porter', ''],
  ]);
  // Same investigation, same portraits: the view adds nothing of its own.
  expect(
    GameEngine.create(investigation, { startLocationId }).playerView().presentCharacters,
  ).toEqual(view.presentCharacters);
});

test('ENG-008: the engine projects portraits only for existing phone contacts', () => {
  const manor = tinyManor();
  const investigation = {
    ...manor,
    characters: manor.characters.map((character) => {
      if (character.id === 'ch_owner') return { ...character, portraitRef: 'owner.m1' };
      if (character.id === 'ch_cook') return { ...character, portraitRef: 'cook.f1' };
      return character;
    }),
  };
  const contacts = [
    { id: 'ch_owner', name: 'Owner', number: '101' },
    { id: 'ch_porter', name: 'Porter', number: '102' },
    { id: 'ev_1_a_c', name: 'Unknown', number: '', hallucination: true },
  ];
  const engine = GameEngine.create(investigation, {
    startLocationId,
    phone: { initial: createPhoneState({ contacts }) },
  });
  const view = engine.phoneView();
  expect(PhoneView.parse(view).contacts).toEqual([
    { id: 'ch_owner', name: 'Owner', number: '101', portraitRef: 'owner.m1' },
    { id: 'ch_porter', name: 'Porter', number: '102', portraitRef: '' },
    { id: 'ev_1_a_c', name: 'Unknown', number: '', portraitRef: '' },
  ]);
  const json = JSON.stringify(view);
  for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(JSON.stringify(key) + ':');
  expect(json).not.toContain('cook.f1');
});
