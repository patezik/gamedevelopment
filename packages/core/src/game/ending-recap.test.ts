import { FORBIDDEN_VIEW_KEYS, ServerMessage, type PlayerAction } from '@hs/protocol';
import { expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { compileDeductionRules } from '../investigation/index.ts';
import { TruthModel, type TruthEventInput } from '../truth/index.ts';
import { GameEngine } from './engine.ts';

function wireView(view: unknown): string {
  const message = {
    v: 1,
    type: 'view.update',
    id: 's-1',
    payload: { stateVersion: 1, view },
  };
  const json = JSON.stringify(message);
  expect(ServerMessage.parse(JSON.parse(json))).toEqual(JSON.parse(json));
  return json;
}

test('only the terminal desktop view reveals the exact seed and solution', () => {
  const investigation = tinyManor('  дело-42  ');
  const ports = {
    startLocationId: 'loc_hall',
    accusation: { rules: compileDeductionRules([]) },
    phone: {},
  };
  const engine = GameEngine.create(investigation, ports);
  const assertHidden = (json: string) => {
    expect(json).not.toContain(investigation.seed);
    for (const key of [
      ...FORBIDDEN_VIEW_KEYS,
      'ending',
      'recap',
      'responsible',
      'seed',
      'scenarioId',
    ]) {
      expect(json).not.toContain(`"${key}":`);
    }
  };

  const wrong: Extract<PlayerAction, { type: 'accuse' }> = {
    type: 'accuse',
    caseFile: { accusedIds: ['ch_cook'], evidence: [] },
    confirm: true,
  };
  assertHidden(wireView(engine.playerView()));
  assertHidden(wireView(engine.phoneView()));
  expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 }).ok).toBe(true);
  assertHidden(wireView(engine.playerView()));

  for (const confirm of [false, true]) {
    const result = engine.dispatch('desktop', { ...wrong, confirm });
    expect(result).toMatchObject({ ok: true });
    expect(result.outcome).toBeUndefined();
    assertHidden(JSON.stringify(result));
    assertHidden(wireView(engine.playerView()));
    assertHidden(wireView(engine.phoneView()));
  }

  const result = engine.dispatch('desktop', wrong);
  expect(result.outcome).toBe('wrong_accusation');
  assertHidden(JSON.stringify(result));
  const view = engine.playerView();
  expect(view.ending).toMatchObject({
    seed: investigation.seed,
    scenarioId: investigation.scenarioId,
    recap: {
      timeline: [
        { at: -20, location: 'Study', participants: ['Morgan Pike'], text: 'Предмет взят.' },
        { at: -10, location: 'Archive', participants: ['Morgan Pike'], text: 'Предмет спрятан.' },
      ],
    },
  });
  wireView(view);
  assertHidden(wireView(engine.phoneView()));

  const restored = GameEngine.restore(engine.snapshot(), investigation, ports);
  expect(restored.playerView().ending).toEqual(view.ending);
});

function appendOrder(truth: TruthModel) {
  return truth.events().toSorted((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
}

test('deadline reveals the seed even when the incident has no key events', () => {
  const base = tinyManor('empty-recap-42');
  const truth = new TruthModel(
    { ...base.truth.incident, keyEventIds: [] },
    appendOrder(base.truth),
  );
  const engine = GameEngine.create(
    { ...base, truth, world: { ...base.world, durationMinutes: 16 } },
    { startLocationId: 'loc_hall' },
  );

  expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 }).ok).toBe(true);
  const active = engine.playerView();
  expect(active.clock.remainingMinutes).toBe(1);
  expect(active.ending).toBeUndefined();
  expect(wireView(active)).not.toContain(base.seed);

  expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 })).toMatchObject({
    ok: true,
    minutesSpent: 1,
    outcome: 'time_expired',
  });
  const finished = engine.playerView();
  expect(finished.ending).toMatchObject({
    endingId: 'time_up',
    seed: base.seed,
  });
  expect(finished.ending?.recap?.timeline).toEqual([]);
  wireView(finished);
});

test('recap uses only key events, ordered by minute and then by event order', () => {
  const base = tinyManor('');
  const history = appendOrder(base.truth);
  const keyEventIds = [3, 1, 4].map((step) => `ev_${history.length + step}`);
  const truth = new TruthModel({ ...base.truth.incident, keyEventIds }, history);
  const event: TruthEventInput = {
    t: -5,
    duration: 0,
    verb: 'hide',
    actorIds: ['ch_bursar'],
    location: 'loc_study',
    targets: [],
    causes: [],
    facts: [],
    traceIds: [],
    visibility: 'covert',
  };
  truth.append(event);
  truth.append({ ...event, t: -10, verb: 'write' }); // unrelated
  truth.append({
    ...event,
    t: -20,
    verb: 'strike',
    targets: [
      { kind: 'character', id: 'ch_owner' },
      { kind: 'character', id: 'ch_bursar' },
    ],
  });
  truth.append({ ...event, verb: 'unknown_action', actorIds: ['player'] });

  const engine = GameEngine.create(
    { ...base, truth },
    { startLocationId: 'loc_hall', static: { start: 99 } },
  );
  expect(engine.dispatch('desktop', { type: 'wait', minutes: 60 }).outcome).toBe('madness');
  expect(engine.playerView().ending).toMatchObject({
    endingId: 'madness',
    seed: '',
    recap: {
      timeline: [
        {
          at: -20,
          location: 'Study',
          participants: ['Morgan Pike', 'Ada Vale'],
          text: 'Нанесён удар.',
        },
        { at: -5, location: 'Study', participants: ['Morgan Pike'], text: 'Предмет спрятан.' },
        { at: -5, location: 'Study', participants: ['Следователь'], text: 'Ключевое событие.' },
      ],
    },
  });
});
