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
  sanatorium,
  silent,
  trySelect,
  withIncident,
} from '../support/incident.ts';
import { confirm, search } from '../support/oracle.ts';

const base = incidentInput(minimal, 'property');
const ids = base.characters.map(({ id }) => id).sort();

/** Block boundaries near the 07:00–08:00 history so that they matter. */
const routine = fc
  .record({
    cuts: fc.uniqueArray(fc.integer({ min: 400, max: 500 }), { maxLength: 5 }),
    blocks: fc.array(
      fc.record({
        location: fc.constantFrom('loc_hall', 'loc_hall', 'loc_archive'),
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
  // A motive for most ordered pairs, some below the 0.4 threshold.
  motives: fc.array(fc.double({ min: 0.3, max: 1, noNaN: true }), {
    minLength: 6,
    maxLength: 6,
  }),
  window: fc.integer({ min: 1, max: 30 }),
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
  // record: the log in the archive. held: a ring carried by ch_1. keyed: the archive door needs
  // a key lying in the hall, and both the key and the log are means.
  means: fc.constantFrom('record', 'held', 'keyed'),
  seed: fc.string({ maxLength: 8 }),
});

type Generated = typeof scenarioArbitrary extends fc.Arbitrary<infer T> ? T : never;

function build(g: Generated) {
  const items = [
    ...minimal.items,
    ...(g.means === 'held'
      ? [{ id: 'it_ring', name: 'Кольцо', kind: 'misc', tags: ['ring'], ownerArchetype: 'visitor' }]
      : []),
    ...(g.means === 'keyed'
      ? [{ id: 'it_key', name: 'Ключ', kind: 'key', tags: ['record'], locationId: 'loc_hall' }]
      : []),
  ];
  const means = g.means === 'held' ? { itemTag: 'ring', itemId: 'it_ring' } : { itemTag: 'record' };
  const content = withIncident(
    {
      ...minimal,
      items,
      locations: minimal.locations.map((location) => ({
        ...location,
        ...(location.id === 'loc_archive' &&
          g.access && { access: [{ from: g.access[0], to: g.access[1] }] }),
        ...(location.id === 'loc_hall' &&
          g.means === 'keyed' && {
            connections: [{ to: 'loc_archive', minutes: 2, locked: { itemId: 'it_key' } }],
          }),
      })),
      crimes: minimal.crimes.map((crime) => ({
        ...crime,
        requires: {
          ...crime.requires,
          means,
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
    motives: ids
      .flatMap((who) => ids.filter((against) => against !== who).map((against) => [who, against]))
      .map(([who, against], index) => motive(who!, against!, g.motives[index])),
  };
  return { content, input };
}

describe('IncidentSelection properties', () => {
  test('feasibility equals an independent search; every window is confirmed by simulation', () => {
    let feasibleTriples = 0;
    const byMeans = new Map<string, number>();
    const acquisitions = new Set<string>();
    let rejectedBySimulation = 0;
    fc.assert(
      fc.property(scenarioArbitrary, (g) => {
        const { content, input } = build(g);
        const assessment = assessIncidents(input, content);
        // Routine-level screening is exact unless taking the means changes access: a key taken
        // on the way may open (or close) routes, which the re-simulation catches.
        if (g.means !== 'keyed') expect(assessment.windowsRejectedBySimulation).toBe(0);
        else rejectedBySimulation += assessment.windowsRejectedBySimulation;
        for (const option of assessment.options) {
          const feasible = new Map(option.feasible.map((f) => [f.characterId, f]));
          const rejected = { motive: 0, capable: 0, means: 0, opportunity: 0 };
          for (const culprit of ids.filter((id) => id !== option.victimId)) {
            const actual = feasible.get(culprit);
            // Soundness: every reported window holds in a simulation of the plan.
            for (const opportunity of actual?.opportunities ?? []) {
              expect(
                confirm(input, content, culprit, option.victimId, option.templateId, opportunity),
              ).toEqual([]);
            }
            if (actual) {
              feasibleTriples++;
              byMeans.set(g.means, (byMeans.get(g.means) ?? 0) + 1);
              for (const { acquisition, deviation } of actual.opportunities) {
                acquisitions.add(
                  `${acquisition?.fromCharacterId ? 'holder' : acquisition ? 'location' : 'held'}/${deviation ? 'changed' : 'routine'}`,
                );
              }
              expect(actual.score).toBeGreaterThan(0);
              expect(actual.score).toBeLessThanOrEqual(1);
            }
            // Completeness against the baseline search. A key taken as means changes routes,
            // which the baseline search ignores and the stage re-simulates: soundness only there.
            if (g.means === 'keyed') continue;
            const expected = search(input, content, culprit, option.victimId, option.templateId);
            if (typeof expected === 'string') {
              expect(actual).toBeUndefined();
              rejected[expected]++;
            } else {
              expect(
                new Map(actual!.opportunities.map(({ locationId, from }) => [locationId, from])),
              ).toEqual(expected);
            }
          }
          if (g.means !== 'keyed') expect(option.rejected).toEqual(rejected);
        }
      }),
      { numRuns: 400, seed: 6006 },
    );
    // The property is not vacuous: every means mode and both kinds of window occur.
    expect(feasibleTriples).toBeGreaterThan(80);
    expect([...byMeans.keys()].sort()).toEqual(['held', 'keyed', 'record']);
    expect(rejectedBySimulation).toBeGreaterThan(0);
    for (const kind of ['location/changed', 'location/routine', 'holder/changed']) {
      expect(acquisitions).toContain(kind);
    }
  }, 300_000);

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
        for (const opportunity of incident.opportunities) {
          expect(
            confirm(
              input,
              content,
              incident.culpritId,
              incident.victimId,
              incident.templateId,
              opportunity,
            ),
          ).toEqual([]);
        }
        expect(incident.motive.strength).toBeGreaterThanOrEqual(content.preset.incident.minMotive);
        expect(trySelect(input, content, g.seed)).toEqual(result);
      }),
      { numRuns: 120, seed: 6007 },
    );
  }, 300_000);

  test('sanatorium_winter: the chosen plan is confirmed by simulation', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (seed) => {
        const input = incidentInput(sanatorium, `p${seed}`);
        const result = trySelect(input, sanatorium, `p${seed}`);
        if (result instanceof GenerationRejection) return;
        const { incident } = result;
        expect(incident.culpritId).not.toBe(incident.victimId);
        for (const opportunity of incident.opportunities) {
          expect(
            confirm(
              input,
              sanatorium,
              incident.culpritId,
              incident.victimId,
              incident.templateId,
              opportunity,
            ),
          ).toEqual([]);
        }
      }),
      { numRuns: 25, seed: 6008 },
    );
  }, 300_000);
});
