import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { GameEngine } from './engine.ts';
import { deserializeInvestigation } from './investigation.ts';

const ports = { startLocationId: 'loc_hall' };

describe('GameEngine', () => {
  test('rejects unavailable moves and invalid role or duration without changing state', () => {
    const engine = GameEngine.create(tinyManor(), ports);
    const before = engine.stateHash();

    expect(engine.dispatch('desktop', { type: 'move', locationId: 'loc_archive' })).toMatchObject({
      ok: false,
      error: 'ACTION_NOT_AVAILABLE',
      minutesSpent: 0,
    });
    expect(engine.dispatch('phone', { type: 'wait', minutes: 15 })).toMatchObject({
      ok: false,
      error: 'ACTION_INVALID',
    });
    expect(engine.dispatch('desktop', { type: 'wait', minutes: 16 })).toMatchObject({
      ok: false,
      error: 'ACTION_INVALID',
    });
    expect(engine.stateHash()).toBe(before);
  });

  test('moves and waits using action costs, records the player, and restores deterministically', () => {
    const investigation = tinyManor();
    const originalEventCount = investigation.truth.events().length;
    const engine = GameEngine.create(investigation, ports);

    expect(engine.dispatch('desktop', { type: 'move', locationId: 'loc_study' })).toMatchObject({
      ok: true,
      minutesSpent: 3,
    });
    expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 })).toMatchObject({
      ok: true,
      minutesSpent: 15,
    });
    const snapshot = engine.snapshot();
    expect(snapshot).toMatchObject({ locationId: 'loc_study', minute: 18 });
    expect(investigation.truth.events()).toHaveLength(originalEventCount);
    expect(deserializeInvestigation(snapshot.investigation).truth.events().slice(-2)).toMatchObject(
      [
        { verb: 'move', actorIds: ['player'] },
        { verb: 'wait', actorIds: ['player'] },
      ],
    );

    const restored = GameEngine.restore(snapshot, investigation, ports);
    expect(restored.stateHash()).toBe(engine.stateHash());
    const wait = { type: 'wait', minutes: 15 } as const;
    expect(restored.dispatch('desktop', wait)).toEqual(engine.dispatch('desktop', wait));
    expect(restored.stateHash()).toBe(engine.stateHash());
  });
});
