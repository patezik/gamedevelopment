import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import type { CriticalEventConfig, DeadlineConfig, MissedEffect } from '../time/index.ts';
import { GameEngine, type DispatchResult, type EnginePorts } from './engine.ts';
import {
  createCheckpoint,
  createSave,
  gameReplayRuntime,
  loadSave,
  recordAction,
  SaveFile,
  type SaveMetadata,
} from './save.ts';

const wait = (engine: GameEngine, minutes = 15): DispatchResult =>
  engine.dispatch('desktop', { type: 'wait', minutes });
const ports = (
  criticalEvents: readonly CriticalEventConfig[],
  deadlines: readonly DeadlineConfig[] = [],
  onMissed?: (effect: MissedEffect, at: number) => void,
): EnginePorts => ({
  startLocationId: 'loc_hall',
  static: {},
  scenarioEvents: { criticalEvents, deadlines, ...(onMissed && { onMissed }) },
});
/** Missed (the hero stays in the hall) and costs Static when it happens. */
const missed = (
  id: string,
  at: number,
  delta: number,
  earlierIf?: CriticalEventConfig['earlierIf'],
): CriticalEventConfig => ({
  id,
  at,
  requiresPresence: { locationId: 'loc_study' },
  onMissed: { kind: 'static', delta },
  ...(earlierIf && { earlierIf }),
});
const staticChanges = (results: readonly DispatchResult[]) =>
  results
    .flatMap(({ events }) => events)
    .filter((event) => event.type === 'StaticChanged' && event.cause === 'scenarioMissed');
const waitTimes = (engine: GameEngine, times: number) =>
  Array.from({ length: times }, () => wait(engine));

describe('scenario events in the engine (TIME-006)', () => {
  test('a missed event applies its effect exactly once, at its own minute', () => {
    const engine = GameEngine.create(tinyManor(), ports([missed('meeting', 30, 7)]));
    const results = waitTimes(engine, 8);
    expect(staticChanges(results)).toMatchObject([{ before: 0, after: 7, at: 30 }]);
    expect(engine.staticLevel()).toBe(7 + 2); // plus two hourly ticks
  });

  test('a present hero does not miss the event', () => {
    const present = { ...missed('meeting', 30, 7), requiresPresence: { locationId: 'loc_hall' } };
    const engine = GameEngine.create(tinyManor(), ports([present]));
    expect(staticChanges(waitTimes(engine, 4))).toEqual([]);
    expect(engine.staticLevel()).toBe(1);
  });

  test('earlierIf sees the Static a missed event raised', () => {
    const engine = GameEngine.create(
      tinyManor(),
      ports([missed('first', 15, 10), missed('second', 240, 3, { staticAtLeast: 10, at: 60 })]),
    );
    // `second` is pulled forward to minute 60 (it sees Static 10), not left at 240.
    expect(staticChanges(waitTimes(engine, 8))).toMatchObject([
      { before: 0, after: 10, at: 15 },
      { before: 10, after: 13, at: 60 },
    ]);
  });

  test('a low Static leaves the event at its minute', () => {
    const engine = GameEngine.create(
      tinyManor(),
      ports([missed('late', 120, 3, { staticAtLeast: 50, at: 60 })]),
    );
    expect(staticChanges(waitTimes(engine, 10))).toMatchObject([{ at: 120 }]);
  });

  test('effects the engine cannot apply itself go to onMissed', () => {
    const seen: [MissedEffect, number][] = [];
    const fire: CriticalEventConfig = {
      id: 'fire',
      at: 30,
      requiresPresence: { locationId: 'loc_study' },
      onMissed: { kind: 'closeLocation', locationId: 'loc_pantry' },
    };
    const engine = GameEngine.create(
      tinyManor(),
      ports([fire], [], (effect, at) => seen.push([effect, at])),
    );
    waitTimes(engine, 4);
    expect(seen).toEqual([[{ kind: 'closeLocation', locationId: 'loc_pantry' }, 30]]);
  });

  test('a deadline before the end finishes the game through dispatch', () => {
    const investigation = tinyManor();
    const engine = GameEngine.create(
      investigation,
      ports([], [{ id: 'police', at: 60, outcome: 'time_up' }]),
    );
    const results = waitTimes(engine, 4);
    expect(results.slice(0, 3).every(({ outcome }) => outcome === undefined)).toBe(true);
    expect(results[3]).toMatchObject({ ok: true, outcome: 'time_expired' });
    expect(investigation.world.durationMinutes).toBeGreaterThan(60);
    expect(engine.playerView().ending).toMatchObject({ endingId: 'time_up' });
    expect(wait(engine)).toMatchObject({ ok: false, error: 'GAME_OVER' });
  });

  test('a deadline may name another ending and reveals nothing about the truth', () => {
    const engine = GameEngine.create(
      tinyManor(),
      ports([], [{ id: 'flood', at: 30, outcome: 'death' }]),
    );
    wait(engine);
    expect(wait(engine)).toMatchObject({ outcome: 'death' });
    const json = JSON.stringify([engine.playerView(), engine.phoneView()]);
    expect(json).not.toMatch(/culpritIds|veracity|hallucination/);
  });

  test('a deadline outside the endings is refused when the engine is built', () => {
    expect(() =>
      GameEngine.create(tinyManor(), ports([], [{ id: 'x', at: 30, outcome: 'party' }])),
    ).toThrow(/unknown outcome/);
  });

  test('without the port the state is as before: no scenario field, no deadline', () => {
    const engine = GameEngine.create(tinyManor(), { startLocationId: 'loc_hall', static: {} });
    waitTimes(engine, 6);
    expect(engine.snapshot()).not.toHaveProperty('scenario');
    expect(wait(engine).outcome).toBeUndefined();
  });

  test('a clock-derivable state adds nothing to the snapshot or the hash', () => {
    const investigation = tinyManor();
    const plain = GameEngine.create(investigation, { startLocationId: 'loc_hall', static: {} });
    const wired = GameEngine.create(
      investigation,
      ports([{ id: 'quiet', at: 45 }], [{ id: 'late', at: 1000, outcome: 'time_up' }]),
    );
    for (let i = 0; i < 6; i += 1) {
      wait(plain);
      wait(wired);
      expect(wired.snapshot()).not.toHaveProperty('scenario');
      expect(wired.stateHash()).toBe(plain.stateHash());
    }
  });

  describe('restore', () => {
    const events = [
      missed('first', 15, 10),
      missed('second', 240, 3, { staticAtLeast: 10, at: 60 }),
    ];

    test.each([2, 4, 5, 7])('after %i steps it continues to the same hash', (steps) => {
      const investigation = tinyManor();
      const config = ports(events, [{ id: 'police', at: 400, outcome: 'time_up' }]);
      const engine = GameEngine.create(investigation, config);
      waitTimes(engine, steps);
      const restored = GameEngine.restore(engine.snapshot(), investigation, config);
      expect(restored.stateHash()).toBe(engine.stateHash());
      for (let i = 0; i < 25; i += 1) {
        expect(wait(restored)).toEqual(wait(engine));
        expect(restored.stateHash()).toBe(engine.stateHash());
      }
    });

    test('an event already pulled forward is saved and not planned again', () => {
      const investigation = tinyManor();
      const config = ports(events);
      const engine = GameEngine.create(investigation, config);
      waitTimes(engine, 6); // minute 90: `second` fired at 60 although it was due at 240
      expect(engine.snapshot().scenario).toMatchObject({ fired: ['first', 'second'], pending: [] });
      const restored = GameEngine.restore(engine.snapshot(), investigation, config);
      expect(staticChanges(waitTimes(restored, 12))).toEqual([]);
    });

    test('an older snapshot without the field derives the progress from the clock', () => {
      const investigation = tinyManor();
      const engine = GameEngine.create(investigation, { startLocationId: 'loc_hall', static: {} });
      waitTimes(engine, 4); // minute 60
      const config = ports([missed('first', 15, 10), missed('later', 90, 5)]);
      const restored = GameEngine.restore(engine.snapshot(), investigation, config);
      // `first` (minute 15) is behind the clock and not applied retroactively; `later` is ahead.
      expect(staticChanges(waitTimes(restored, 4))).toMatchObject([{ at: 90 }]);
    });

    test('a deadline already reached stays reached', () => {
      const investigation = tinyManor();
      const config = ports([], [{ id: 'police', at: 30, outcome: 'time_up' }]);
      const engine = GameEngine.create(investigation, config);
      waitTimes(engine, 2);
      const restored = GameEngine.restore(engine.snapshot(), investigation, config);
      expect(wait(restored)).toMatchObject({ ok: false, error: 'GAME_OVER' });
      expect(restored.playerView().ending).toMatchObject({ endingId: 'time_up' });
    });
  });

  test('a save journal replays to the same hash across a pulled-forward event', () => {
    const config = ports([
      missed('first', 15, 10),
      missed('second', 240, 3, { staticAtLeast: 10, at: 60 }),
    ]);
    const metadata: SaveMetadata = {
      scenarioId: 'tiny-manor',
      seed: 'scenario-save',
      generatorVersion: tinyManor('scenario-save').generatorVersion,
      createdAt: '2026-11-23T00:00:00Z',
    };
    const make = () => gameReplayRuntime(tinyManor('scenario-save'), config);
    const { engine } = make();
    const save = createSave(metadata, engine);
    const step = { type: 'wait', minutes: 15 } as const;
    for (let i = 0; i < 5; i += 1) recordAction(save, engine, 'desktop', step);
    createCheckpoint(save, engine); // minute 75: `second` fired at 60, was due at 240
    for (let i = 0; i < 6; i += 1) recordAction(save, engine, 'desktop', step);
    const parsed = SaveFile.parse(JSON.parse(JSON.stringify(save)));
    expect(parsed.checkpoint?.snapshot).toHaveProperty('scenario');
    expect(loadSave(parsed, make).stateHash()).toBe(engine.stateHash());
    const withoutCheckpoint = { ...parsed, checkpoint: undefined };
    expect(loadSave(withoutCheckpoint, make).stateHash()).toBe(engine.stateHash());
  });
});
