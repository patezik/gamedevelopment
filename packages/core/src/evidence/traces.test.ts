import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { hashId } from '../common/index.ts';
import { loadScenarioFromDir } from '../content/index.ts';
import { TruthLog, type EntityRef, type TruthEventInput } from '../truth/index.ts';
import { ItemRegistry } from '../world/index.ts';
import {
  CONCEALMENT_VERBS,
  EvidenceError,
  compileTraceRules,
  deriveTraces,
  isTraceAvailable,
  tracesForEvent,
  type Trace,
  type TraceRule,
  type TraceRuleSet,
  type TraceSpec,
  type TruthEventSource,
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

const physicalHere: TraceSpec = {
  kind: 'physical',
  at: '$location',
  template: 'mark',
  supports: [],
};

/** Minimal rules satisfying the conservation law; appended so rule indices of tests stay put. */
const conserved: TraceRule[] = CONCEALMENT_VERBS.map((verb) => ({
  verb,
  produces: [{ ...physicalHere, template: `${verb}_mark` }],
}));
const compile = (rules: readonly unknown[]) => compileTraceRules([...rules, ...conserved]);

function single(rules: readonly unknown[], input: TruthEventInput) {
  const log = new TruthLog();
  const appended = log.append(input);
  return tracesForEvent(appended, compile(rules), items);
}

function logOf(...inputs: TruthEventInput[]): TruthLog {
  const log = new TruthLog();
  for (const input of inputs) log.append(input);
  return log;
}

/** Fields every trace of `physicalHere` has besides time and location. */
const mark = { kind: 'physical', template: 'mark', supports: [], captureMode: 'auto' } as const;

function withoutId({ id, ...trace }: Trace): Omit<Trace, 'id'> {
  expect(id).toMatch(/^tr_[0-9a-f]{16}$/);
  return trace;
}

describe('scenario trace rules', () => {
  test('taking the archive log leaves the document trace declared by _test_minimal', () => {
    const log = logOf(
      event({ t: 40, duration: 5, location: archive, targets: [item('it_log')] }),
      event({ t: 50, verb: 'walk', targets: [item('it_log')] }),
    );

    const traces = deriveTraces(log, compileTraceRules(minimal.traceRules), items);

    expect(traces.map(withoutId)).toEqual([
      {
        kind: 'document',
        sourceEventId: 'ev_1',
        template: 'missing_record',
        supports: ['means(ch_anna)'],
        captureMode: 'auto',
        location: archive,
        itemId: 'it_log',
        availableFrom: 45,
      },
    ]);
  });

  test('_test_minimal leaves a secondary trace for every concealment verb', () => {
    const rules = compileTraceRules(minimal.traceRules);
    for (const verb of CONCEALMENT_VERBS) {
      const log = logOf(event({ verb, targets: [] }));
      expect(deriveTraces(log, rules, items).length).toBeGreaterThanOrEqual(1);
    }
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
    expect(single(rules, event({ verb: 'walk', targets: [item('it_vial')] }))).toEqual([]);
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

  test('fires once per event even when several item targets match', () => {
    const traces = single(
      [{ verb: 'take', when: { targetTag: 'glass' }, produces: [physicalHere] }],
      event({ targets: [item('it_cup'), item('it_vial')] }),
    );
    expect(traces.map(({ itemId }) => itemId)).toEqual(['it_cup']);
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
    const common = { sourceEventId: 'ev_1', supports: [], captureMode: 'auto', itemId: 'it_cup' };

    expect(traces.map(withoutId)).toEqual([
      { ...mark, ...common, location: archive, availableFrom: -26, decaysAt: 4 },
      { ...common, kind: 'document', template: 'log_gap', location: archive, availableFrom: -26 },
      { ...common, kind: 'testimonial', template: 'seen', location: hall, availableFrom: -26 },
    ]);
    expect(new Set(traces.map(({ id }) => id)).size).toBe(3);
  });

  test('ids are stable across runs and differ between events', () => {
    const rules: TraceRule[] = [{ verb: 'take', produces: [physicalHere] }];
    const first = single(rules, event());
    expect(single(rules, event({ t: 99, location: archive }))).toEqual([
      { ...first[0], location: archive, availableFrom: 99 },
    ]);

    const ids = deriveTraces(logOf(event(), event()), compile(rules), items).map(({ id }) => id);
    expect(ids[0]).toBe(first[0]?.id);
    expect(new Set(ids).size).toBe(2);
  });

  test('derives traces in chronological event order and leaves the log untouched', () => {
    const rules = compile([{ verb: 'take', produces: [physicalHere] }]);
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
    const log = logOf(event({ verb: 'sleep' }), event({ verb: 'talk' }));
    expect(deriveTraces(log, compileTraceRules(minimal.traceRules), items)).toEqual([]);
    expect(deriveTraces(log, compile([]), items)).toEqual([]);
  });
});

describe('conservation of evidence (OQ-14)', () => {
  const others = (verb: string) => conserved.filter((rule) => rule.verb !== verb);

  test.each(CONCEALMENT_VERBS)(
    'rule sets without an unconditional %s rule are rejected',
    (verb) => {
      const cases: unknown[][] = [
        others(verb),
        [...others(verb), { verb, when: { targetTag: 'glass' }, produces: [physicalHere] }],
        [
          ...others(verb),
          { verb, produces: [{ ...physicalHere, requires: { itemId: 'it_log' } }] },
        ],
      ];
      for (const rules of cases) {
        expect(() => compileTraceRules(rules)).toThrow(
          expect.objectContaining({ code: 'EVIDENCE_RULE_INVALID', path: 'traceRules' }),
        );
        expect(() => compileTraceRules(rules)).toThrow(`Concealment verb "${verb}"`);
      }
    },
  );

  test('an empty `when` and an extra entry with `requires` still conserve evidence', () => {
    const rules = [
      ...others('hide'),
      {
        verb: 'hide',
        when: {},
        produces: [{ ...physicalHere, requires: { itemId: 'it_log' } }, physicalHere],
      },
    ];
    expect(() => compileTraceRules(rules)).not.toThrow();
    expect(() => compileTraceRules([])).toThrow(EvidenceError);
  });

  test.each(CONCEALMENT_VERBS)('every %s event leaves a secondary trace', (verb) => {
    const rules = compile([]);
    for (const targets of [[], [item('it_cup')], [{ kind: 'location' as const, id: archive }]]) {
      const traces = deriveTraces(logOf(event({ verb, targets })), rules, items);
      expect(traces).toHaveLength(1);
      expect(traces[0]).not.toHaveProperty('destroyedBy');
    }
  });

  test('destroying a carrier keeps the secondary traces of the destruction', () => {
    const log = logOf(
      event({ t: 0, targets: [item('it_cup')] }),
      event({ t: 5, duration: 3, verb: 'destroy', targets: [item('it_cup')] }),
    );
    const traces = deriveTraces(log, compile([{ verb: 'take', produces: [physicalHere] }]), items);

    expect(traces.map(withoutId)).toEqual([
      {
        ...mark,
        sourceEventId: 'ev_1',
        location: hall,
        itemId: 'it_cup',
        availableFrom: 0,
        destroyedBy: 'ev_2',
        destroyedAt: 8,
      },
      {
        ...mark,
        template: 'destroy_mark',
        sourceEventId: 'ev_2',
        location: hall,
        itemId: 'it_cup',
        availableFrom: 8,
      },
    ]);
  });
});

describe('trace payload (OQ-15)', () => {
  test('copies the template and maps direct capture to auto', () => {
    const traces = single(
      [
        {
          verb: 'take',
          produces: [
            physicalHere,
            { ...physicalHere, template: 'direct_mark', captureMode: 'direct' },
            { ...physicalHere, template: 'qr_mark', captureMode: 'qr' },
          ],
        },
      ],
      event(),
    );
    expect(traces.map(({ template, captureMode }) => [template, captureMode])).toEqual([
      ['mark', 'auto'],
      ['direct_mark', 'auto'],
      ['qr_mark', 'qr'],
    ]);
  });

  test('binds $actor, $location and $t of the source event', () => {
    const supports = ['means($actor)', 'presence($actor,$location,$t)', 'opportunity()'];
    const [trace] = single(
      [{ verb: 'take', produces: [{ ...physicalHere, at: hall, supports }] }],
      event({ t: -20, duration: 2, location: archive }),
    );
    expect(trace?.supports).toEqual([
      'means(ch_anna)',
      'presence(ch_anna,loc_archive,-20)',
      'opportunity()',
    ]);
    expect(trace?.location).toBe(hall);
  });

  test('expands $actor per distinct actor and drops it without actors', () => {
    const rules = [
      {
        verb: 'take',
        produces: [{ ...physicalHere, supports: ['means($actor)', 'at($location)'] }],
      },
    ];
    expect(single(rules, event({ actorIds: ['ch_b', 'ch_a', 'ch_b'] }))[0]?.supports).toEqual([
      'means(ch_b)',
      'means(ch_a)',
      'at(loc_hall)',
    ]);
    expect(single(rules, event({ actorIds: [] }))[0]?.supports).toEqual(['at(loc_hall)']);
  });

  test('rejects placeholders the trace engine cannot bind', () => {
    for (const support of ['means($victim)', 'presence($actor,$location,$time)', 'x($T)']) {
      const rules = [
        { verb: 'take', produces: [physicalHere, { ...physicalHere, supports: ['ok', support] }] },
      ];
      expect(() => compile(rules)).toThrow(
        expect.objectContaining({
          code: 'EVIDENCE_RULE_INVALID',
          path: 'traceRules.0.produces.1.supports.1',
        }),
      );
    }
  });

  test('itemId is the required carrier, else the matched item target', () => {
    const traces = single(
      [
        { verb: 'take', when: { targetTag: 'poison' }, produces: [physicalHere] },
        {
          verb: 'take',
          produces: [physicalHere, { ...physicalHere, requires: { itemId: 'it_log' } }],
        },
      ],
      event({ targets: [{ kind: 'location', id: archive }, item('it_cup'), item('it_vial')] }),
    );
    expect(traces.map(({ itemId }) => itemId)).toEqual(['it_vial', 'it_cup', 'it_log']);
    expect(single([{ verb: 'take', produces: [physicalHere] }], event())[0]).not.toHaveProperty(
      'itemId',
    );
  });
});

describe('requires and destruction', () => {
  const required: TraceSpec = {
    ...physicalHere,
    template: 'ledger_gap',
    requires: { itemId: 'it_cup' },
  };
  const rules = compile([{ verb: 'take', produces: [physicalHere, required] }]);
  const take = (t: number, duration = 0) => event({ t, duration, targets: [item('it_vial')] });
  const destroy = (t: number, duration = 0, targets = [item('it_cup')]) =>
    event({ t, duration, verb: 'destroy', targets });
  const templates = (traces: readonly Trace[]) =>
    traces.filter(({ sourceEventId }) => sourceEventId === 'ev_1').map(({ template }) => template);

  test('a required carrier missing from the world suppresses only that trace', () => {
    const noCup = new ItemRegistry({
      locations: minimal.locations,
      items: [{ id: 'it_vial', name: 'Vial', kind: 'vial', tags: ['poison'], locationId: archive }],
    });
    expect(deriveTraces(logOf(take(0)), rules, noCup).map(({ template }) => template)).toEqual([
      'mark',
    ]);
    const failing: TruthEventSource & { get(): never } = {
      events: () => [],
      get: () => {
        throw new Error('registry offline');
      },
    };
    expect(() => tracesForEvent(logOf(take(0)).events()[0]!, rules, failing)).toThrow(
      'registry offline',
    );
  });

  test('a carrier destroyed by availableFrom suppresses the trace', () => {
    expect(templates(deriveTraces(logOf(take(10, 5), destroy(12, 3)), rules, items))).toEqual([
      'mark',
    ]);
    expect(templates(deriveTraces(logOf(take(10, 5), destroy(-50, 1)), rules, items))).toEqual([
      'mark',
    ]);
  });

  test('a carrier destroyed later marks the trace destroyed at the end of the destruction', () => {
    const traces = deriveTraces(logOf(take(10, 5), destroy(12, 4)), rules, items);
    expect(traces.find(({ template }) => template === 'ledger_gap')).toMatchObject({
      itemId: 'it_cup',
      availableFrom: 15,
      destroyedBy: 'ev_2',
      destroyedAt: 16,
    });
  });

  test('a destruction at or after decay is not recorded', () => {
    const decaying = compile([{ verb: 'take', produces: [{ ...required, decaysAfter: 10 }] }]);
    const at = (destroyedAt: number) =>
      deriveTraces(logOf(take(0), destroy(destroyedAt)), decaying, items)[0];
    expect(at(9)).toMatchObject({ decaysAt: 10, destroyedBy: 'ev_2', destroyedAt: 9 });
    expect(at(10)).not.toHaveProperty('destroyedBy');
    expect(at(11)).not.toHaveProperty('destroyedAt');
  });

  test('only the first item target of a destroy event is destroyed', () => {
    const traces = deriveTraces(
      logOf(
        take(0),
        destroy(5, 0, [{ kind: 'location', id: hall }, item('it_vial'), item('it_cup')]),
      ),
      rules,
      items,
    );
    expect(traces.filter(({ destroyedBy }) => destroyedBy).map(({ itemId }) => itemId)).toEqual([
      'it_vial',
    ]);
  });

  test('a carrier is destroyed once, by the destruction that ends first', () => {
    const log = logOf(take(0), destroy(50, 30), destroy(60), destroy(70));
    const expected = deriveTraces(log, rules, items);
    const reversed = [...log.events()].reverse();

    expect(deriveTraces({ events: () => reversed }, rules, items)).toEqual(expected);
    expect(expected.map(({ sourceEventId, destroyedBy }) => [sourceEventId, destroyedBy])).toEqual([
      ['ev_1', undefined],
      ['ev_1', 'ev_3'],
      ['ev_2', undefined],
      ['ev_3', undefined],
      ['ev_4', undefined],
    ]);
  });

  test('tracesForEvent evaluates destruction only when given the truth log', () => {
    const log = logOf(take(10, 5), destroy(12, 4));
    const [taken] = log.events();
    expect(tracesForEvent(taken!, rules, items)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ destroyedBy: 'ev_2' })]),
    );
    expect(tracesForEvent(taken!, rules, items, log)).toEqual(
      deriveTraces(log, rules, items).filter(({ sourceEventId }) => sourceEventId === 'ev_1'),
    );
  });
});

describe('time bounds (OQ-16)', () => {
  test('availability is half-open and ends at decay or destruction', () => {
    const trace = { ...mark, id: 'tr_x', sourceEventId: 'ev_1', availableFrom: -5, decaysAt: 10 };
    expect([-6, -5, 9, 10].map((t) => isTraceAvailable(trace, t))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    const destroyed = { ...trace, destroyedBy: 'ev_2', destroyedAt: 3 };
    expect([2, 3].map((t) => isTraceAvailable(destroyed, t))).toEqual([true, false]);
    const lasting = { ...mark, id: 'tr_y', sourceEventId: 'ev_1', availableFrom: -5 };
    expect(isTraceAvailable(lasting, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test('null and a missing decaysAfter both mean no decay; zero is rejected', () => {
    const traces = single(
      [{ verb: 'take', produces: [physicalHere, { ...physicalHere, decaysAfter: null }] }],
      event(),
    );
    expect(withoutId(traces[0]!)).toEqual(withoutId(traces[1]!));
    expect(traces[0]).not.toHaveProperty('decaysAt');
    expect(() =>
      compile([{ verb: 'take', produces: [{ ...physicalHere, decaysAfter: 0 }] }]),
    ).toThrow(expect.objectContaining({ path: 'traceRules.0.produces.0.decaysAfter' }));
    expect(() =>
      compile([{ verb: 'take', produces: [{ ...physicalHere, decaysAfter: -1 }] }]),
    ).toThrow(EvidenceError);
  });
});

describe('compileTraceRules', () => {
  test('rejects rules outside the content schema with EVIDENCE_RULE_INVALID', () => {
    const invalid = [{ verb: 'take', produces: [] }];
    expect(() => compile(invalid)).toThrow(EvidenceError);
    expect(() => compile(invalid)).toThrow(
      expect.objectContaining({ code: 'EVIDENCE_RULE_INVALID', path: 'traceRules.0.produces' }),
    );
    expect(() => compileTraceRules({})).toThrow(expect.objectContaining({ path: 'traceRules' }));
  });

  test('rejects location placeholders other than $location', () => {
    const rules = [{ verb: 'take', produces: [physicalHere, { ...physicalHere, at: '$actor' }] }];
    expect(() => compile(rules)).toThrow(
      expect.objectContaining({
        code: 'EVIDENCE_RULE_INVALID',
        path: 'traceRules.0.produces.1.at',
      }),
    );
    expect(() => compile(rules)).toThrow(/Expected a location ID or one of: \$location/);
  });

  test('accepts only verbs a truth event can carry', () => {
    const rule = (verb: string) => [{ verb, produces: [physicalHere] }];
    expect(() => compile(rule('take-item'))).toThrow(
      expect.objectContaining({ code: 'EVIDENCE_RULE_INVALID', path: 'traceRules.0.verb' }),
    );
    expect(() => compile(rule('Take'))).toThrow(EvidenceError);
    expect(() => new TruthLog().append(event({ verb: 'take-item' }))).toThrow();

    expect(single(rule('take_item'), event({ verb: 'take_item' }))).toEqual([
      {
        ...mark,
        id: hashId('tr', { sourceEventId: 'ev_1', rule: 0, spec: 0 }, 16),
        sourceEventId: 'ev_1',
        location: hall,
        availableFrom: 10,
      },
    ]);
  });

  test('returns a detached deeply frozen copy', () => {
    const source = [{ verb: 'take', produces: [{ ...physicalHere }] }];
    const compiled = compile(source);
    source[0]!.verb = 'walk';
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
  const forged = { rules: [{ verb: 'take', produces: [physicalHere] }, ...conserved] };

  test('a plain object with the same shape is not a compiled rule set', () => {
    expectTypeOf(forged).not.toExtend<TraceRuleSet>();
    expectTypeOf(compile([])).toExtend<TraceRuleSet>();
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
    const rules = compile([{ verb: 'take', produces: [physicalHere] }]);
    const log = logOf(...Array.from({ length: 12 }, () => event({ t: 7 })));
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
    const common = {
      sourceEventId: 'ev_1',
      supports: [],
      captureMode: 'auto',
      itemId: 'it_vial',
      availableFrom: 5,
    };

    expect(single(rules, event({ t: 3, duration: 2, targets: [item('it_vial')] }))).toEqual([
      { ...common, id: id(0, 0), kind: 'physical', template: 'a', location: hall },
      { ...common, id: id(0, 1), kind: 'document', template: 'b', location: hall },
      { ...common, id: id(2, 0), kind: 'digital', template: 'c', location: archive, decaysAt: 50 },
      { ...common, id: id(2, 1), kind: 'testimonial', template: 'd', location: hall },
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
      supports: [],
    });
  });

  test('rejects an availableFrom beyond the safe range', () => {
    expect(() => single(plain, event({ t: max - 5, duration: 6 }))).toThrow(
      new RangeError('Trace availableFrom of ev_1 is outside the safe integer range'),
    );
  });

  test('rejects a decaysAt beyond the safe range without returning partial traces', () => {
    const log = logOf(event({ t: 0 }), event({ t: max - 9 }));
    expect(() => deriveTraces(log, compile([...plain, ...decaying]), items)).toThrow(
      new RangeError('Trace decaysAt of ev_2 is outside the safe integer range'),
    );
  });

  test('rejects a destruction ending beyond the safe range', () => {
    const log = logOf(
      event({ t: 0 }),
      event({ t: max - 5, duration: 6, verb: 'destroy', targets: [item('it_cup')] }),
    );
    expect(() => deriveTraces(log, compile(plain), items)).toThrow(
      new RangeError('Trace destroyedAt of ev_2 is outside the safe integer range'),
    );
  });
});
