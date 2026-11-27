import { loadScenarioFromDir } from '@hs/core/content';
import { createSave, gameReplayRuntime, loadSave, recordAction } from '@hs/core/save';
import { FORBIDDEN_VIEW_KEYS } from '@hs/protocol';
import { expect, test } from 'vitest';
import {
  defaultScenariosDir,
  GeneratorInvestigationProvider,
  ScenarioCatalog,
} from '../routes/generation.ts';

const SCENARIO = 'sanatorium_winter';
const content = loadScenarioFromDir(`${defaultScenariosDir()}${SCENARIO}`);
const provider = new GeneratorInvestigationProvider(new ScenarioCatalog([content]));

test('a generated session runs the preset events and deadlines on its own clock (TIME-006)', () => {
  const { investigation, ports } = provider.create(SCENARIO, '2');
  expect(ports.scenarioEvents).toEqual({
    criticalEvents: content.preset.criticalEvents,
    deadlines: content.preset.deadlines,
  });
  // A tighter deadline than the preset's ends the game early, through the usual dispatch.
  const early = {
    ...ports,
    scenarioEvents: {
      criticalEvents: content.preset.criticalEvents,
      deadlines: [{ id: 'early', at: 60, outcome: 'time_up' }],
    },
  };
  const make = () => gameReplayRuntime(investigation, early);
  const { engine } = make();
  const save = createSave(
    {
      scenarioId: SCENARIO,
      seed: '2',
      generatorVersion: investigation.generatorVersion,
      createdAt: '2026-11-27T00:00:00Z',
    },
    engine,
  );
  const wait = { type: 'wait', minutes: 30 } as const;
  expect(recordAction(save, engine, 'desktop', wait).outcome).toBeUndefined();
  expect(recordAction(save, engine, 'desktop', wait).outcome).toBe('time_expired');
  expect(engine.playerView().ending).toMatchObject({ endingId: 'time_up' });
  // The journal replays to the same state, and the views carry no truth.
  expect(loadSave(JSON.parse(JSON.stringify(save)), make).stateHash()).toBe(engine.stateHash());
  const views = JSON.stringify(engine.playerView());
  for (const key of FORBIDDEN_VIEW_KEYS) expect(views).not.toContain(`"${key}"`);
});
