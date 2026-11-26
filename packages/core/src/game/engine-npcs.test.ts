import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { GameEngine, type DispatchResult, type EnginePorts, type GameSnapshot } from './engine.ts';
import { PlayerReactions } from '../simulation/index.ts';
import {
  deserializeInvestigation,
  serializeInvestigation,
  type Investigation,
} from './investigation.ts';

const off: EnginePorts = { startLocationId: 'loc_hall' };
const on: EnginePorts = { ...off, npcSimulation: true };
const MAX_WAIT = 15;
/** Waits in steps of at most `MAX_WAIT` minutes; returns the last result. */
function wait(engine: GameEngine, minutes = 10): DispatchResult {
  let left = minutes;
  let result: DispatchResult;
  do {
    const step = Math.min(left, MAX_WAIT);
    result = engine.dispatch('desktop', { type: 'wait', minutes: step });
    left -= step;
  } while (left > 0 && result.ok);
  return result;
}
const here = (engine: GameEngine): string[] =>
  engine
    .playerView()
    .presentCharacters.map(({ id }) => id)
    .sort();

/** The porter leaves the hall for the pantry one hour into the game (08:00 + 60 = 09:00). */
function manorWithPorterMoving(): Investigation {
  const snapshot = JSON.parse(serializeInvestigation(tinyManor())) as {
    characters: { id: string; routine: unknown }[];
  };
  const porter = snapshot.characters.find(({ id }) => id === 'ch_porter')!;
  porter.routine = [
    { from: 0, to: 540, location: 'loc_hall', activity: 'porter', flexibility: 0.2 },
    { from: 540, to: 1440, location: 'loc_pantry', activity: 'porter', flexibility: 0.2 },
  ];
  return deserializeInvestigation(JSON.stringify(snapshot));
}

describe('characters in the engine (ENG-014)', () => {
  test('off by default: nobody is added after minute 0 and the snapshot is unchanged', () => {
    const engine = GameEngine.create(tinyManor(), off);
    wait(engine, 30);
    expect(here(engine)).toEqual([]);
    expect(engine.snapshot()).not.toHaveProperty('simulation');
    expect(
      engine.dispatch('desktop', { type: 'talk', characterId: 'ch_owner', topicId: 'self' }),
    ).toMatchObject({ ok: false, error: 'ACTION_NOT_AVAILABLE' });
  });

  test('characters stay where their routine puts them and can be talked to', () => {
    const engine = GameEngine.create(tinyManor(), on);
    expect(here(engine)).toEqual(['ch_owner', 'ch_porter']);
    wait(engine, 120);
    expect(here(engine)).toEqual(['ch_owner', 'ch_porter']);
    const talk = engine.dispatch('desktop', {
      type: 'talk',
      characterId: 'ch_porter',
      topicId: 'self',
    });
    expect(talk.ok).toBe(true);
  });

  test('a character walks to the next block of the routine and leaves the room', () => {
    const engine = GameEngine.create(manorWithPorterMoving(), on);
    wait(engine, 30);
    expect(here(engine)).toContain('ch_porter');
    wait(engine, 40);
    expect(here(engine)).toEqual(['ch_owner']);
    expect(engine.dispatch('desktop', { type: 'move', locationId: 'loc_pantry' }).ok).toBe(true);
    expect(here(engine)).toEqual(['ch_cook', 'ch_porter']);
    expect(
      engine.dispatch('desktop', { type: 'talk', characterId: 'ch_porter', topicId: 'self' }).ok,
    ).toBe(true);
  });

  test('a character who died before the start never appears again', () => {
    const investigation = tinyManor();
    investigation.truth.append({
      t: -3,
      duration: 0,
      verb: 'die',
      actorIds: ['ch_cook'],
      location: 'loc_pantry',
      targets: [],
      causes: [],
      facts: [
        {
          kind: 'state',
          entity: { kind: 'character', id: 'ch_cook' },
          property: 'alive',
          value: false,
          interval: { from: -3, to: 0 },
        },
      ],
      traceIds: [],
      visibility: 'public',
    });
    const engine = GameEngine.create(investigation, on);
    wait(engine, 30);
    engine.dispatch('desktop', { type: 'move', locationId: 'loc_pantry' });
    expect(here(engine)).toEqual([]);
  });

  test('those present remember what the hero did; the view shows none of it', () => {
    const engine = GameEngine.create(tinyManor(), on);
    wait(engine, 20);
    const saved = engine.snapshot().simulation!;
    const memory = (id: string) => saved.agents.find(({ characterId }) => characterId === id)!;
    expect(memory('ch_porter').knowledge).toContain('"who":"player"');
    expect(memory('ch_cook').knowledge).not.toContain('"who":"player"');
    const view = JSON.stringify(engine.playerView());
    expect(view).not.toContain('rngState');
    expect(view).not.toContain('knowledge');
  });

  test('restores from a snapshot in the middle of a walk and then behaves the same', () => {
    const investigation = manorWithPorterMoving();
    const engine = GameEngine.create(investigation, on);
    wait(engine, 59);
    const snapshot = JSON.parse(JSON.stringify(engine.snapshot())) as GameSnapshot;
    expect(snapshot.simulation?.agents).toHaveLength(4);
    const restored = GameEngine.restore(snapshot, investigation, on);
    expect(restored.stateHash()).toBe(engine.stateHash());
    for (const minutes of [1, 1, 3, 15, 7, 60]) {
      expect(wait(restored, minutes)).toEqual(wait(engine, minutes));
      expect(restored.stateHash()).toBe(engine.stateHash());
    }
    expect(here(restored)).toEqual(here(engine));
  });

  test('PlayerReactions fed through ports.simulation sees what the present characters saw', () => {
    const reactions = new PlayerReactions({
      topicSensitivity: (id) => (id === 'ch_porter' ? 0.8 : 0),
      closeTo: () => [],
    });
    const ports: EnginePorts = { ...on, simulation: reactions };
    const engine = GameEngine.create(tinyManor(), ports);
    expect(reactions.wariness('ch_porter')).toBe(0);
    engine.dispatch('desktop', { type: 'talk', characterId: 'ch_porter', topicId: 'self' });
    expect(reactions.wariness('ch_porter')).toBeCloseTo(0.8);
    expect(reactions.wariness('ch_owner')).toBe(0);
    // The reactions are the world's memory, not part of the state of the engine.
    expect(engine.stateHash()).toBe(
      (() => {
        const twin = GameEngine.create(tinyManor(), on);
        twin.dispatch('desktop', { type: 'talk', characterId: 'ch_porter', topicId: 'self' });
        return twin.stateHash();
      })(),
    );
  });

  test('restores a snapshot taken at minute 0', () => {
    const investigation = tinyManor();
    const engine = GameEngine.create(investigation, on);
    const restored = GameEngine.restore(engine.snapshot(), investigation, on);
    expect(restored.stateHash()).toBe(engine.stateHash());
    expect(wait(restored, 45)).toEqual(wait(engine, 45));
    expect(restored.stateHash()).toBe(engine.stateHash());
  });

  test('a snapshot made without the port starts the routines where the truth left them', () => {
    const investigation = tinyManor();
    const plain = GameEngine.create(investigation, off);
    wait(plain, 30);
    const old = plain.snapshot();
    expect(old).not.toHaveProperty('simulation');
    const restored = GameEngine.restore(old, investigation, on);
    expect(here(restored)).toEqual(['ch_owner', 'ch_porter']);
    wait(restored, 30);
    expect(here(restored)).toEqual(['ch_owner', 'ch_porter']);
  });
});
