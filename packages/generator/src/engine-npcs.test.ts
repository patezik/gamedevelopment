import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { GameEngine } from '@hs/core/game';
import { truthInvariantsCheck } from '@hs/validator';
import { expect, test } from 'vitest';
import { generateInvestigation } from './index.ts';

const scenarios = new URL('../../../content/scenarios/', import.meta.url);
const minimal = loadScenarioFromDir(fileURLToPath(new URL('_test_minimal/', scenarios)));

test('on a generated case the characters are in the rooms and can be talked to (ENG-014)', () => {
  const result = generateInvestigation({ scenarioId: '_test_minimal', seed: '3' }, minimal, {
    checks: [truthInvariantsCheck],
  });
  if (!result.ok) throw new Error('Expected an accepted investigation');
  const { investigation } = result;
  const ports = { startLocationId: minimal.locations[0]!.id, npcSimulation: true } as const;
  const engine = GameEngine.create(investigation, ports);
  for (let i = 0; i < 4; i += 1) engine.dispatch('desktop', { type: 'wait', minutes: 15 });
  const snapshot = engine.snapshot();
  const agents = snapshot.simulation!.agents;
  expect(agents).toHaveLength(investigation.characters.length);

  // Put the hero where a living character stands and speak to them.
  const victims = investigation.truth.incident.victimIds;
  const living = agents.find(({ characterId }) => !victims.includes(characterId));
  if (!living) throw new Error('No living character');
  const { characterId, location } = living;
  const there = GameEngine.restore({ ...snapshot, locationId: location }, investigation, ports);
  expect(there.playerView().presentCharacters.map(({ id }) => id)).toContain(characterId);
  const talk = there.dispatch('desktop', { type: 'talk', characterId, topicId: 'self' });
  expect(talk.ok).toBe(true);
});
