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

type Format = 'stays' | 'moves';

/**
 * A walk along the graph that waits at least the route time between stays, except `shortTrip`.
 * With `moves`, each trip is also an explicit move event in the SIM-001 format.
 */
function walk({ start, first, steps }: Plan, format: Format, shortTrip?: number) {
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
    const duration = index === shortTrip ? travel - 1 : travel + slack;
    if (format === 'moves') {
      const destination = { kind: 'location', id: edge.to } as const;
      truth.append({
        t: to,
        duration,
        verb: 'move',
        actorIds: ['ch_walker'],
        location: where,
        targets: [destination],
        causes: [],
        facts: [
          { kind: 'did', who: 'ch_walker', verb: 'move', target: destination, at: to, where },
        ],
        traceIds: [],
        visibility: 'public',
      });
    }
    minute = to + duration;
    where = edge.to;
  }
  return truth;
}

const formats = fc.constantFrom<Format>('stays', 'moves');

test('itineraries that respect the graph pass invariants 1–3', () => {
  fc.assert(
    fc.property(itinerary, formats, (plan, format) => {
      expect(checkTruthInvariants(walk(plan, format), world)).toEqual([]);
    }),
  );
});

test('shortening one trip below the route time is always reported once', () => {
  fc.assert(
    fc.property(itinerary, formats, fc.nat(), (plan, format, pick) => {
      // Without moves the last step has no following stay, so only earlier steps produce a trip.
      const trips = format === 'moves' ? plan.steps.length : plan.steps.length - 1;
      fc.pre(trips > 0);
      const violations = checkTruthInvariants(walk(plan, format, pick % trips), world);
      expect(violations.map(({ code }) => code)).toEqual(['TRAVEL_TOO_FAST']);
    }),
  );
});

test('a locked edge opens exactly when the registry gives the key by the minute of departure', () => {
  const doors = [
    {
      ...template,
      id: 'loc_a',
      name: 'loc_a',
      connections: [{ to: 'loc_b', minutes: 3, locked: { itemId: 'it_key' } }],
    },
    { ...template, id: 'loc_b', name: 'loc_b', connections: [] },
  ];
  const minutes = fc.integer({ min: -100, max: 100 });
  fc.assert(
    fc.property(minutes, minutes, (departure, keyAt) => {
      const keyed = {
        locations: new LocationGraph({ preset: minimal.preset, locations: doors }),
        items: new ItemRegistry(
          {
            locations: doors,
            items: [{ id: 'it_key', name: 'Key', kind: 'key', tags: [], locationId: 'loc_a' }],
          },
          new Map(),
          -1000,
        ),
      };
      const truth = new TruthModel({
        type: 'theft',
        victimIds: [],
        culpritIds: [],
        motive: 'f_0000000000000000',
        means: 'it_key',
        keyEventIds: [],
        window: { from: -100, to: 100 },
      });
      const take = truth.append({
        t: keyAt,
        duration: 0,
        verb: 'take',
        actorIds: [],
        location: 'loc_a',
        targets: [{ kind: 'item', id: 'it_key' }],
        causes: [],
        facts: [],
        traceIds: [],
        visibility: 'public',
      });
      keyed.items.move('it_key', { kind: 'character', id: 'ch_walker' }, keyAt, take);
      truth.append({
        t: departure,
        duration: 3,
        verb: 'move',
        actorIds: ['ch_walker'],
        location: 'loc_a',
        targets: [
          { kind: 'location', id: 'loc_b' },
          { kind: 'item', id: 'it_key' },
        ],
        causes: [],
        facts: [],
        traceIds: [],
        visibility: 'public',
      });
      const codes = checkTruthInvariants(truth, keyed).map(({ code }) => code);
      expect(codes).toEqual(keyAt <= departure ? [] : ['TRAVEL_NO_ROUTE']);
    }),
  );
});
