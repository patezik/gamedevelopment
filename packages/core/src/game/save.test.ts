import type { PlayerAction } from '@hs/protocol';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { stateHash } from '../common/index.ts';
import { createRng } from '../rng/index.ts';
import { Scheduler, TickPhase } from '../time/index.ts';
import {
  createCheckpoint,
  createSave,
  gameReplayRuntime,
  loadSave,
  recordAction,
  type ActionSource,
  type ReplayEngine,
  type SaveMetadata,
} from './save.ts';

const metadata: SaveMetadata = {
  scenarioId: 'tiny-manor',
  seed: 'save-seed',
  generatorVersion: '0.1.0',
  createdAt: '2026-11-23T00:00:00Z',
};
const runtime = (identity = metadata) =>
  gameReplayRuntime(tinyManor(identity.seed), { startLocationId: 'loc_hall' });
const regenerate = (identity: Omit<SaveMetadata, 'createdAt'>) =>
  runtime({ ...metadata, ...identity });
const wait = { type: 'wait', minutes: 15 } as const;

test('property: checkpoint and full replay agree for random move/wait histories', () => {
  const destinations = ['loc_hall', 'loc_pantry', 'loc_study'];
  for (let seed = 0; seed < 25; seed++) {
    const rng = createRng(String(seed));
    const { engine } = runtime();
    const save = createSave(metadata, engine);
    for (let index = 0; index < 65; index++) {
      const action: PlayerAction = rng.chance(0.5)
        ? { type: 'move', locationId: rng.pick(destinations) }
        : wait;
      recordAction(save, engine, 'desktop', action);
    }
    expect(save.checkpoint?.atAction).toBe(50);
    const full = { ...save };
    delete full.checkpoint;
    const restored = loadSave(JSON.parse(JSON.stringify(save)), regenerate);
    expect(restored.stateHash()).toBe(engine.stateHash());
    expect(loadSave(full, regenerate).snapshot()).toEqual(restored.snapshot());
  }
}, 20_000);

test('locates the first altered action even when it precedes the checkpoint', () => {
  const { engine } = runtime();
  const save = createSave(metadata, engine);
  for (let index = 0; index < 52; index++) recordAction(save, engine, 'desktop', wait);
  save.actions[2]!.action = { type: 'wait', minutes: 30 };
  save.actions[5]!.action = { type: 'move', locationId: 'loc_study' };
  expect(() => loadSave(save, regenerate)).toThrow(
    expect.objectContaining({
      code: 'SAVE_DESYNC',
      atAction: 3,
    }),
  );
});

test('reports a bad checkpoint rather than trusting its claimed state hash', () => {
  const { engine } = runtime();
  const save = createSave(metadata, engine);
  recordAction(save, engine, 'desktop', wait);
  createCheckpoint(save, engine);
  save.checkpoint!.snapshot = z.json().parse({ ...engine.snapshot(), minute: 2 });
  expect(() => loadSave(save, regenerate)).toThrow(
    expect.objectContaining({
      code: 'SAVE_DESYNC',
      atAction: 1,
    }),
  );
});

class ScheduledRuntime implements ReplayEngine {
  constructor(readonly scheduler: Scheduler) {}

  dispatch(_source: ActionSource, action: PlayerAction) {
    if (action.type !== 'wait') throw new Error('Fixture expects wait');
    this.scheduler.popDue(this.scheduler.now + action.minutes);
    return { ok: true, minutesSpent: action.minutes, events: [] };
  }

  snapshot() {
    return this.scheduler.serialize();
  }
  stateHash() {
    return stateHash(this.snapshot());
  }
}

test('restores a checkpoint in the middle of a real Scheduler queue and only replays the tail', () => {
  const createRuntime = () => {
    const scheduler = new Scheduler();
    for (const at of [10, 30, 90]) {
      scheduler.schedule({
        at,
        phase: TickPhase.WorldEvents,
        priority: 0,
        kind: 'fixture',
        payload: {},
      });
    }
    return new ScheduledRuntime(scheduler);
  };
  const runtime = createRuntime();
  const save = createSave(metadata, runtime);
  recordAction(save, runtime, 'desktop', wait);
  expect(runtime.snapshot().events.map(({ at }) => at)).toEqual([30, 90]);
  createCheckpoint(save, runtime);
  recordAction(save, runtime, 'desktop', wait);
  const initial = createRuntime();
  const untouched = vi.spyOn(initial, 'dispatch');
  const restored = loadSave(save, () => ({
    engine: initial,
    restore: (snapshot) => new ScheduledRuntime(Scheduler.restore(snapshot)),
  }));
  expect(untouched).not.toHaveBeenCalled();
  expect(restored.stateHash()).toBe(runtime.stateHash());
  expect(restored.snapshot().events.map(({ at }) => at)).toEqual([90]);
  expect(restored.scheduler.popDue(90)).toEqual(runtime.scheduler.popDue(90));
  expect(restored.stateHash()).toBe(runtime.stateHash());
});
