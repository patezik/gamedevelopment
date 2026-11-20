import { expect, test } from 'vitest';
import { KnowledgeStore, type Belief } from '@hs/core/knowledge';
import { factId, factSchema, type Proposition, type PropositionPattern } from '@hs/core/truth';

const action = {
  kind: 'did',
  who: 'ch_anna',
  verb: 'open',
  at: -23,
  where: 'loc_office',
} as const;
const actionPattern = { kind: 'did', who: 'ch_anna', at: -23 } as const;
const presence = {
  kind: 'at',
  who: 'ch_anna',
  where: 'loc_hall',
  interval: { from: -23, to: -20 },
} as const;

function belief(proposition: Proposition = action, overrides: Partial<Belief> = {}): Belief {
  return {
    proposition,
    confidence: 0.8,
    source: 'observed',
    acquiredAt: -60,
    fuzzMinutes: 0,
    ...overrides,
  };
}

test('stores conflicting and false propositions and queries by the original proposition pattern', () => {
  const store = new KnowledgeStore();
  const mistaken = belief(
    { ...presence, where: 'loc_cellar' },
    { confidence: 1, source: 'told', fromCharacter: 'ch_igor' },
  );
  store.add(belief(presence));
  store.add(mistaken);

  expect(store.query({ kind: 'at', who: { var: 'person' } })).toEqual([mistaken, belief(presence)]);
  expect(store.query({ kind: 'at', where: 'loc_cellar' })).toEqual([mistaken]);
  expect(store.recall({ kind: 'at', where: 'loc_cellar' }, 0)).toEqual({
    ...mistaken,
    fuzzMinutes: 1,
  });
  expect(store.query(actionPattern)).toEqual([]);
  expect(store.recall(actionPattern, 0)).toBeUndefined();
});

test('merges canonical duplicates using maximum confidence and keeps the winning provenance', () => {
  const store = new KnowledgeStore();
  const strongest = belief(presence, {
    confidence: 0.9,
    source: 'told',
    fromCharacter: 'ch_igor',
    fuzzMinutes: 4,
  });
  store.add(belief(presence));
  store.add(strongest);
  store.add(
    belief({ ...presence, interval: { to: -20, from: -23 } }, { acquiredAt: -10, source: 'read' }),
  );

  expect(store.query({ kind: 'at' })).toEqual([strongest]);
});

test('resolves duplicate ties by acquisition time, precision and source regardless of insertion order', () => {
  const winner = belief(action, { acquiredAt: -30, source: 'read', fuzzMinutes: 1 });
  const entries = [
    winner,
    { ...winner, acquiredAt: -31 },
    { ...winner, fuzzMinutes: 2 },
    { ...winner, source: 'told' } satisfies Belief,
    { ...winner, fromCharacter: 'ch_igor' },
  ];

  for (const order of [entries, entries.toReversed()]) {
    const store = new KnowledgeStore();
    order.forEach((entry) => store.add(entry));
    expect(store.query(actionPattern)).toEqual([winner]);
  }
});

test('recalls the strongest available match with deterministic ties and excludes future acquisitions', () => {
  const earlier = belief(action, { acquiredAt: -61 });
  const newer = belief({ ...action, where: 'loc_hall' });
  const peer = belief({ ...action, where: 'loc_kitchen' });
  const future = belief({ ...action, where: 'loc_cellar' }, { confidence: 1, acquiredAt: 1 });
  const winner = factId(newer.proposition) < factId(peer.proposition) ? newer : peer;

  const first = new KnowledgeStore();
  const second = new KnowledgeStore();
  [earlier, newer, peer, future].forEach((entry) => first.add(entry));
  [future, peer, newer, earlier].forEach((entry) => second.add(entry));

  expect(first.recall(actionPattern, -62)).toBeUndefined();
  expect(first.recall(actionPattern, -61)).toEqual(earlier);
  expect(first.recall(actionPattern, -60)).toEqual(winner);
  expect(second.recall(actionPattern, -60)).toEqual(winner);
  expect(first.recall(actionPattern, 1)).toEqual(future);
  expect(first.query(actionPattern)).toEqual(second.query(actionPattern));
  expect(first.serialize()).toBe(second.serialize());
});

test.each([
  [59, 0, -23],
  [419, 6, -23],
  [420, 7, -30],
  [899, 14, -30],
  [900, 15, -30],
  [1799, 29, -30],
  [1800, 30, 0],
  [3600, 60, 0],
])('recalls elapsed %i minutes with fuzz %i and action minute %i', (elapsed, fuzzMinutes, at) => {
  const store = new KnowledgeStore();
  const original = belief();
  store.add(original);

  const expected = { ...original, proposition: { ...action, at }, fuzzMinutes };
  expect(store.recall(actionPattern, original.acquiredAt + elapsed)).toEqual(expected);
  expect(store.recall(actionPattern, original.acquiredAt + elapsed)).toEqual(expected);
  expect(store.query(actionPattern)).toEqual([original]);
});

test('changes to a half-hour grid at 15 minutes of fuzz and rounds halfway toward the later minute', () => {
  const store = new KnowledgeStore();
  const original = belief({ ...action, at: -15 }, { fuzzMinutes: 14 });
  store.add(original);

  expect(store.recall({ kind: 'did' }, -1)).toEqual(original);
  expect(store.recall({ kind: 'did' }, 0)).toEqual({
    ...original,
    proposition: { ...action, at: 0 },
    fuzzMinutes: 15,
  });
});

const shortInterval = { from: -27, to: -24 };

test.each<{ proposition: Proposition; pattern: PropositionPattern }>([
  { proposition: { ...presence, interval: shortInterval }, pattern: { kind: 'at' } },
  {
    proposition: { kind: 'possessed', who: 'ch_anna', item: 'it_key', interval: shortInterval },
    pattern: { kind: 'possessed' },
  },
  {
    proposition: {
      kind: 'state',
      entity: { kind: 'item', id: 'it_key' },
      property: 'hidden',
      value: true,
      interval: shortInterval,
    },
    pattern: { kind: 'state' },
  },
])(
  'keeps short $pattern.kind intervals valid and within the fuzz bound',
  ({ proposition, pattern }) => {
    const store = new KnowledgeStore();
    store.add(belief(proposition, { fuzzMinutes: 7 }));

    const result = store.recall(pattern, -60);
    expect(result?.proposition).toEqual({ ...proposition, interval: { from: -30, to: -27 } });
    expect(factSchema.safeParse(result?.proposition).success).toBe(true);
  },
);

test('rounds both endpoints when the rounded interval has positive length', () => {
  const store = new KnowledgeStore();
  store.add(belief({ ...presence, interval: { from: -23, to: 2 } }, { fuzzMinutes: 7 }));
  expect(store.recall({ kind: 'at' }, 0)?.proposition).toEqual({
    ...presence,
    interval: { from: -30, to: 0 },
  });
});

test('rounds relationship dates, preserves missing dates and leaves untimed motives intact', () => {
  const store = new KnowledgeStore();
  const relation = { kind: 'relation', a: 'ch_anna', b: 'ch_igor', relType: 'debt' } as const;
  const motive = {
    kind: 'motive',
    who: 'ch_anna',
    against: 'ch_igor',
    motiveType: 'debt',
    basis: [factId(presence)],
  } as const;
  const dated = belief({ ...relation, since: -23 }, { fuzzMinutes: 15 });
  const undated = belief(relation, { fuzzMinutes: 15 });
  store.add(dated);
  store.add(undated);
  store.add(belief({ ...motive, basis: [...motive.basis] }, { fuzzMinutes: 15 }));

  expect(store.recall({ kind: 'relation', since: -23 }, 0)?.proposition).toEqual({
    ...relation,
    since: -30,
  });
  expect(store.recall({ kind: 'motive' }, 0)?.proposition).toEqual(motive);
  expect(store.recall({ kind: 'relation' }, 0)?.fuzzMinutes).toBe(16);

  const anotherStore = new KnowledgeStore();
  anotherStore.add(undated);
  expect(anotherStore.recall({ kind: 'relation' }, 0)?.proposition).toStrictEqual(relation);
});

test('keeps stored data detached from inputs and query and recall results', () => {
  const store = new KnowledgeStore();
  const original = belief({ ...presence, interval: { ...presence.interval } });
  store.add(original);
  const queried = store.query({ kind: 'at' })[0]?.proposition;
  const recalled = store.recall({ kind: 'at' }, 0)?.proposition;

  if (original.proposition.kind === 'at') original.proposition.interval.from = -99;
  if (queried?.kind === 'at') queried.interval.from = -98;
  if (recalled?.kind === 'at') recalled.interval.from = -97;

  expect(store.query({ kind: 'at' })).toEqual([belief(presence)]);
});

test('round-trips exact memory and provenance without recording the effects of recall', () => {
  const store = new KnowledgeStore();
  const entry = belief(
    { ...action, target: { kind: 'item', id: 'it_key' } },
    { source: 'told', fromCharacter: 'ch_igor', fuzzMinutes: 3 },
  );
  store.add(entry);
  store.add(belief(presence, { source: 'inferred' }));
  const serialized = store.serialize();
  const restored = KnowledgeStore.deserialize(serialized);

  expect(store.recall(actionPattern, 1800)).toEqual(restored.recall(actionPattern, 1800));
  expect(restored.query(actionPattern)).toEqual([entry]);
  expect(store.serialize()).toBe(serialized);
  expect(restored.serialize()).toBe(serialized);
  expect(KnowledgeStore.deserialize(new KnowledgeStore().serialize()).query(actionPattern)).toEqual(
    [],
  );
});

test('normalizes explicitly undefined optional proposition fields across snapshots', () => {
  const store = new KnowledgeStore();
  store.add(belief({ ...action, target: undefined }));
  const restored = KnowledgeStore.deserialize(store.serialize());
  expect(store.query(actionPattern)).toStrictEqual([belief()]);
  expect(restored.query(actionPattern)).toStrictEqual(store.query(actionPattern));
});

test('rejects invalid fields and snapshots without adding a partial belief', () => {
  const store = new KnowledgeStore();
  expect(() => store.add(belief(action, { confidence: 1.1 }))).toThrow();
  expect(() => store.add(belief(action, { fuzzMinutes: -1 }))).toThrow();
  expect(() => store.add(belief(action, { acquiredAt: -0.5 }))).toThrow();
  expect(() => store.recall(actionPattern, Infinity)).toThrow();
  expect(() => KnowledgeStore.deserialize('{')).toThrow(SyntaxError);
  expect(() =>
    KnowledgeStore.deserialize(JSON.stringify([belief(), { ...belief(), source: 'unknown' }])),
  ).toThrow();
  expect(store.query(actionPattern)).toEqual([]);
});

test('keeps rounding and aged fuzz within safe integer bounds', () => {
  const store = new KnowledgeStore();
  const min = Number.MIN_SAFE_INTEGER;
  const max = Number.MAX_SAFE_INTEGER;
  store.add(belief({ ...action, at: min }, { acquiredAt: min, fuzzMinutes: max }));
  const result = store.recall({ kind: 'did' }, max);

  expect(result?.proposition).toEqual({ ...action, at: min });
  expect(result?.fuzzMinutes).toBe(max);
});
