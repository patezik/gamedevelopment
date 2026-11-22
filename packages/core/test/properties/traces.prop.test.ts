import fc from 'fast-check';
import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import {
  CONCEALMENT_VERBS,
  compileTraceRules,
  deriveTraces,
  tracesForEvent,
  type TraceRule,
} from '@hs/core/evidence';
import { TruthLog, type TruthEvent, type TruthEventInput } from '@hs/core/truth';
import { ItemRegistry } from '@hs/core/world';

const content = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const locations = content.locations.map(({ id }) => id);
const verbs = ['take', 'hide', 'destroy', 'stage', 'walk'];
const tags = ['poison', 'glass', 'record'];
const catalog = [
  { id: 'it_a', tags: ['poison'] },
  { id: 'it_b', tags: ['glass', 'poison'] },
  { id: 'it_c', tags: [] },
  { id: 'it_d', tags: ['record'] },
];
const items = new ItemRegistry({
  locations: content.locations,
  items: catalog.map(({ id, tags: itemTags }) => ({
    id,
    name: id,
    kind: 'thing',
    tags: itemTags,
    locationId: 'loc_hall',
  })),
});
const itemIds = catalog.map(({ id }) => id);
// Base rules of the conservation law, appended so the generated rules keep their indices.
const conserved: TraceRule[] = CONCEALMENT_VERBS.map((verb) => ({
  verb,
  produces: [{ kind: 'physical', at: '$location', template: `${verb}_mark`, supports: [] }],
}));

const ruleArb: fc.Arbitrary<TraceRule> = fc.record(
  {
    verb: fc.constantFrom(...verbs),
    when: fc.record(
      { itemId: fc.constantFrom(...itemIds), targetTag: fc.constantFrom(...tags) },
      { requiredKeys: [] },
    ),
    produces: fc.array(
      fc.record(
        {
          kind: fc.constantFrom('physical', 'document', 'digital', 'testimonial'),
          at: fc.constantFrom('$location', ...locations),
          template: fc.constant('mark'),
          supports: fc.subarray(['means($actor)', 'presence($actor,$location,$t)', 'motive()']),
          captureMode: fc.constantFrom('direct', 'qr'),
          decaysAfter: fc.option(fc.integer({ min: 1, max: 600 })),
          // it_missing is absent from the registry: such a trace is never produced.
          requires: fc.record({ itemId: fc.constantFrom(...itemIds, 'it_missing') }),
        },
        { requiredKeys: ['kind', 'at', 'template', 'supports'] },
      ),
      { minLength: 1, maxLength: 3 },
    ),
  },
  { requiredKeys: ['verb', 'produces'] },
);

const eventArb: fc.Arbitrary<TruthEventInput> = fc.record({
  t: fc.integer({ min: -2880, max: 2880 }),
  duration: fc.nat({ max: 120 }),
  verb: fc.constantFrom(...verbs, 'talk'),
  actorIds: fc.subarray(['ch_anna', 'ch_boris']),
  location: fc.constantFrom(...locations),
  targets: fc.array(
    fc.record({ kind: fc.constantFrom('item', 'location'), id: fc.constantFrom(...itemIds) }),
    { maxLength: 3 },
  ),
  causes: fc.constant([]),
  facts: fc.constant([]),
  traceIds: fc.constant([]),
  visibility: fc.constantFrom('public', 'covert', 'private'),
});

const scenario = fc.record({
  rules: fc.array(ruleArb, { maxLength: 6 }).map((rules) => [...rules, ...conserved]),
  events: fc.array(eventArb, { maxLength: 25 }),
});

const withPermutation = scenario.chain((value) => {
  const indices = value.events.map((_, index) => index);
  return fc
    .shuffledSubarray(indices, { minLength: indices.length, maxLength: indices.length })
    .map((order) => ({ ...value, order }));
});

function logOf(events: readonly TruthEventInput[]): TruthLog {
  const log = new TruthLog();
  for (const event of events) log.append(event);
  return log;
}

// Independent restatement of the matching contract: one target item satisfies every condition.
function oracleMatches(rule: TraceRule, event: TruthEvent): boolean {
  if (rule.verb !== event.verb) return false;
  const { itemId, targetTag } = rule.when ?? {};
  if (itemId === undefined && targetTag === undefined) return true;
  return event.targets.some(
    (target) =>
      target.kind === 'item' &&
      (itemId === undefined || itemId === target.id) &&
      (targetTag === undefined ||
        catalog.some(({ id, tags: own }) => id === target.id && own.includes(targetTag))),
  );
}

// Independent restatement of destruction: the destroy event of an item that ends first; ties go
// to the event that starts first, then to the earlier event id.
function oracleDestructions(
  events: readonly TruthEvent[],
): Map<string, { id: string; at: number }> {
  const order = (event: TruthEvent) => [
    event.t + event.duration,
    event.t,
    Number(event.id.slice(3)),
  ];
  const best = new Map<string, TruthEvent>();
  for (const event of events) {
    const target = event.targets.find(({ kind }) => kind === 'item');
    if (event.verb !== 'destroy' || !target) continue;
    const known = best.get(target.id);
    const [a, b] = [order(event), known && order(known)];
    const earlier =
      !b || a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!)));
    if (earlier) best.set(target.id, event);
  }
  return new Map(
    [...best].map(([item, event]) => [item, { id: event.id, at: event.t + event.duration }]),
  );
}

test('derivation is deterministic and independent of the order events are supplied in', () => {
  fc.assert(
    fc.property(withPermutation, ({ rules, events, order }) => {
      const compiled = compileTraceRules(rules);
      const log = logOf(events);
      const first = deriveTraces(log, compiled, items);

      expect(deriveTraces(logOf(events), compileTraceRules(rules), items)).toEqual(first);
      const stored = log.events();
      const shuffled = order.map((index) => stored[index]!);
      expect(deriveTraces({ events: () => shuffled }, compiled, items)).toEqual(first);
    }),
  );
});

test('every trace has a unique id, comes from a matching event and starts when that event ends', () => {
  let produced = 0;
  let unmatchedEvents = 0;
  let destroyedTraces = 0;
  fc.assert(
    fc.property(scenario, ({ rules, events }) => {
      const log = logOf(events);
      const traces = deriveTraces(log, compileTraceRules(rules), items);
      const destructions = oracleDestructions(log.events());
      produced += traces.length;
      unmatchedEvents += log
        .events()
        .filter((event) => !rules.some((rule) => oracleMatches(rule, event))).length;

      expect(new Set(traces.map(({ id }) => id)).size).toBe(traces.length);
      for (const event of log.events()) {
        const own = traces.filter(({ sourceEventId }) => sourceEventId === event.id);
        const end = event.t + event.duration;
        const expected = rules
          .filter((rule) => oracleMatches(rule, event))
          .flatMap(({ produces }) => produces)
          .filter(({ requires }) => {
            if (requires === undefined) return true;
            const destroyed = destructions.get(requires.itemId);
            return requires.itemId !== 'it_missing' && (!destroyed || destroyed.at > end);
          }).length;

        expect(own).toHaveLength(expected);
        expect(own).toEqual(tracesForEvent(event, compileTraceRules(rules), items, log));
        if (CONCEALMENT_VERBS.includes(event.verb)) expect(own.length).toBeGreaterThan(0);
        for (const trace of own) {
          expect(trace.availableFrom).toBe(end);
          if (trace.decaysAt !== undefined)
            expect(trace.decaysAt).toBeGreaterThan(trace.availableFrom);
          expect(locations).toContain(trace.location);
          expect(trace.supports.join()).not.toContain('$');
          expect(['auto', 'qr']).toContain(trace.captureMode);
          if (trace.destroyedBy !== undefined) {
            // Destroyed once, later than it appeared, by the first destruction of its carrier.
            expect(trace.destroyedBy).not.toBe(trace.sourceEventId);
            expect(destructions.get(trace.itemId!)).toEqual({
              id: trace.destroyedBy,
              at: trace.destroyedAt,
            });
            expect(trace.destroyedAt).toBeGreaterThan(trace.availableFrom);
            expect(trace.destroyedAt).toBeLessThan(trace.decaysAt ?? Infinity);
            destroyedTraces++;
          }
        }
      }
      expect(log.events().every(({ traceIds }) => traceIds.length === 0)).toBe(true);
    }),
  );
  // Guards against a generator that only ever exercises one branch.
  expect(produced).toBeGreaterThan(0);
  expect(unmatchedEvents).toBeGreaterThan(0);
  expect(destroyedTraces).toBeGreaterThan(0);
});
