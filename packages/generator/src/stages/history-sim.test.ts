import { RelationshipGraph } from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import { stateHash } from '@hs/core/common';
import { checkTruthInvariants, factId } from '@hs/core/truth';
import { describe, expect, test } from 'vitest';
import { fixture, routine, type FixtureOptions } from '../../test/support/fixture.ts';
import { plan, simulateHistory } from '../../test/support/history.ts';
import { withIncident } from '../../test/support/incident.ts';
import {
  DEATH_VERB,
  GenerationRejection,
  HISTORY_PLOT_FRUSTRATED,
  motiveFact,
  type HistoryWorld,
  type PlotWorld,
} from '../index.ts';

/** Day minute of game minute `t`: the fixture starts at 08:00. */
const day = (t: number) => 480 + t;
const archive = 'loc_archive';
const hall = 'loc_hall';

function prepare(options: FixtureOptions = {}, types?: string[]) {
  const { content, input } = fixture(options);
  const scenario: ScenarioContent = types ? withIncident(content, { types }) : content;
  return { content: scenario, world: plan(input, scenario) };
}

function run(world: PlotWorld, content: ScenarioContent): HistoryWorld {
  const result = simulateHistory(world, content);
  if (result instanceof GenerationRejection) throw result;
  return result;
}

/** Replaces one character's routine after planning: the history meets a world the plan did not. */
function withRoutine(world: PlotWorld, id: string, blocks: ReturnType<typeof routine>): PlotWorld {
  return {
    ...world,
    characters: world.characters.map((c) => (c.id === id ? { ...c, routine: blocks } : c)),
  };
}

/** Taking the record, then reading it at the archive for two minutes (slack 6). */
const reading: FixtureOptions = {
  crime: {
    plan: [
      { step: 'take_record', verb: 'take', target: '$means', duration: 1, before: 'read' },
      { step: 'read', verb: 'read', target: '$means', duration: 2 },
    ],
    requires: { minWindowMinutes: 8 },
  },
};

describe('historySimulation', () => {
  test('executes the theft as simulated events and records only executed key events', () => {
    const { content, world } = prepare();
    const history = run(world, content);
    const { truth, plot, incident, worldState } = history;
    const [take] = history.historyReport.steps;
    const acquisition = plot.opportunity.acquisition!;

    expect(history.historyReport.attempts).toEqual([{ shift: 0, problems: [] }]);
    expect(truth.incident).toEqual({
      ...plot.incident,
      motive: factId(motiveFact(incident.motive)),
      keyEventIds: [take!.eventId],
    });
    const event = truth.events().find(({ id }) => id === take!.eventId)!;
    expect(event).toMatchObject({
      t: acquisition.at,
      verb: 'take',
      actorIds: [incident.culpritId],
      location: acquisition.locationId,
      targets: [{ kind: 'item', id: 'it_log' }],
      visibility: 'covert',
    });
    expect(worldState.items.locate('it_log', acquisition.at)).toEqual({
      kind: 'location',
      id: archive,
    });
    expect(worldState.items.locate('it_log', acquisition.at + 1)).toEqual({
      kind: 'character',
      id: incident.culpritId,
    });
    expect(truth.possession('it_log')).toEqual([
      { holder: incident.culpritId, interval: { from: acquisition.at + 1, to: 0 } },
    ]);
    // Nobody dies in a theft.
    expect(history.historyReport.deathAt).toBeNull();
    expect(
      truth.facts({ kind: 'state' }).filter((f) => f.kind === 'state' && f.property === 'alive'),
    ).toEqual([]);
    expect(checkTruthInvariants(truth, worldState)).toEqual([]);
    // The history starts with the backstory, unchanged.
    expect(truth.events().filter(({ t }) => t < content.preset.time.historyStartMinutes)).toEqual(
      [...world.history].sort((a, b) => a.t - b.t),
    );
    expect(history.locationsAtStart.get(incident.culpritId)).toBe(hall);
  });

  test('is deterministic and leaves its input unchanged', () => {
    const { content, world } = prepare(reading);
    const before = stateHash({
      relationships: world.relationships.snapshot(),
      characters: world.characters,
    });
    const digest = (h: HistoryWorld) =>
      stateHash({
        truth: h.truth.serialize(),
        knowledge: [...h.knowledge].map(([id, store]) => [id, store.serialize()]),
        relationships: h.relationshipsAtStart.snapshot(),
        items: h.worldState.items.snapshot(),
        start: [...h.locationsAtStart],
        report: h.historyReport,
      });
    expect(digest(run(world, content))).toBe(digest(run(world, content)));
    expect(
      stateHash({ relationships: world.relationships.snapshot(), characters: world.characters }),
    ).toBe(before);
  });

  test('delays the steps inside their windows when a witness walks in', () => {
    const { content, world } = prepare(reading);
    const read = world.plot.steps.find(({ id }) => id === 'read')!;
    const w = read.window.from;
    // The witness reaches the archive at the window start and leaves three minutes later.
    const frustrated = withRoutine(
      world,
      'ch_3',
      routine([0, day(w) - 2, hall], [day(w) - 2, day(w) + 3, archive], [day(w) + 3, 1440, hall]),
    );
    const history = run(frustrated, content);
    const { attempts, steps, maxShift } = history.historyReport;
    expect(maxShift).toBe(6);
    expect(attempts.map(({ shift }) => shift)).toEqual([0, 1, 2, 3]);
    expect(
      attempts.slice(0, 3).every(({ problems }) => problems.join() === 'read: witnessed by ch_3'),
    ).toBe(true);
    expect(steps.map(({ id, t }) => [id, t])).toEqual([
      ['take_record', world.plot.opportunity.acquisition!.at],
      ['read', w + 3],
    ]);
    // The scene's step leads the key events.
    expect(history.truth.incident.keyEventIds).toEqual([steps[1]!.eventId, steps[0]!.eventId]);
    expect(checkTruthInvariants(history.truth, history.worldState)).toEqual([]);
  });

  test('rejects the attempt when no delay inside the windows avoids the witness', () => {
    const { content, world } = prepare(reading);
    const w = world.plot.steps.find(({ id }) => id === 'read')!.window.from;
    const frustrated = withRoutine(
      world,
      'ch_3',
      routine([0, day(w) - 2, hall], [day(w) - 2, day(w) + 30, archive], [day(w) + 30, 1440, hall]),
    );
    const result = simulateHistory(frustrated, content);
    expect(result).toBeInstanceOf(GenerationRejection);
    const rejection = result as GenerationRejection;
    expect(rejection.code).toBe(HISTORY_PLOT_FRUSTRATED);
    const attempts = rejection.diagnostics!['attempts'] as { shift: number; problems: string[] }[];
    expect(attempts.map(({ shift }) => shift)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(attempts.every(({ problems }) => problems.includes('read: witnessed by ch_3'))).toBe(
      true,
    );
  });

  test('rejects a plan whose means is gone before the take', () => {
    const { content, world } = prepare();
    const { at } = world.plot.opportunity.acquisition!;
    // The record now leaves with ch_3 before the culprit arrives (a world the plan did not see).
    const moved: PlotWorld = {
      ...world,
      world: {
        ...world.world,
        createWorldState(owners) {
          const state = world.world.createWorldState(owners);
          state.items.move('it_log', { kind: 'character', id: 'ch_3' }, at - 1, 'ev_1');
          return state;
        },
      },
    };
    const result = simulateHistory(moved, content);
    expect(result).toBeInstanceOf(GenerationRejection);
    expect((result as GenerationRejection).message).toContain(
      'take_record: the means is not at loc_archive',
    );
  });

  test('a murder kills the victim at the end of the lethal step; the body stays', () => {
    const { content, world } = prepare(
      {
        crime: {
          incidentType: 'murder',
          plan: [
            { step: 'take_record', verb: 'take', target: '$means', duration: 1, before: 'strike' },
            { step: 'strike', verb: 'strike', target: '$victim', duration: 2 },
          ],
          requires: { minWindowMinutes: 5 },
        },
        routines: { ch_2: routine([0, 1440, archive]) },
      },
      ['murder'],
    );
    const history = run(world, content);
    const { truth, incident, historyReport } = history;
    const strike = historyReport.steps.find(({ id }) => id === 'strike')!;
    const deathAt = strike.t + 2;
    expect(historyReport.deathAt).toBe(deathAt);

    const death = truth.events().find(({ verb }) => verb === DEATH_VERB)!;
    expect(death).toMatchObject({
      t: deathAt,
      actorIds: [incident.victimId],
      location: archive,
      causes: [strike.eventId],
      visibility: 'public',
    });
    expect(death.facts).toEqual([
      {
        kind: 'state',
        entity: { kind: 'character', id: incident.victimId },
        property: 'alive',
        value: false,
        interval: { from: deathAt, to: 0 },
      },
      { kind: 'at', who: incident.victimId, where: archive, interval: { from: deathAt, to: 0 } },
    ]);
    // The victim does nothing after death, and its knowledge stops then.
    const acts = truth
      .events()
      .filter(({ actorIds, id }) => actorIds.includes(incident.victimId) && id !== death.id);
    expect(Math.max(...acts.map(({ t, duration }) => t + duration))).toBeLessThanOrEqual(deathAt);
    const learned = JSON.parse(history.knowledge.get(incident.victimId)!.serialize()) as {
      acquiredAt: number;
    }[];
    expect(Math.max(...learned.map(({ acquiredAt }) => acquiredAt))).toBeLessThan(deathAt);
    // The culprit, present, sees the death.
    expect(
      history.knowledge
        .get(incident.culpritId)!
        .query({ kind: 'did', who: incident.victimId, verb: DEATH_VERB }),
    ).toHaveLength(1);
    expect(history.locationsAtStart.get(incident.victimId)).toBe(archive);
    expect(checkTruthInvariants(truth, history.worldState)).toEqual([]);
  });

  test('a delayed death happens at the planned minute wherever the victim is', () => {
    const { content, world } = prepare(
      {
        crime: {
          incidentType: 'murder',
          plan: [
            { step: 'take_record', verb: 'take', target: '$means', duration: 1, before: 'poison' },
            { step: 'poison', verb: 'poison', target: '$victim', duration: 2 },
          ],
          requires: { minWindowMinutes: 5 },
          deathDelayMinutes: [10, 20],
        },
        routines: { ch_2: routine([0, 460, archive], [460, 1440, hall]) },
      },
      ['murder'],
    );
    expect(world.plot.deathAt).toBeDefined();
    const history = run(world, content);
    const death = history.truth.events().find(({ verb }) => verb === DEATH_VERB)!;
    expect(death.t).toBe(world.plot.deathAt);
    expect(death.location).toBe(history.truth.whereWas(world.incident.victimId, death.t));
    expect(checkTruthInvariants(history.truth, history.worldState)).toEqual([]);
  });

  test('conversations spread observations, but the culprit keeps the incident to itself', () => {
    const { content, world } = prepare(reading);
    const culprit = world.incident.culpritId;
    const friends = new RelationshipGraph(
      world.characters
        .filter(({ id }) => id !== culprit)
        .map(({ id }) => ({
          a: culprit,
          b: id,
          type: 'friendship' as const,
          trust: 1,
          valence: 1,
          intensity: 0.5,
        })),
    );
    const history = run({ ...world, relationships: friends }, content);
    const told = history.truth.events().filter(({ verb }) => verb === 'talk');
    expect(told.length).toBe(history.historyReport.encounters);
    expect(told.length).toBeGreaterThan(0);
    for (const [id, store] of history.knowledge) {
      if (id === culprit) continue;
      const beliefs = JSON.parse(store.serialize()) as {
        source: string;
        proposition: { kind: string; who?: string };
      }[];
      expect(
        beliefs.filter(
          ({ source, proposition }) =>
            source === 'told' && proposition.who === culprit && proposition.kind === 'did',
        ),
      ).toEqual([]);
    }
    // Drift happened on the copy only.
    expect(history.relationshipsAtStart.snapshot().some(({ history: h }) => h.length > 0)).toBe(
      true,
    );
    expect(friends.snapshot().every(({ history: h }) => h.length === 0)).toBe(true);
  });
});
