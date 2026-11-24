import { readFileSync } from 'node:fs';
import type { ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import { describe, expect, test } from 'vitest';
import {
  everyMotive,
  incidentInput,
  minimal,
  motive,
  oracle,
  sanatorium,
  select,
  silent,
  stay,
  trySelect,
  withCrime,
  withIncident,
  withRoutine,
} from '../../test/support/incident.ts';
import {
  assessIncidents,
  DEFAULT_CULPRIT_GAMMA,
  FEASIBILITY_CRITERIA,
  GenerationRejection,
  INCIDENT_NO_FEASIBLE_CULPRIT,
  incidentSelection,
  runPipeline,
  SCORE_WEIGHTS,
  type IncidentSelectionInput,
  type Stage,
} from '../index.ts';

const base = incidentInput(minimal, 'base');
const ids = base.characters.map(({ id }) => id).sort();
/** Everyone has a motive against everyone: only the criterion under test decides. */
const open: IncidentSelectionInput = { ...base, motives: everyMotive(base) };

function rejections(input: IncidentSelectionInput, content = minimal) {
  const totals = Object.fromEntries(FEASIBILITY_CRITERIA.map((c) => [c, 0]));
  for (const option of assessIncidents(input, content).options) {
    for (const criterion of FEASIBILITY_CRITERIA) totals[criterion]! += option.rejected[criterion];
  }
  return totals;
}

function feasiblePairs(input: IncidentSelectionInput, content = minimal) {
  return assessIncidents(input, content).options.flatMap(({ victimId, feasible }) =>
    feasible.map(({ characterId }) => `${characterId}>${victimId}`),
  );
}

describe('IncidentSelection on _test_minimal', () => {
  test('chooses victim, template and culprit and reports the feasible set', () => {
    const { incident, incidentReport } = select(open, minimal);
    expect(incident.culpritId).not.toBe(incident.victimId);
    expect(incident).toMatchObject({
      type: 'theft',
      templateId: 'missing_record',
      meansItemIds: ['it_log'],
      // History is 07:00–08:00; the archive is 2 minutes from the hall, so the culprit leaves
      // the hall block at −60 and arrives at −58. The window ends by t = 0.
      opportunities: [{ locationId: 'loc_archive', from: -58, to: -53, starts: 54 }],
    });
    expect(incident.motive).toEqual(motive(incident.culpritId, incident.victimId));
    expect(incident.score).toBeCloseTo(
      SCORE_WEIGHTS.motive * 0.5 + SCORE_WEIGHTS.opportunity * 0.9 + SCORE_WEIGHTS.personality,
    );
    expect(incidentReport).toEqual({
      gamma: DEFAULT_CULPRIT_GAMMA,
      victimsEligible: 3,
      feasibleCulpritCount: 2,
      feasibleTriples: 6,
      byTemplate: { missing_record: { victimsWithCulprit: 3, pairs: 6, culprits: ids } },
      rejected: { motive: 0, capable: 0, means: 0, opportunity: 0 },
      chosen: {
        victimArchetype: 'visitor',
        culpritArchetype: 'visitor',
        template: 'missing_record',
        motiveType: 'protect_record',
      },
    });
  });

  test('checks every character except the victim, with no predefined list', () => {
    const assessment = assessIncidents(base, minimal);
    expect(assessment.victimIds).toEqual(ids);
    for (const option of assessment.options) {
      const rejected = Object.values(option.rejected).reduce((sum, n) => sum + n, 0);
      expect(option.feasible.length + rejected).toBe(ids.length - 1);
      expect(option.feasible.map(({ characterId }) => characterId)).not.toContain(option.victimId);
    }
  });

  test('motive: the strongest candidate at or above minMotive', () => {
    const [a, b] = ids as [string, string];
    const input = {
      ...base,
      motives: [motive(a, b, 0.3), motive(a, b, 0.45), { ...motive(a, b, 0.45), motiveType: 'aa' }],
    };
    expect(feasiblePairs(input)).toEqual([`${a}>${b}`]);
    const option = assessIncidents(input, minimal).options.find((o) => o.victimId === b)!;
    expect(option.feasible[0]!.motive.motiveType).toBe('aa');
    expect(feasiblePairs(input, withIncident(minimal, { minMotive: 0.5 }))).toEqual([]);
    expect(rejections(input, withIncident(minimal, { minMotive: 0.5 })).motive).toBe(6);
  });

  test('capable: personality bounds of the template', () => {
    const traits = (value: ScenarioContent['crimes'][number]['requires']['traits']) =>
      withCrime(minimal, (crime) => ({ ...crime, requires: { ...crime.requires, traits: value } }));
    expect(rejections(open, traits({ honesty: { gt: 0.9 } })).capable).toBe(6);
    const fits = assessIncidents(open, traits({ honesty: { lt: 0.9 } })).options.flatMap(
      ({ feasible }) => feasible,
    );
    expect(fits).toHaveLength(6);
    for (const { characterId, personalityFit } of fits) {
      const honesty = open.characters.find(({ id }) => id === characterId)!.personality.honesty;
      expect(personalityFit).toBeCloseTo((0.9 - honesty) / 0.9, 5);
    }
    expect(() => assessIncidents(open, traits({ courage: 0.3 }))).toThrow(RangeError);
    expect(() => assessIncidents(open, traits({ luck: { gt: 0.1 } }))).toThrow(RangeError);
    expect(() => assessIncidents(open, traits({ honesty: { gt: 0.8, lt: 0.2 } }))).toThrow(
      'never hold',
    );
    expect(() => assessIncidents(open, traits({ honesty: { gt: 2 } }))).toThrow(RangeError);
  });

  test('means: an item with the tag, reachable within history', () => {
    const tag = (itemTag: string) =>
      withCrime(minimal, (crime) => ({
        ...crime,
        requires: { ...crime.requires, means: { itemTag } },
      }));
    expect(rejections(open, tag('poison')).means).toBe(6);
    expect(feasiblePairs(open, tag('record'))).toHaveLength(6);

    // The archive opens only 00:00–01:00, outside the 07:00–08:00 history.
    const closed = {
      ...minimal,
      locations: minimal.locations.map((location) =>
        location.id === 'loc_archive' ? { ...location, access: [{ from: 0, to: 60 }] } : location,
      ),
    };
    expect(rejections({ ...incidentInput(closed, 'base'), motives: open.motives }, closed)).toEqual(
      { motive: 0, capable: 0, means: 6, opportunity: 0 },
    );
  });

  test('means: a locked door needs a key the culprit holds', () => {
    const locked = {
      ...minimal,
      items: [
        ...minimal.items,
        { id: 'it_key', name: 'Ключ', kind: 'key', tags: ['key'], ownerArchetype: 'visitor' },
      ],
      locations: minimal.locations.map((location) =>
        location.id === 'loc_hall'
          ? {
              ...location,
              connections: [{ to: 'loc_archive', minutes: 2, locked: { itemId: 'it_key' } }],
            }
          : location,
      ),
    };
    const input = { ...incidentInput(locked, 'base'), motives: open.motives };
    // The first visitor by id holds the key; the others cannot reach the record.
    const holder = ids[0]!;
    expect(new Set(feasiblePairs(input, locked).map((pair) => pair.split('>')[0]))).toEqual(
      new Set([holder]),
    );
    expect(rejections(input, locked).means).toBe(4);
  });

  test('opportunity: an awake witness at the scene blocks the window, a sleeper does not', () => {
    const [a, b, c] = ids as [string, string, string];
    const watched = withRoutine(open, { [c]: stay('loc_archive', 'read') });
    // Only the reader, already alone in the archive, can take the record.
    expect(new Set(feasiblePairs(watched).map((pair) => pair.split('>')[0]))).toEqual(new Set([c]));
    expect(rejections(watched).opportunity).toBe(4);
    const asleep = withRoutine(open, { [c]: stay('loc_archive', 'sleep') });
    expect(feasiblePairs(asleep)).toHaveLength(6);
    const reader = assessIncidents(watched, minimal)
      .options.find(({ victimId }) => victimId === a)!
      .feasible.find(({ characterId }) => characterId === c)!;
    // No routine block is bent: the whole history is usable.
    expect(reader.opportunities).toEqual([
      { locationId: 'loc_archive', from: -60, to: -55, starts: 56 },
    ]);
    expect(reader.opportunityQuality).toBeCloseTo(56 / 60, 5);
    expect(b).toBeDefined();
  });

  test('opportunity: the window must fit into history', () => {
    const long = withCrime(minimal, (crime) => ({
      ...crime,
      requires: { ...crime.requires, minWindowMinutes: 59 },
    }));
    expect(rejections(open, long).opportunity).toBe(6);
    const fits = withCrime(minimal, (crime) => ({
      ...crime,
      requires: { ...crime.requires, minWindowMinutes: 56 },
    }));
    expect(feasiblePairs(open, fits)).toHaveLength(6);
  });

  test('opportunity: at most one routine block is bent', () => {
    // Blocks of 2 minutes: any 5-minute window away from the archive bends at least 3 of them.
    const choppy = Array.from({ length: 720 }, (_, index) => ({
      from: index * 2,
      to: index * 2 + 2,
      location: 'loc_hall',
      activity: index % 2 ? 'wait' : 'read',
      flexibility: 0,
    }));
    const [a] = ids as [string];
    const input = withRoutine(
      open,
      Object.fromEntries(base.characters.map(({ id }) => [id, choppy])),
    );
    expect(rejections(input).opportunity).toBe(6);
    // The same fragmented routine inside the archive bends nothing.
    const inside = choppy.map((block) => ({
      ...block,
      location: 'loc_archive',
      activity: 'sleep',
    }));
    expect(
      new Set(feasiblePairs(withRoutine(input, { [a]: inside })).map((p) => p.split('>')[0])),
    ).toEqual(new Set([a]));
  });

  test('opportunity: a plan on the victim needs the victim at the scene', () => {
    const onVictim = withCrime(minimal, (crime) => ({
      ...crime,
      plan: [{ step: 'act', verb: 'take', target: '$victim', duration: 5 }],
    }));
    expect(rejections(open, onVictim).opportunity).toBe(6);
    const [a] = ids as [string];
    const victimThere = withRoutine(open, { [a]: stay('loc_archive', 'read') });
    // The victim in the archive is not a witness; only the plans against them are feasible.
    expect(feasiblePairs(victimThere, onVictim).sort()).toEqual(
      ids.filter((id) => id !== a).map((id) => `${id}>${a}`),
    );
  });

  test('opportunity: a delayed death needs the victim at the scene later', () => {
    const delayed = withCrime(minimal, (crime) => ({ ...crime, deathDelayMinutes: [10, 20] }));
    expect(rejections(open, delayed).opportunity).toBe(6);
    const [a, b] = ids as [string, string];
    // The victim walks into the archive at 07:30 (t = −30) and stays.
    const later = withRoutine(
      { ...open, motives: [motive(b, a)] },
      {
        [a]: [
          { from: 450, to: 1440, location: 'loc_archive', activity: 'read', flexibility: 0 },
          { from: 0, to: 450, location: 'loc_hall', activity: 'wait', flexibility: 0 },
        ],
      },
    );
    const [option] = assessIncidents(later, delayed).options.filter((o) => o.feasible.length);
    // The window ends by −30 (the victim would witness it) and at least −50 (death by −30).
    expect(option!.feasible[0]!.opportunities).toEqual([
      { locationId: 'loc_archive', from: -55, to: -50, starts: 21 },
    ]);
    expect(oracle(later, delayed, b, a, 'missing_record')).toEqual(new Map([['loc_archive', -55]]));
  });

  test('scenes carry every required location tag', () => {
    const tags = (locationTags: string[]) =>
      withCrime(minimal, (crime) => ({ ...crime, requires: { ...crime.requires, locationTags } }));
    expect(rejections(open, tags(['archive', 'public'])).opportunity).toBe(6);
    const anywhere = assessIncidents(open, tags([])).options[0]!.feasible[0]!;
    // With no tags both rooms qualify; in the hall others are awake witnesses.
    expect(anywhere.opportunities.map(({ locationId }) => locationId)).toEqual(['loc_archive']);
  });

  test('victim constraints and allowed templates', () => {
    expect(assessIncidents(open, minimal).victimIds).toEqual(ids);
    const none = withIncident(minimal, { victimConstraints: { excludeArchetypes: ['visitor'] } });
    expect(assessIncidents(open, none)).toMatchObject({ victimIds: [], options: [] });
    expect(trySelect(open, none)).toBeInstanceOf(GenerationRejection);
    const otherType = withIncident(minimal, { types: ['murder'] });
    expect(assessIncidents(open, otherType).templateIds).toEqual([]);
    expect(() => assessIncidents(open, withIncident(minimal, { templates: ['nope'] }))).toThrow(
      'not in crimes.json',
    );
  });

  test('no feasible culprit: the stage rejects the world with its report', () => {
    const rejection = trySelect({ ...base, motives: [] }, minimal);
    expect(rejection).toBeInstanceOf(GenerationRejection);
    const { code, diagnostics } = rejection as GenerationRejection;
    expect(code).toBe(INCIDENT_NO_FEASIBLE_CULPRIT);
    expect(diagnostics).toMatchObject({
      incidentReport: { feasibleTriples: 0, rejected: { motive: 6 } },
    });
  });

  test('the pipeline regenerates a rejected world with the next attempt seed', () => {
    // Attempt 1 has no motives; later attempts get the real ones.
    const prepare: Stage<undefined, IncidentSelectionInput> = {
      name: 'Prepare',
      generate: (_input, { rng }) =>
        rng.fork('probe').nextU32() ===
        createRng('winter#1').fork('gen/Prepare').fork('probe').nextU32()
          ? { ...open, motives: [] }
          : open,
    };
    const result = runPipeline([prepare, incidentSelection], undefined, {
      seed: 'winter',
      content: minimal,
      now: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(
      result.report.attempts.map(({ accepted, rejection }) => [accepted, rejection?.code]),
    ).toEqual([
      [false, INCIDENT_NO_FEASIBLE_CULPRIT],
      [true, undefined],
    ]);
    expect(result.report.attempts[0]!.rejection).toMatchObject({ stage: 'IncidentSelection' });

    const never = runPipeline(
      [{ ...prepare, generate: () => ({ ...open, motives: [] }) }, incidentSelection],
      undefined,
      {
        seed: 'winter',
        content: minimal,
        maxAttempts: 3,
        now: () => 0,
      },
    );
    expect(never).toMatchObject({ ok: false, error: 'GENERATION_UNSOLVABLE' });
    expect(never.report.attempts).toHaveLength(3);
  });

  test('gamma comes from the preset, 0.7 by default', () => {
    expect(select(open, minimal).incidentReport.gamma).toBe(0.7);
    expect(select(open, withIncident(minimal, { gamma: 0 })).incidentReport.gamma).toBe(0);
  });

  test('deterministic and independent of character and motive order', () => {
    const first = JSON.stringify(select(open, minimal, 'det').incident);
    expect(JSON.stringify(select(open, minimal, 'det').incident)).toBe(first);
    const shuffled = {
      ...open,
      characters: [...open.characters].reverse(),
      motives: [...open.motives].reverse(),
    };
    expect(JSON.stringify(select(shuffled, minimal, 'det').incident)).toBe(first);
    const seen = new Set(
      Array.from({ length: 30 }, (_, i) => select(open, minimal, `s${i}`).incident.culpritId),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  test('no suspect concept in code, content or output', () => {
    const source = readFileSync(new URL('./incident-selection.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/suspect/i);
    expect(JSON.stringify([minimal.crimes, minimal.motives, minimal.preset])).not.toMatch(
      /suspect|culprit/i,
    );
    const output = select(open, minimal);
    expect(JSON.stringify({ ...output, relationships: undefined, world: undefined })).not.toMatch(
      /suspect/i,
    );
  });

  test('rejects invalid input', () => {
    expect(() =>
      assessIncidents({ ...open, characters: [...open.characters, open.characters[0]!] }, minimal),
    ).toThrow('unique');
    const gap = withRoutine(open, {
      [ids[0]!]: [{ from: 0, to: 100, location: 'loc_hall', activity: 'wait', flexibility: 0 }],
    });
    expect(() => assessIncidents(gap, minimal)).toThrow('gap');
    expect(() =>
      incidentSelection.generate(open, {
        rng: createRng('x'),
        content: withIncident(minimal, { templates: ['missing'] }),
        logger: silent,
      }),
    ).toThrow(RangeError);
  });
});

describe('IncidentSelection on sanatorium_winter', () => {
  test('poisoning needs both required tags; the plan respects every criterion', () => {
    const outcomes = Array.from({ length: 40 }, (_, seed) => {
      const input = incidentInput(sanatorium, String(seed));
      return { input, result: trySelect(input, sanatorium, String(seed)) };
    });
    const chosen = outcomes.filter(({ result }) => !(result instanceof GenerationRejection));
    expect(chosen.length).toBeGreaterThan(0);
    for (const { input, result } of chosen) {
      if (result instanceof GenerationRejection) continue;
      const { incident } = result;
      const windows = oracle(
        input,
        sanatorium,
        incident.culpritId,
        incident.victimId,
        incident.templateId,
      );
      expect(windows).toBeInstanceOf(Map);
      expect(
        new Map(incident.opportunities.map(({ locationId, from }) => [locationId, from])),
      ).toEqual(windows);
      if (incident.templateId === 'poisoning') {
        // locationTags ["private", "medical"]: only the doctor's office has both.
        expect(incident.opportunities.map(({ locationId }) => locationId)).toEqual([
          'loc_doctor_office',
        ]);
      }
    }
  });
});
