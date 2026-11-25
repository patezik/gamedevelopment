import { readFileSync } from 'node:fs';
import type { PlayerAction } from '@hs/protocol';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { stateHash } from '../common/index.ts';
import { createRng } from '../rng/index.ts';
import { DEFAULT_ACTION_COSTS, Scheduler, TickPhase } from '../time/index.ts';
import {
  createCheckpoint,
  createSave,
  gameReplayRuntime,
  loadSave,
  recordAction,
  type ActionSource,
  type ReplayEngine,
  SaveFile,
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

// Produced by createSave / recordAction / createCheckpoint on main at 547d5bd.
// Keep the original initial, per-action, checkpoint and final digests as the replay oracle.
const mainSave = SaveFile.parse(
  JSON.parse(
    readFileSync(new URL('../../test/fixtures/save-before-desktop.json', import.meta.url), 'utf8'),
  ),
);

test('replays a save written by main, including an examination main rejected', () => {
  const { checkpoint, ...journal } = mainSave;
  const full = loadSave(journal, regenerate);
  const restored = loadSave(mainSave, regenerate);
  expect(restored.snapshot()).toEqual(full.snapshot());
  expect(restored.snapshot()).toMatchObject({ minute: 141, locationId: 'loc_hall' });
  expect(restored.snapshot()).not.toHaveProperty('desktop');
  expect(restored.stateHash()).toBe(mainSave.finalStateHash);
  expect(
    loadSave(
      { ...journal, actions: journal.actions.slice(0, 3), finalStateHash: checkpoint!.stateHash },
      regenerate,
    ).snapshot(),
  ).toEqual(checkpoint!.snapshot);
});

test('continues a main journal with current rules and verifies both generations of checkpoints', () => {
  const save = structuredClone(mainSave);
  const engine = loadSave(save, regenerate);
  expect(recordAction(save, engine, 'desktop', wait).ok).toBe(true);
  expect(recordAction(save, engine, 'desktop', { type: 'examineLocation' }).ok).toBe(true);
  expect(engine.snapshot().desktop?.examinedLocations).toEqual(['loc_hall']);
  expect(engine.playerView().vitals.fatigue).toBeGreaterThan(0);
  expect(loadSave(save, regenerate).snapshot()).toEqual(engine.snapshot());
  createCheckpoint(save, engine);
  recordAction(save, engine, 'desktop', { type: 'move', locationId: 'loc_study' });
  expect(loadSave(save, regenerate).snapshot()).toEqual(engine.snapshot());
  delete save.checkpoint;
  expect(loadSave(save, regenerate).stateHash()).toBe(engine.stateHash());
});

test('hashes desktop state in new saves and rejects a modified or missing desktop checkpoint', () => {
  const { engine } = runtime();
  const save = createSave(metadata, engine);
  expect(engine.snapshot().desktop).toBeDefined();
  recordAction(save, engine, 'desktop', { type: 'examineLocation' });
  createCheckpoint(save, engine);
  const { desktop, ...base } = engine.snapshot();
  for (const snapshot of [base, { ...base, desktop: { ...desktop, examinedLocations: [] } }]) {
    expect(() =>
      loadSave({ ...save, checkpoint: { ...save.checkpoint, snapshot } }, regenerate),
    ).toThrow(expect.objectContaining({ code: 'SAVE_DESYNC', atAction: 1 }));
  }
  recordAction(save, engine, 'desktop', wait);
  expect(loadSave(save, regenerate).snapshot()).toEqual(engine.snapshot());
  delete save.checkpoint;
  expect(loadSave(save, regenerate).stateHash()).toBe(engine.stateHash());
});

test('rejects a damaged main checkpoint and a divergent replay of a valid main journal', () => {
  const checkpoint = mainSave.checkpoint!;
  const saved = z.record(z.string(), z.json()).parse(checkpoint.snapshot);
  for (const desktop of [null, false, 0, '']) {
    const snapshot = { ...saved, desktop };
    expect(() =>
      loadSave({ ...mainSave, checkpoint: { ...checkpoint, snapshot } }, regenerate),
    ).toThrow(expect.objectContaining({ code: 'SAVE_DESYNC', atAction: checkpoint.atAction }));
  }
  const differentCosts = () =>
    gameReplayRuntime(tinyManor(metadata.seed), {
      startLocationId: 'loc_hall',
      actionCosts: { ...DEFAULT_ACTION_COSTS, wait: { choices: [30] } },
    });
  const journal = { ...mainSave };
  delete journal.checkpoint;
  expect(() => loadSave(journal, differentCosts)).toThrow(
    expect.objectContaining({ code: 'SAVE_DESYNC', atAction: 2 }),
  );
});

test('matching state hashes cannot make an unsupported generator version replayable', () => {
  const current = runtime();
  const save = createSave(metadata, current.engine);
  recordAction(save, current.engine, 'desktop', wait);
  createCheckpoint(save, current.engine);
  const restored = runtime();
  const restore = vi.spyOn(restored, 'restore');
  const dispatch = vi.spyOn(restored.engine, 'dispatch');
  const input = { ...save, generatorVersion: '0.0.9' };
  expect(() => loadSave(input, () => restored)).toThrow(
    expect.objectContaining({
      code: 'SAVE_DESYNC',
      atAction: 0,
    }),
  );
  expect(restore).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

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
    generatorVersion: metadata.generatorVersion,
    engine: initial,
    restore: (snapshot) => new ScheduledRuntime(Scheduler.restore(snapshot)),
  }));
  expect(untouched).not.toHaveBeenCalled();
  expect(restored.stateHash()).toBe(runtime.stateHash());
  expect(restored.snapshot().events.map(({ at }) => at)).toEqual([90]);
  expect(restored.scheduler.popDue(90)).toEqual(runtime.scheduler.popDue(90));
  expect(restored.stateHash()).toBe(runtime.stateHash());
});
