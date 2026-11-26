import { loadScenarioFromDir } from '@hs/core/content';
import { GameEngine } from '@hs/core/game';
import { generateInvestigation } from '@hs/generator';
import { describe, expect, it } from 'vitest';
import { scenarioEnginePorts } from '../sessions/scenario-ports.ts';
import { defaultScenariosDir } from './generation.ts';

// ENG-014 (transferred from SRV-012): on a really generated sanatorium, with the SRV-012 ports and
// the NPC simulation on, a character who is where their routine puts them gives testimony.

const content = loadScenarioFromDir(`${defaultScenariosDir()}sanatorium_winter`);

function start(seed: string) {
  const result = generateInvestigation({ scenarioId: 'sanatorium_winter', seed }, content);
  if (!result.ok) throw new Error('the seed is expected to pass the gate');
  const ports = {
    ...scenarioEnginePorts(content, result.investigation, result.server),
    npcSimulation: true,
  } as const;
  return {
    investigation: result.investigation,
    ports,
    engine: GameEngine.create(result.investigation, ports),
  };
}

/** The hero walks to the first neighbour of the start where somebody stands, and talks to them. */
function converse(seed: string) {
  const { investigation, ports, engine } = start(seed);
  expect(engine.playerView().presentCharacters).toEqual([]);
  const crowded = engine
    .snapshot()
    .simulation!.agents.filter(
      ({ characterId }) => !investigation.truth.incident.victimIds.includes(characterId),
    )
    .map(({ location }) => location);
  const exit = engine
    .playerView()
    .location.exits.find(({ locationId }) => crowded.includes(locationId));
  if (!exit) throw new Error('nobody stands next to the start');
  expect(engine.dispatch('desktop', { type: 'move', locationId: exit.locationId }).ok).toBe(true);
  const [person] = engine.playerView().presentCharacters;
  if (!person) throw new Error('the move left nobody to talk to');
  const talk = engine.dispatch('desktop', {
    type: 'talk',
    characterId: person.id,
    topicId: 'self',
  });
  return { investigation, ports, engine, person, talk };
}

it('the testimony of seed 2 is rendered in the dialogue the player sees', () => {
  const { engine, person } = converse('2');
  const dialogue = engine.playerView().interaction;
  expect(dialogue?.characterId).toBe(person.id);
  const answers = (dialogue?.history ?? []).filter(({ speaker }) => speaker === 'other');
  expect(answers.length).toBeGreaterThan(0);
  for (const { text } of answers) expect(text.length).toBeGreaterThan(0);
});

describe.each(['2', '3'])('sanatorium_winter seed %s with the NPC simulation', (seed) => {
  it('a character met after a real walk gives testimony in a talk', () => {
    const { person, talk } = converse(seed);
    expect(talk.ok).toBe(true);
    const heard = talk.events.filter((event) => event.type === 'StatementHeard');
    expect(heard.length).toBeGreaterThan(0);
    for (const event of heard) expect(event).toMatchObject({ characterId: person.id });
  });

  it('the same seed and actions replay to the same state, and a restore continues it', () => {
    const first = converse(seed);
    const second = converse(seed);
    expect(second.engine.stateHash()).toBe(first.engine.stateHash());

    const restored = GameEngine.restore(first.engine.snapshot(), first.investigation, first.ports);
    expect(restored.stateHash()).toBe(first.engine.stateHash());
    const next = { type: 'wait', minutes: 15 } as const;
    first.engine.dispatch('desktop', next);
    restored.dispatch('desktop', next);
    expect(restored.stateHash()).toBe(first.engine.stateHash());
  });
});
