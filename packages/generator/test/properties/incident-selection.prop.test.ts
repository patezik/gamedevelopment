import { createRng } from '@hs/core/rng';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  assessIncidents,
  GenerationRejection,
  worldGen,
  type IncidentSelectionInput,
} from '../../src/index.ts';
import {
  incidentInput,
  minimal,
  motive,
  oracle,
  sanatorium,
  silent,
  trySelect,
  withIncident,
} from '../support/incident.ts';

const base = incidentInput(minimal, 'property');
const ids = base.characters.map(({ id }) => id).sort();

/** Block boundaries near the 07:00–08:00 history so that they matter. */
const routine = fc
  .record({
    cuts: fc.uniqueArray(fc.integer({ min: 400, max: 500 }), { maxLength: 5 }),
    blocks: fc.array(
      fc.record({
        location: fc.constantFrom('loc_hall', 'loc_archive'),
        activity: fc.constantFrom('wait', 'sleep', 'read'),
      }),
      { minLength: 6, maxLength: 6 },
    ),
  })
  .map(({ cuts, blocks }) => {
    const bounds = [0, ...[...cuts].sort((a, b) => a - b), 1440];
    return bounds.slice(1).map((to, index) => ({
      from: bounds[index]!,
      to,
      ...blocks[index]!,
      flexibility: 0,
    }));
  });

const scenarioArbitrary = fc.record({
  routines: fc.tuple(routine, routine, routine),
  motives: fc.array(
    fc.record({
      who: fc.constantFrom(...ids),
      against: fc.constantFrom(...ids),
      strength: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    { maxLength: 8 },
  ),
  window: fc.integer({ min: 1, max: 40 }),
  locationTags: fc.constantFrom<string[]>(['archive'], [], ['public'], ['archive', 'public']),
  target: fc.constantFrom('$means', '$victim'),
  deathDelay: fc.option(
    fc
      .tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }))
      .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
    { nil: undefined },
  ),
  honesty: fc.option(fc.constantFrom({ gt: 0.6 }, { lt: 0.6 }), { nil: undefined }),
  access: fc.option(
    fc.tuple(fc.integer({ min: 400, max: 500 }), fc.integer({ min: 400, max: 500 })),
    { nil: undefined },
  ),
  gamma: fc.double({ min: 0, max: 2, noNaN: true }),
  seed: fc.string({ maxLength: 8 }),
});

type Generated = typeof scenarioArbitrary extends fc.Arbitrary<infer T> ? T : never;

function build(g: Generated) {
  const content = withIncident(
    {
      ...minimal,
      locations: minimal.locations.map((location) =>
        location.id === 'loc_archive' && g.access
          ? { ...location, access: [{ from: g.access[0], to: g.access[1] }] }
          : location,
      ),
      crimes: minimal.crimes.map((crime) => ({
        ...crime,
        requires: {
          ...crime.requires,
          minWindowMinutes: g.window,
          locationTags: g.locationTags,
          traits: g.honesty ? { honesty: g.honesty } : {},
        },
        plan: [{ step: 'act', verb: 'take', target: g.target, duration: 1 }],
        ...(g.deathDelay && { deathDelayMinutes: g.deathDelay }),
      })),
    },
    { gamma: g.gamma },
  );
  const world = worldGen.generate(undefined, {
    rng: createRng('property').fork('gen/WorldGen'),
    content,
    logger: silent,
  });
  const input: IncidentSelectionInput = {
    ...base,
    world,
    characters: base.characters.map((c, index) => ({ ...c, routine: g.routines[index]! })),
    motives: g.motives
      .filter(({ who, against }) => who !== against)
      .map(({ who, against, strength }) => motive(who, against, strength)),
  };
  return { content, input };
}

describe('IncidentSelection properties', () => {
  test('feasibility equals the minute-by-minute oracle for every character and victim', () => {
    fc.assert(
      fc.property(scenarioArbitrary, (g) => {
        const { content, input } = build(g);
        for (const option of assessIncidents(input, content).options) {
          const feasible = new Map(option.feasible.map((f) => [f.characterId, f]));
          const rejected = { motive: 0, capable: 0, means: 0, opportunity: 0 };
          for (const culprit of ids.filter((id) => id !== option.victimId)) {
            const expected = oracle(input, content, culprit, option.victimId, option.templateId);
            const actual = feasible.get(culprit);
            if (typeof expected === 'string') {
              expect(actual).toBeUndefined();
              rejected[expected]++;
            } else {
              expect(
                new Map(actual!.opportunities.map(({ locationId, from }) => [locationId, from])),
              ).toEqual(expected);
              expect(actual!.score).toBeGreaterThan(0);
              expect(actual!.score).toBeLessThanOrEqual(1);
            }
          }
          expect(option.rejected).toEqual(rejected);
        }
      }),
      { numRuns: 150, seed: 6006 },
    );
  }, 120_000);

  test('the chosen culprit is feasible and never the victim; empty worlds are rejected', () => {
    fc.assert(
      fc.property(scenarioArbitrary, (g) => {
        const { content, input } = build(g);
        const result = trySelect(input, content, g.seed);
        const options = assessIncidents(input, content).options;
        if (result instanceof GenerationRejection) {
          expect(options.every(({ feasible }) => feasible.length === 0)).toBe(true);
          return;
        }
        const { incident } = result;
        expect(incident.culpritId).not.toBe(incident.victimId);
        expect(
          oracle(input, content, incident.culpritId, incident.victimId, incident.templateId),
        ).toBeInstanceOf(Map);
        expect(incident.motive.strength).toBeGreaterThanOrEqual(content.preset.incident.minMotive);
        expect(trySelect(input, content, g.seed)).toEqual(result);
      }),
      { numRuns: 150, seed: 6007 },
    );
  }, 120_000);

  test('sanatorium_winter: the chosen culprit satisfies every criterion', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (seed) => {
        const input = incidentInput(sanatorium, `p${seed}`);
        const result = trySelect(input, sanatorium, `p${seed}`);
        if (result instanceof GenerationRejection) return;
        const { incident } = result;
        expect(incident.culpritId).not.toBe(incident.victimId);
        expect(
          oracle(input, sanatorium, incident.culpritId, incident.victimId, incident.templateId),
        ).toBeInstanceOf(Map);
      }),
      { numRuns: 25, seed: 6008 },
    );
  }, 120_000);
});
