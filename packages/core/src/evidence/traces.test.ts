import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadScenarioFromDir } from '../content/index.ts';
import { TruthLog, type EntityRef, type TruthEventInput } from '../truth/index.ts';
import { ItemRegistry } from '../world/index.ts';
import {
  EvidenceError,
  compileTraceRules,
  deriveTraces,
  tracesForEvent,
  type Trace,
  type TraceRule,
  type TraceSpec,
} from './index.ts';

const minimal = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const hall = 'loc_hall';
const archive = 'loc_archive';

const items = new ItemRegistry({
  locations: minimal.locations,
  items: [
    ...minimal.items,
    { id: 'it_vial', name: 'Vial', kind: 'vial', tags: ['poison', 'glass'], locationId: archive },
    { id: 'it_cup', name: 'Cup', kind: 'cup', tags: ['glass'], locationId: hall },
  ],
});

const item = (id: string): EntityRef => ({ kind: 'item', id });

function event(overrides: Partial<TruthEventInput> = {}): TruthEventInput {
  return {
    t: 10,
    duration: 0,
    verb: 'take',
    actorIds: ['ch_anna'],
    location: hall,
    targets: [],
    causes: [],
    facts: [],
    traceIds: [],
    visibility: 'covert',
    ...overrides,
  };
}

function single(rules: TraceRule[], input: TruthEventInput) {
  const log = new TruthLog();
  const appended = log.append(input);
  return tracesForEvent(appended, compileTraceRules(rules), items);
}

const physicalHere: TraceSpec = {
  kind: 'physical',
  at: '$location',
  template: 'mark',
  supports: [],
};

function withoutId({ id, ...trace }: Trace): Omit<Trace, 'id'> {
  expect(id).toMatch(/^tr_[0-9a-f]{16}$/);
  return trace;
}

describe('scenario trace rules', () => {
  test('taking the archive log leaves the document trace declared by _test_minimal', () => {
    const log = new TruthLog();
    const taken = log.append(
      event({ t: 40, duration: 5, location: archive, targets: [item('it_log')] }),
    );
    log.append(event({ t: 50, verb: 'walk', targets: [item('it_log')] }));

    const traces = deriveTraces(log, compileTraceRules(minimal.traceRules), items);

    expect(traces.map(withoutId)).toEqual([
      {
        kind: 'document',
        sourceEventId: taken.id,
        location: archive,
        availableFrom: 45,
      },
    ]);
  });
});

describe('rule matching', () => {
  const rules: TraceRule[] = [
    { verb: 'take', when: { itemId: 'it_vial' }, produces: [physicalHere] },
    { verb: 'take', when: { targetTag: 'poison' }, produces: [physicalHere] },
    { verb: 'take', when: { itemId: 'it_cup', targetTag: 'poison' }, produces: [physicalHere] },
  ];

  test('matches by verb, item id and target tag of item targets', () => {
    expect(single(rules, event({ targets: [item('it_vial')] }))).toHaveLength(2);
    expect(single(rules, event({ verb: 'hide', targets: [item('it_vial')] }))).toEqual([]);
    expect(single(rules, event({ targets: [item('it_cup')] }))).toEqual([]);
    expect(single(rules, event({ targets: [{ kind: 'document', id: 'it_vial' }] }))).toEqual([]);
    expect(single(rules, event({ targets: [] }))).toEqual([]);
  });

  test('requires every condition of one rule to hold for the same target item', () => {
    const both = single(rules.slice(2), event({ targets: [item('it_cup'), item('it_vial')] }));
    expect(both).toEqual([]);
  });

  test('a rule without conditions matches every event of its verb', () => {
    const unconditional: TraceRule[] = [{ verb: 'talk', produces: [physicalHere] }];
    expect(single(unconditional, event({ verb: 'talk' }))).toHaveLength(1);
    expect(
      single([{ verb: 'talk', when: {}, produces: [physicalHere] }], event({ verb: 'talk' })),
    ).toHaveLength(1);
    expect(single(unconditional, event({ verb: 'take' }))).toEqual([]);
  });

  test('looks up tags of target items through the item registry', () => {
    const rule: TraceRule[] = [
      { verb: 'take', when: { targetTag: 'poison' }, produces: [physicalHere] },
    ];
    expect(() => single(rule, event({ targets: [item('it_missing')] }))).toThrow(
      expect.objectContaining({ code: 'WORLD_UNKNOWN_ITEM' }),
    );
    // Without a tag condition the registry is not consulted.
    expect(
      single(
        [{ verb: 'take', produces: [physicalHere] }],
        event({ targets: [item('it_missing')] }),
      ),
    ).toHaveLength(1);
  });
});

describe('produced traces', () => {
  test('every matching rule and every produces entry yields one trace in rule order', () => {
    const rules: TraceRule[] = [
      {
        verb: 'take',
        when: { targetTag: 'glass' },
        produces: [
          { ...physicalHere, decaysAfter: 30 },
          { kind: 'document', at: archive, template: 'log_gap', supports: [], decaysAfter: null },
        ],
      },
      { verb: 'walk', produces: [physicalHere] },
      {
        verb: 'take',
        produces: [{ kind: 'testimonial', at: hall, template: 'seen', supports: [] }],
      },
    ];
    const traces = single(
      rules,
      event({ t: -30, duration: 4, location: archive, targets: [item('it_cup')] }),
    );

    expect(traces.map(withoutId)).toEqual([
      {
        kind: 'physical',
        sourceEventId: 'ev_1',
        location: archive,
        availableFrom: -26,
        decaysAt: 4,
      },
      { kind: 'document', sourceEventId: 'ev_1', location: archive, availableFrom: -26 },
      { kind: 'testimonial', sourceEventId: 'ev_1', location: hall, availableFrom: -26 },
    ]);
    expect(new Set(traces.map(({ id }) => id)).size).toBe(3);
  });

  test('ids are stable across runs and differ between events', () => {
    const rules: TraceRule[] = [{ verb: 'take', produces: [physicalHere] }];
    const first = single(rules, event());
    expect(single(rules, event({ t: 99, location: archive }))).toEqual([
      { ...first[0], location: archive, availableFrom: 99 },
    ]);

    const log = new TruthLog();
    log.append(event());
    log.append(event());
    const ids = deriveTraces(log, compileTraceRules(rules), items).map(({ id }) => id);
    expect(ids[0]).toBe(first[0]?.id);
    expect(new Set(ids).size).toBe(2);
  });

  test('derives traces in chronological event order and leaves the log untouched', () => {
    const rules = compileTraceRules([{ verb: 'take', produces: [physicalHere] }]);
    const log = new TruthLog();
    const late = log.append(event({ t: 20 }));
    const early = log.append(event({ t: -5 }));
    const before = JSON.stringify(log.inAppendOrder());

    const traces = deriveTraces(log, rules, items);

    expect(traces.map(({ sourceEventId }) => sourceEventId)).toEqual([early.id, late.id]);
    expect(JSON.stringify(log.inAppendOrder())).toBe(before);
    expect(log.events().every(({ traceIds }) => traceIds.length === 0)).toBe(true);
  });

  test('events without a matching rule leave no traces', () => {
    const log = new TruthLog();
    log.append(event({ verb: 'sleep' }));
    log.append(event({ verb: 'talk' }));
    expect(deriveTraces(log, compileTraceRules(minimal.traceRules), items)).toEqual([]);
    expect(deriveTraces(log, compileTraceRules([]), items)).toEqual([]);
  });
});

describe('compileTraceRules', () => {
  test('rejects rules outside the content schema with EVIDENCE_RULE_INVALID', () => {
    const invalid = [{ verb: 'take', produces: [] }];
    expect(() => compileTraceRules(invalid)).toThrow(EvidenceError);
    expect(() => compileTraceRules(invalid)).toThrow(
      expect.objectContaining({ code: 'EVIDENCE_RULE_INVALID', path: 'traceRules.0.produces' }),
    );
    expect(() => compileTraceRules({})).toThrow(expect.objectContaining({ path: 'traceRules' }));
  });

  test('rejects location placeholders other than $location', () => {
    const rules = [{ verb: 'take', produces: [physicalHere, { ...physicalHere, at: '$actor' }] }];
    expect(() => compileTraceRules(rules)).toThrow(
      expect.objectContaining({
        code: 'EVIDENCE_RULE_INVALID',
        path: 'traceRules.0.produces.1.at',
      }),
    );
  });

  test('returns a detached frozen copy', () => {
    const source: TraceRule[] = [{ verb: 'take', produces: [{ ...physicalHere }] }];
    const compiled = compileTraceRules(source);
    source[0]!.verb = 'hide';
    expect(compiled.rules[0]?.verb).toBe('take');
    expect(Object.isFrozen(compiled.rules[0]?.produces[0])).toBe(true);
  });
});
