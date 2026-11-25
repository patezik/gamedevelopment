import { createRng } from '@hs/core/rng';
import { ItemError } from '@hs/core/world';
import { describe, expect, test } from 'vitest';
import { fixture, place, routine, type FixtureOptions } from '../../test/support/fixture.ts';
import {
  incidentInput,
  motive,
  sanatorium,
  silent,
  trySelect,
} from '../../test/support/incident.ts';
import {
  assessIncidents,
  castGen,
  conflictGen,
  GENERATOR_VERSION,
  GenerationRejection,
  incidentSelection,
  runPipeline,
  socialGen,
  worldGen,
  type FeasibleCulprit,
  type IncidentSelectionInput,
  type Opportunity,
  type Stage,
} from '../index.ts';

/*
 * Regression tests for the independent review of PR #92 (FIX REQUIRED). Every fixture is a
 * controlled world on top of _test_minimal: the scenario starts at 08:00, the hall and the
 * archive are 2 minutes apart, the record lies in the archive. Only ch_1 has a motive (against
 * ch_2) unless stated otherwise.
 */

type Verdict = FeasibleCulprit | 'motive' | 'capable' | 'means' | 'opportunity';

function verdict(options: FixtureOptions, culprit = 'ch_1', victim = 'ch_2'): Verdict {
  const { content, input } = fixture(options);
  const option = assessIncidents(input, content).options.find((o) => o.victimId === victim)!;
  const found = option.feasible.find(({ characterId }) => characterId === culprit);
  if (found) return found;
  const failed = Object.entries(option.rejected).find(([key, n]) => key !== 'motive' && n > 0);
  return (failed?.[0] as Verdict | undefined) ?? 'motive';
}

function feasible(result: Verdict): FeasibleCulprit {
  if (typeof result === 'string') throw new Error(`Expected a feasible culprit, got ${result}`);
  return result;
}

const hallScene = { requires: { locationTags: ['public'] } };

describe('defect 1: means and window are one compatible pair', () => {
  test('no time to fetch the record before a hall window', () => {
    // 07:55–08:00: going to the archive and back takes 4 of the 5 minutes.
    const late = {
      historyStart: -5,
      crime: hallScene,
      routines: {
        ch_2: routine([0, 1440, 'loc_archive']),
        ch_3: routine([0, 1440, 'loc_archive']),
      },
    };
    expect(verdict(late)).toBe('opportunity');
    // With 15 minutes: archive at −13, take the record, back in the hall at −10.
    const [window] = feasible(verdict({ ...late, historyStart: -15 })).opportunities;
    expect(window).toMatchObject({
      locationId: 'loc_hall',
      from: -10,
      to: -5,
      meansItemId: 'it_log',
      acquisition: { locationId: 'loc_archive', at: -13 },
    });
  });

  test('a means held by another character needs a meeting with the holder', () => {
    const ring = {
      id: 'it_ring',
      name: 'Кольцо',
      kind: 'misc',
      tags: ['record'],
      ownerArchetype: 'visitor',
    };
    const closed = place('loc_archive', ['archive'], { loc_hall: 2 }, [{ from: 0, to: 60 }]);
    const options = {
      items: [...fixture().content.items, ring],
      crime: {
        requires: { locationTags: ['public'], means: { itemTag: 'record', itemId: 'it_ring' } },
      },
      // ch_1 holds the ring (first visitor) and stays in the archive, closed during history.
      routines: {
        ch_1: routine([0, 1440, 'loc_archive']),
        ch_3: routine([0, 1440, 'loc_archive']),
      },
      motives: [motive('ch_2', 'ch_3')],
    };
    const hall = place('loc_hall', ['public'], { loc_archive: 2 });
    expect(verdict({ ...options, locations: [hall, closed] }, 'ch_2', 'ch_3')).toBe('means');
    const open = feasible(verdict(options, 'ch_2', 'ch_3'));
    expect(open.opportunities[0]).toMatchObject({
      locationId: 'loc_hall',
      from: -55,
      meansItemId: 'it_ring',
      acquisition: { locationId: 'loc_archive', at: -58, fromCharacterId: 'ch_1' },
    });
  });

  test('keys of one means are not combined with the time of another', () => {
    // The archive door needs it_key, which lies in a shed open only 07:55–08:00. it_bar lies in
    // the hall from the start but opens nothing.
    const locations = [
      place('loc_hall', ['public'], { loc_archive: 2, loc_shed: 1 }, [], { loc_archive: 'it_key' }),
      place('loc_archive', ['archive'], { loc_hall: 2 }),
      place('loc_shed', ['shed'], { loc_hall: 1 }, [{ from: 475, to: 480 }]),
    ];
    const items = [
      ...fixture().content.items,
      { id: 'it_key', name: 'Ключ', kind: 'key', tags: ['tool'], locationId: 'loc_shed' },
      { id: 'it_bar', name: 'Лом', kind: 'tool', tags: ['tool'], locationId: 'loc_hall' },
    ];
    const options = {
      locations,
      items,
      crime: { requires: { means: { itemTag: 'tool' }, minWindowMinutes: 3 } },
    };
    expect(verdict(options)).toBe('opportunity');
    // A one-minute window fits: shed at −5, hall at −3, archive at −1.
    const [window] = feasible(
      verdict({
        ...options,
        crime: { requires: { ...options.crime.requires, minWindowMinutes: 1 } },
      }),
    ).opportunities;
    expect(window).toMatchObject({
      locationId: 'loc_archive',
      from: -1,
      meansItemId: 'it_key',
      acquisition: { locationId: 'loc_shed', at: -5 },
    });
  });
});

describe('defect 2: timed access along the route', () => {
  test('a corridor open only 00:00–01:00 blocks the route during history', () => {
    const corridor = (access: { from: number; to: number }[]) => [
      place('loc_hall', ['public'], { loc_corridor: 1 }),
      place('loc_corridor', ['corridor'], { loc_hall: 1, loc_archive: 1 }, access),
      place('loc_archive', ['archive'], { loc_corridor: 1 }),
    ];
    expect(verdict({ locations: corridor([{ from: 0, to: 60 }]) })).toBe('means');
    const [window] = feasible(verdict({ locations: corridor([]) })).opportunities;
    expect(window).toMatchObject({ locationId: 'loc_archive', from: -57 });
  });
});

describe('defect 3: physical presence from the simulation', () => {
  test('the victim walking into the scene is in transit, not present', () => {
    const options = {
      crime: { plan: [{ step: 'act', verb: 'take', target: '$victim', duration: 5 }] },
      routines: {
        ch_1: routine([0, 1440, 'loc_archive']),
        // Scheduled in the archive from 07:30 (t = −30), physically there from −28.
        ch_2: routine([0, 450, 'loc_hall'], [450, 1440, 'loc_archive']),
      },
    };
    expect(feasible(verdict(options)).opportunities[0]).toMatchObject({ from: -28, to: -23 });
  });

  test('a sleeping character at the scene is a witness', () => {
    const options = { routines: { ch_3: routine([0, 1440, 'loc_archive', 'sleep']) } };
    expect(verdict(options)).toBe('opportunity');
    // The sleeper is alone in the archive and may be the culprit.
    expect(
      feasible(verdict({ ...options, motives: [motive('ch_3', 'ch_2')] }, 'ch_3')),
    ).toBeTruthy();
  });
});

describe('defect 4: bending one block from the actual position', () => {
  test('staying in the archive through a 5-minute hall block needs no travel', () => {
    const options = {
      routines: {
        ch_1: routine(
          [0, 475, 'loc_archive', 'read'],
          [475, 480, 'loc_hall'],
          [480, 1440, 'loc_archive', 'read'],
        ),
        // The witness reads in the archive until 07:55.
        ch_3: routine([0, 475, 'loc_archive', 'read'], [475, 1440, 'loc_hall']),
      },
    };
    const [window] = feasible(verdict(options)).opportunities;
    expect(window).toMatchObject({
      locationId: 'loc_archive',
      from: -5,
      to: 0,
      deviation: { from: -5, to: 0 },
    });
  });
});

describe('defect 4: a window may start before the changed block', () => {
  test('the routine keeps the culprit in the archive until the hall block, which is changed', () => {
    const options = {
      crime: { requires: { minWindowMinutes: 8 } },
      routines: {
        ch_1: routine(
          [0, 475, 'loc_archive', 'read'],
          [475, 480, 'loc_hall'],
          [480, 1440, 'loc_archive', 'read'],
        ),
        // The witness leaves the archive at 07:50 (t = −10).
        ch_3: routine([0, 470, 'loc_archive', 'read'], [470, 1440, 'loc_hall']),
      },
    };
    const [window] = feasible(verdict(options)).opportunities;
    expect(window).toMatchObject({ from: -10, to: -2, deviation: { from: -5, to: -2 } });
  });
});

describe('defect 5: the death happens before the investigation starts', () => {
  const delayed = (arrives: number, historyStart = -120) => ({
    historyStart,
    crime: { deathDelayMinutes: [60, 60] as [number, number] },
    routines: {
      ch_1: routine([0, 1440, 'loc_archive']),
      ch_2: routine([0, arrives, 'loc_hall'], [arrives, 1440, 'loc_archive']),
    },
  });

  test('victim in the scene at −2: death at −2, window ends at −62', () => {
    const [window] = feasible(verdict(delayed(476))).opportunities;
    expect(window).toMatchObject({ from: -67, to: -62, deathAt: -2 });
  });

  test('victim in the scene only from t = 0: rejected', () => {
    expect(verdict(delayed(478))).toBe('opportunity');
  });

  test('a delayed death of a present victim must also fall before t = 0', () => {
    const poisoned = (historyStart: number) => ({
      historyStart,
      crime: {
        plan: [{ step: 'act', verb: 'take', target: '$victim', duration: 5 }],
        deathDelayMinutes: [60, 60] as [number, number],
      },
      routines: {
        ch_1: routine([0, 1440, 'loc_archive']),
        ch_2: routine([0, 1440, 'loc_archive']),
      },
    });
    expect(verdict(poisoned(-60))).toBe('opportunity');
    // The record is taken in the first minute of history, the window starts after it.
    expect(feasible(verdict(poisoned(-130))).opportunities[0]).toMatchObject({
      from: -129,
      to: -124,
      deathAt: -64,
    });
    // The only window ends at −61, so the death is at −1; one minute less and it is at 0.
    expect(feasible(verdict(poisoned(-67))).opportunities[0]).toMatchObject({
      to: -61,
      deathAt: -1,
    });
    expect(verdict(poisoned(-66))).toBe('opportunity');
  });
});

describe('defect 6: an owned item whose owner is not in the cast', () => {
  const badge = {
    id: 'it_badge',
    name: 'Бейдж',
    kind: 'misc',
    tags: ['badge'],
    ownerArchetype: 'guest_entrepreneur',
  };
  const content = { ...sanatorium, items: [...sanatorium.items, badge] };
  const prefix: Stage<undefined, IncidentSelectionInput> = {
    name: 'Prefix',
    generate(_input, context) {
      const world = worldGen.generate(undefined, { ...context, rng: context.rng.fork('WorldGen') });
      const cast = castGen.generate(world, { ...context, rng: context.rng.fork('CastGen') });
      const social = socialGen.generate(cast, { ...context, rng: context.rng.fork('SocialGen') });
      const conflict = conflictGen.generate(social, {
        ...context,
        rng: context.rng.fork('ConflictGen'),
      });
      return { ...conflict, world };
    },
  };

  test('rejects the world for regeneration instead of crashing', () => {
    const input = incidentInput(content, '0');
    expect(input.characters.map(({ archetypeId }) => archetypeId)).not.toContain(
      'guest_entrepreneur',
    );
    const result = trySelect(input, content, '0');
    expect(result).toBeInstanceOf(GenerationRejection);
    expect((result as GenerationRejection).code).toBe('WORLD_OWNER_ABSENT');

    const pipeline = runPipeline([prefix, incidentSelection], undefined, {
      seed: 'owners',
      content,
      maxAttempts: 16,
      now: () => 0,
    });
    const codes = pipeline.report.attempts.map(({ rejection }) => rejection?.code);
    expect(codes).toContain('WORLD_OWNER_ABSENT');
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.output.characters.map(({ archetypeId }) => archetypeId)).toContain(
        'guest_entrepreneur',
      );
    }
  });

  test('real data errors still propagate', () => {
    const cycle = {
      ...sanatorium,
      items: [
        ...sanatorium.items,
        { id: 'it_box_a', name: 'A', kind: 'container', tags: ['box'], containerId: 'it_box_b' },
        { id: 'it_box_b', name: 'B', kind: 'container', tags: ['box'], containerId: 'it_box_a' },
      ],
    };
    const input = incidentInput(cycle, '1');
    expect(() =>
      incidentSelection.generate(input, {
        rng: createRng('1#1').fork('gen/IncidentSelection'),
        content: cycle,
        logger: silent,
      }),
    ).toThrow(ItemError);
  });
});

describe('defect 8: the search for a window is not cut short', () => {
  // ch_1 carries it_key (first visitor), the only way out of the archive without it is a bypass
  // open from 07:20 (t = −40). ch_2 reads in the archive all day; ch_1 leaves it at 07:10.
  const keyed = (bypassOpens: number) => ({
    historyStart: -60,
    locations: [
      place('loc_hall', ['public'], { loc_archive: 2, loc_bypass: 1 }),
      place('loc_archive', ['archive'], { loc_hall: 2, loc_bypass: 1 }, [], {
        loc_hall: 'it_key',
      }),
      place('loc_bypass', ['corridor'], { loc_archive: 1, loc_hall: 1 }, [
        { from: bypassOpens, to: 1440 },
      ]),
    ],
    items: [
      ...fixture().content.items,
      { id: 'it_key', name: 'Ключ', kind: 'key', tags: ['key'], ownerArchetype: 'visitor' },
    ],
    crime: { requires: { means: { itemTag: 'key', itemId: 'it_key' } } },
    routines: {
      ch_1: routine([0, 430, 'loc_archive'], [430, 1440, 'loc_hall']),
      ch_2: routine([0, 1440, 'loc_archive', 'read']),
    },
    motives: [motive('ch_2', 'ch_3')],
  });

  test('taking the key traps its holder as a witness; the window after it is found', () => {
    // In the baseline ch_1 leaves at −50. Without the key ch_1 waits for the bypass and leaves
    // at −41, so the windows from −50 to −42 fail in simulation (formerly the search stopped
    // after three of them); the first window that holds starts at −41.
    const found = feasible(verdict(keyed(440), 'ch_2', 'ch_3'));
    expect(found.opportunities).toHaveLength(1);
    const [{ starts, ...window }] = found.opportunities as [Opportunity];
    expect(window).toEqual({
      locationId: 'loc_archive',
      from: -41,
      to: -36,
      meansItemId: 'it_key',
      acquisition: { locationId: 'loc_archive', at: -60, fromCharacterId: 'ch_1' },
      deviation: null,
    });
    expect(starts).toBeGreaterThan(0);
    expect(found.score).toBeGreaterThan(0);
  });

  test('a key holder locked out of the scene is no witness there', () => {
    // The archive door is locked both ways. ch_1 waits in the hall until 07:30 (t = −30), then
    // goes to the archive; in the baseline ch_1 is there from −28, so no 50-minute window fits.
    // ch_2 takes the key from ch_1 in the hall at −60: ch_1 stays locked out of the archive.
    const options = keyed(1439);
    const locked = {
      ...options,
      locations: [
        place('loc_hall', ['public'], { loc_archive: 2 }, [], { loc_archive: 'it_key' }),
        place('loc_archive', ['archive'], { loc_hall: 2 }, [], { loc_hall: 'it_key' }),
      ],
      crime: { requires: { ...options.crime.requires, minWindowMinutes: 50 } },
      routines: { ch_1: routine([0, 450, 'loc_hall'], [450, 1440, 'loc_archive']) },
    };
    const [window] = feasible(verdict(locked, 'ch_2', 'ch_3')).opportunities;
    expect(window).toMatchObject({
      locationId: 'loc_archive',
      from: -57,
      to: -7,
      meansItemId: 'it_key',
      acquisition: { locationId: 'loc_hall', at: -60, fromCharacterId: 'ch_1' },
    });
  });
});

describe('defect 7: generator version', () => {
  test('new results for existing seeds raise the minor version (ADR 0004)', () => {
    expect(GENERATOR_VERSION).toBe('0.3.0');
  });
});
