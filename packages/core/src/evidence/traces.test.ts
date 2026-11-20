import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { hashId } from '../common/index.ts';
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
  type TraceRuleSet,
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

function single(rules: unknown, input: TruthEventInput) {
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
    expect(() => compileTraceRules(rules)).toThrow(/Expected a location ID or one of: \$location/);
  });

  test('accepts only verbs a truth event can carry', () => {
    const rule = (verb: string) => [{ verb, produces: [physicalHere] }];
    expect(() => compileTraceRules(rule('take-item'))).toThrow(
      expect.objectContaining({ code: 'EVIDENCE_RULE_INVALID', path: 'traceRules.0.verb' }),
    );
    expect(() => compileTraceRules(rule('Take'))).toThrow(EvidenceError);
    expect(() => new TruthLog().append(event({ verb: 'take-item' }))).toThrow();

    expect(single(rule('take_item'), event({ verb: 'take_item' }))).toEqual([
      {
        id: hashId('tr', { sourceEventId: 'ev_1', rule: 0, spec: 0 }, 16),
        kind: 'physical',
        sourceEventId: 'ev_1',
        location: hall,
        availableFrom: 10,
      },
    ]);
  });

  test('returns a detached deeply frozen copy', () => {
    const source = [{ verb: 'take', produces: [{ ...physicalHere }] }];
    const compiled = compileTraceRules(source);
    source[0]!.verb = 'hide';
    expect(compiled.rules[0]?.verb).toBe('take');
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.rules)).toBe(true);
    expect(Object.isFrozen(compiled.rules[0]?.produces[0])).toBe(true);
    expect(() => {
      // @ts-expect-error compiled rules are readonly
      compiled.rules[0]!.verb = 'hide';
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error nested trace specs are readonly
      compiled.rules[0]!.produces[0]!.at = archive;
    }).toThrow(TypeError);
    expectTypeOf(compiled.rules).toEqualTypeOf<readonly TraceRule[]>();
    expect(() => (compiled.rules as TraceRule[]).push(compiled.rules[0]!)).toThrow(TypeError);
  });
});

describe('TraceRuleSet', () => {
  const forged = { rules: [{ verb: 'take', produces: [physicalHere] }] };

  test('a plain object with the same shape is not a compiled rule set', () => {
    expectTypeOf(forged).not.toExtend<TraceRuleSet>();
    expectTypeOf(compileTraceRules([])).toExtend<TraceRuleSet>();
    const log = new TruthLog();
    const appended = log.append(event());

    // @ts-expect-error only compileTraceRules creates a TraceRuleSet
    expect(() => tracesForEvent(appended, forged, items)).toThrow(
      expect.objectContaining({ code: 'EVIDENCE_RULE_INVALID', path: 'traceRules' }),
    );
    // @ts-expect-error only compileTraceRules creates a TraceRuleSet
    expect(() => deriveTraces(log, forged, items)).toThrow(EvidenceError);
    // @ts-expect-error a rule list is not a TraceRuleSet either
    expect(() => deriveTraces(log, forged.rules, items)).toThrow(EvidenceError);
  });
});

describe('regressions', () => {
  test('orders more than ten events of one minute by their numeric event id', () => {
    const rules = compileTraceRules([{ verb: 'take', produces: [physicalHere] }]);
    const log = new TruthLog();
    for (let index = 0; index < 12; index++) log.append(event({ t: 7 }));
    const expected = Array.from({ length: 12 }, (_, index) => `ev_${index + 1}`);
    const sources = (traces: readonly Trace[]) => traces.map(({ sourceEventId }) => sourceEventId);

    expect(sources(deriveTraces(log, rules, items))).toEqual(expected);
    const reversed = [...log.events()].reverse();
    expect(sources(deriveTraces({ events: () => reversed }, rules, items))).toEqual(expected);
    expect(expected.indexOf('ev_9')).toBe(8);
    expect(expected.indexOf('ev_10')).toBe(9);
  });

  test('keeps long decay periods exact', () => {
    const traces = single(
      [
        {
          verb: 'take',
          produces: [
            { ...physicalHere, decaysAfter: 31 },
            { ...physicalHere, decaysAfter: 1440 },
            { ...physicalHere, decaysAfter: 10_080 },
          ],
        },
      ],
      event({ t: -2000, duration: 15 }),
    );
    expect(traces.map(({ availableFrom, decaysAt }) => [availableFrom, decaysAt])).toEqual([
      [-1985, -1954],
      [-1985, -545],
      [-1985, 8095],
    ]);
  });

  test('emits one trace per produces entry of every matching rule with exact ids', () => {
    const rules: TraceRule[] = [
      {
        verb: 'take',
        when: { itemId: 'it_vial' },
        produces: [
          { kind: 'physical', at: '$location', template: 'a', supports: [] },
          { kind: 'document', at: hall, template: 'b', supports: [] },
        ],
      },
      { verb: 'walk', produces: [physicalHere] },
      {
        verb: 'take',
        when: { targetTag: 'poison' },
        produces: [
          { kind: 'digital', at: archive, template: 'c', supports: [], decaysAfter: 45 },
          { kind: 'testimonial', at: '$location', template: 'd', supports: [] },
        ],
      },
    ];
    const id = (rule: number, spec: number) =>
      hashId('tr', { sourceEventId: 'ev_1', rule, spec }, 16);

    expect(single(rules, event({ t: 3, duration: 2, targets: [item('it_vial')] }))).toEqual([
      { id: id(0, 0), kind: 'physical', sourceEventId: 'ev_1', location: hall, availableFrom: 5 },
      { id: id(0, 1), kind: 'document', sourceEventId: 'ev_1', location: hall, availableFrom: 5 },
      {
        id: id(2, 0),
        kind: 'digital',
        sourceEventId: 'ev_1',
        location: archive,
        availableFrom: 5,
        decaysAt: 50,
      },
      {
        id: id(2, 1),
        kind: 'testimonial',
        sourceEventId: 'ev_1',
        location: hall,
        availableFrom: 5,
      },
    ]);
  });
});

describe('safe game minutes', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const min = Number.MIN_SAFE_INTEGER;
  const plain = [{ verb: 'take', produces: [physicalHere] }];
  const decaying = [{ verb: 'take', produces: [{ ...physicalHere, decaysAfter: 10 }] }];

  test('accepts results on the safe integer boundary', () => {
    expect(single(plain, event({ t: max - 5, duration: 5 }))[0]).toMatchObject({
      availableFrom: max,
    });
    expect(single(decaying, event({ t: max - 15, duration: 5 }))[0]).toMatchObject({
      availableFrom: max - 10,
      decaysAt: max,
    });
    expect(single(decaying, event({ t: min }))[0]).toMatchObject({
      availableFrom: min,
      decaysAt: min + 10,
    });
  });

  test('rejects an availableFrom beyond the safe range', () => {
    expect(() => single(plain, event({ t: max - 5, duration: 6 }))).toThrow(
      new RangeError('Trace availableFrom of ev_1 is outside the safe integer range'),
    );
  });

  test('rejects a decaysAt beyond the safe range without returning partial traces', () => {
    const rules = compileTraceRules([...plain, ...decaying]);
    const log = new TruthLog();
    log.append(event({ t: 0 }));
    log.append(event({ t: max - 9 }));
    expect(() => deriveTraces(log, rules, items)).toThrow(
      new RangeError('Trace decaysAt of ev_2 is outside the safe integer range'),
    );
  });
});
