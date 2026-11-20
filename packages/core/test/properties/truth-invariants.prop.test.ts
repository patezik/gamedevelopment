import fc from 'fast-check';
import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { checkTruthInvariants, TruthModel, type EventId } from '@hs/core/truth';
import { ItemRegistry, LocationGraph } from '@hs/core/world';

const minimal = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const template = minimal.locations[0]!;
const edges: Record<string, { to: string; minutes: number }[]> = {
  loc_a: [
    { to: 'loc_b', minutes: 4 },
    { to: 'loc_c', minutes: 9 },
  ],
  loc_b: [
    { to: 'loc_c', minutes: 2 },
    { to: 'loc_a', minutes: 7 },
  ],
  loc_c: [{ to: 'loc_d', minutes: 1 }],
  loc_d: [{ to: 'loc_a', minutes: 3 }],
};
const locations = Object.entries(edges).map(([id, connections]) => ({
  ...template,
  id,
  name: id,
  connections,
}));
const world = {
  locations: new LocationGraph({ preset: minimal.preset, locations }),
  items: new ItemRegistry({ locations, items: [] }, new Map(), -1000),
};
const ids = Object.keys(edges);

const itinerary = fc.record({
  start: fc.integer({ min: -600, max: 0 }),
  first: fc.nat({ max: ids.length - 1 }),
  steps: fc.array(
    fc.record({
      next: fc.nat(),
      stay: fc.integer({ min: 1, max: 30 }),
      actAt: fc.nat(),
      slack: fc.nat({ max: 10 }),
    }),
    { minLength: 1, maxLength: 12 },
  ),
});

type Plan = typeof itinerary extends fc.Arbitrary<infer T> ? T : never;

/** A walk along the graph that waits at least the route time between stays, except `shortTrip`. */
function walk({ start, first, steps }: Plan, shortTrip?: number) {
  const truth = new TruthModel({
    type: 'murder',
    victimIds: [],
    culpritIds: ['ch_walker'],
    motive: 'f_0000000000000000',
    means: 'it_none',
    keyEventIds: [],
    window: { from: -600, to: 600 },
  });
  let where = ids[first]!;
  let minute = start;
  let previous: EventId | undefined;
  for (const [index, { next, stay, actAt, slack }] of steps.entries()) {
    const to = minute + stay;
    previous = truth.append({
      t: minute,
      duration: 0,
      verb: 'stay',
      actorIds: [],
      location: where,
      targets: [],
      causes: previous ? [previous] : [],
      facts: [{ kind: 'at', who: 'ch_walker', where, interval: { from: minute, to } }],
      traceIds: [],
      visibility: 'public',
    });
    truth.append({
      t: minute + (actAt % stay),
      duration: 0,
      verb: 'search',
      actorIds: ['ch_walker'],
      location: where,
      targets: [],
      causes: [previous],
      facts: [],
      traceIds: [],
      visibility: 'covert',
    });
    const options = edges[where]!;
    const edge = options[next % options.length]!;
    const travel = world.locations.travelTime(where, edge.to)!;
    minute = to + (index === shortTrip ? travel - 1 : travel + slack);
    where = edge.to;
  }
  return truth;
}

test('itineraries that respect the graph pass invariants 1–3', () => {
  fc.assert(
    fc.property(itinerary, (plan) => {
      expect(checkTruthInvariants(walk(plan), world)).toEqual([]);
    }),
  );
});

test('shortening one trip below the route time is always reported', () => {
  fc.assert(
    fc.property(itinerary, fc.nat(), (plan, pick) => {
      // The last step has no following stay, so only earlier steps produce a trip.
      fc.pre(plan.steps.length > 1);
      const trip = pick % (plan.steps.length - 1);
      const violations = checkTruthInvariants(walk(plan, trip), world);
      expect(violations.map(({ code }) => code)).toEqual(['TRAVEL_TOO_FAST']);
    }),
  );
});
