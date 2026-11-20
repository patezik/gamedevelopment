import fc from 'fast-check';
import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { compileTraceRules, deriveTraces, tracesForEvent, type TraceRule } from '@hs/core/evidence';
import { TruthLog, type TruthEvent, type TruthEventInput } from '@hs/core/truth';
import { ItemRegistry } from '@hs/core/world';

const content = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const locations = content.locations.map(({ id }) => id);
const verbs = ['take', 'hide', 'destroy', 'walk'];
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
          supports: fc.constant([]),
          decaysAfter: fc.option(fc.nat({ max: 600 })),
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
  actorIds: fc.constant(['ch_anna']),
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
  rules: fc.array(ruleArb, { maxLength: 6 }),
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
  fc.assert(
    fc.property(scenario, ({ rules, events }) => {
      const log = logOf(events);
      const traces = deriveTraces(log, compileTraceRules(rules), items);
      produced += traces.length;
      unmatchedEvents += log
        .events()
        .filter((event) => !rules.some((rule) => oracleMatches(rule, event))).length;

      expect(new Set(traces.map(({ id }) => id)).size).toBe(traces.length);
      for (const event of log.events()) {
        const own = traces.filter(({ sourceEventId }) => sourceEventId === event.id);
        const expected = rules
          .filter((rule) => oracleMatches(rule, event))
          .reduce((count, rule) => count + rule.produces.length, 0);

        expect(own).toHaveLength(expected);
        expect(own).toEqual(tracesForEvent(event, compileTraceRules(rules), items));
        for (const trace of own) {
          expect(trace.availableFrom).toBe(event.t + event.duration);
          if (trace.decaysAt !== undefined)
            expect(trace.decaysAt).toBeGreaterThanOrEqual(trace.availableFrom);
          expect(locations).toContain(trace.location);
        }
      }
      expect(log.events().every(({ traceIds }) => traceIds.length === 0)).toBe(true);
    }),
  );
  // Guards against a generator that only ever exercises one branch.
  expect(produced).toBeGreaterThan(0);
  expect(unmatchedEvents).toBeGreaterThan(0);
});
