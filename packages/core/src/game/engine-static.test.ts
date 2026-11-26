import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { createPhoneState } from '../phone/index.ts';
import { GameEngine, type DispatchResult, type EnginePorts } from './engine.ts';

const base: EnginePorts = { startLocationId: 'loc_hall' };
const withStatic = (start?: number): EnginePorts => ({
  ...base,
  static: start === undefined ? {} : { start },
});
const wait = (engine: GameEngine, minutes = 15): DispatchResult =>
  engine.dispatch('desktop', { type: 'wait', minutes });
/** Waits `hours` hours in 15-minute steps and returns every event. */
const waitHours = (engine: GameEngine, hours: number) =>
  Array.from({ length: hours * 4 }, () => wait(engine)).flatMap(({ events }) => events);

describe('Static in the engine (ENG-010)', () => {
  test('is off without ports.static: level 0, no state, same snapshot shape', () => {
    const engine = GameEngine.create(tinyManor(), base);
    waitHours(engine, 3);
    expect(engine.playerView().static).toBe(0);
    expect(engine.staticLevel()).toBe(0);
    expect(engine.snapshot()).not.toHaveProperty('static');
  });

  test('grows by one point per game hour through the clock and shows in the views', () => {
    const engine = GameEngine.create(tinyManor(), {
      ...withStatic(),
      phone: { initial: createPhoneState() },
    });
    const first = Array.from({ length: 3 }, () => wait(engine)).flatMap(({ events }) => events);
    expect(first.filter(({ type }) => type === 'StaticChanged')).toHaveLength(0);
    const events = wait(engine).events;
    expect(events.filter(({ type }) => type === 'StaticChanged')).toMatchObject([
      { before: 0, after: 1, cause: 'time', at: 60 },
    ]);
    expect(engine.playerView().static).toBe(1);
    expect(engine.phoneView()?.status.signal).toBe(99);
    expect(engine.snapshot().static).toMatchObject({ level: 1 });
  });

  test('a threshold is reported once and appears in the events', () => {
    const engine = GameEngine.create(tinyManor(), withStatic(24));
    const events = waitHours(engine, 3);
    expect(events.filter(({ type }) => type === 'StaticThresholdReached')).toMatchObject([
      { threshold: 25, level: 25 },
    ]);
    expect(engine.staticLevel()).toBe(27);
  });

  test('Static 100 ends the game with madness and reveals no culprit', () => {
    const investigation = tinyManor();
    const engine = GameEngine.create(investigation, withStatic(99));
    const results = Array.from({ length: 4 }, () => wait(engine));
    expect(results.at(-1)).toMatchObject({ ok: true, outcome: 'madness' });
    expect(results.flatMap(({ events }) => events)).toContainEqual(
      expect.objectContaining({ type: 'StaticOverwhelmed', ending: 'madness' }),
    );
    const view = engine.playerView();
    expect(view.static).toBe(100);
    expect(view.ending).toMatchObject({ endingId: 'madness' });
    expect(wait(engine)).toMatchObject({ ok: false, error: 'GAME_OVER' });
    const { culpritIds } = investigation.truth.incident;
    const playing = GameEngine.create(investigation, withStatic(0)).playerView();
    for (const id of culpritIds) expect(JSON.stringify(playing)).not.toContain(id);
  });

  test('restores from a snapshot and keeps the hourly grid', () => {
    const investigation = tinyManor();
    const ports = withStatic();
    const engine = GameEngine.create(investigation, ports);
    waitHours(engine, 1);
    wait(engine);
    wait(engine);
    const restored = GameEngine.restore(engine.snapshot(), investigation, ports);
    expect(restored.stateHash()).toBe(engine.stateHash());
    for (let i = 0; i < 6; i += 1) {
      expect(wait(restored)).toEqual(wait(engine));
      expect(restored.stateHash()).toBe(engine.stateHash());
    }
    expect(restored.staticLevel()).toBe(3);
  });

  test('an older snapshot without static restores to the starting level', () => {
    const investigation = tinyManor();
    const engine = GameEngine.create(investigation, base);
    waitHours(engine, 1);
    const old = engine.snapshot();
    expect(old).not.toHaveProperty('static');
    const restored = GameEngine.restore(old, investigation, withStatic());
    expect(restored.staticLevel()).toBe(0);
    waitHours(restored, 1);
    expect(restored.staticLevel()).toBe(1);
  });
});
