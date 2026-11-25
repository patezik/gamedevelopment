import { FORBIDDEN_VIEW_KEYS, PlayerView } from '@hs/protocol';
import { expect, test } from 'vitest';
import { tinyManor, tinyManorWithClues } from '../../test/fixtures/tiny-manor.ts';
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
