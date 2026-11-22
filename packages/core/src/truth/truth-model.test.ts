import { expect, test } from 'vitest';
import { factId, TruthLog, TruthModel, type Fact, type IncidentRecord, type TruthEventInput } from './index.ts';

const anna = 'ch_anna';
const ivan = 'ch_ivan';
const hall = 'loc_hall';
const office = 'loc_office';
const item = 'it_key';
const motive = factId({ kind: 'motive', who: anna, against: ivan, motiveType: 'debt', basis: [] });

function incident(): IncidentRecord {
  return {
    type: 'theft',
    victimIds: [ivan],
    culpritIds: [anna],
    motive,
    means: item,
    keyEventIds: ['ev_3'],
    window: { from: -3, to: 6 },
  };
}

function event(t: number, overrides: Partial<TruthEventInput> = {}): TruthEventInput {
  return {
    t,
    duration: 0,
    verb: 'stay',
    actorIds: [anna],
    location: hall,
    targets: [],
    causes: [],
    facts: [],
    traceIds: [],
    visibility: 'public',
    ...overrides,
  };
}

function presence(who: string, where: string, from: number, to: number): Fact {
  return { kind: 'at', who, where, interval: { from, to } };
}

function scenario(): TruthModel {
  const model = new TruthModel(incident());
  model.append(event(4, { facts: [presence(anna, office, 4, 9)] }));
  model.append(event(-3, { facts: [presence(anna, hall, -3, 0), presence(ivan, hall, -2, 1)] }));
  model.append(event(0, {
    verb: 'take',
    causes: ['ev_2'],
    facts: [{ kind: 'possessed', who: anna, item, interval: { from: 0, to: 6 } }],
  }));
  return model;
}

test.each([
  [-4, 'in_transit'], [-3, hall], [-1, hall], [0, 'in_transit'], [3, 'in_transit'],
  [4, office], [8, office], [9, 'in_transit'],
])('looks up presence at minute %i', (minute, location) => {
  expect(scenario().whereWas(anna, minute)).toBe(location);
});

test('queries sorted presence, overlapping visits, possessions and filtered facts', () => {
  const truth = scenario();
  expect(truth.presenceIntervals(anna)).toEqual([
    { location: hall, interval: { from: -3, to: 0 } },
    { location: office, interval: { from: 4, to: 9 } },
  ]);
  expect(truth.whoWasAt(hall, { from: -2, to: 0 })).toEqual([anna, ivan]);
  expect(truth.whoWasAt(hall, { from: 0, to: 1 })).toEqual([ivan]);
  expect(truth.whoWasAt(hall, { from: 0, to: 0 })).toEqual([]);
  expect(truth.possession(item)).toEqual([{ holder: anna, interval: { from: 0, to: 6 } }]);
  expect(truth.possession('it_missing')).toEqual([]);
  expect(truth.facts({ kind: 'at' })).toHaveLength(3);
  expect(truth.facts({ pattern: { kind: 'at', where: office } })).toEqual([presence(anna, office, 4, 9)]);
  const [copy] = truth.presenceIntervals(anna);
  copy!.interval.from = -100;
  expect(truth.whereWas(anna, -4)).toBe('in_transit');
});

test('sorts transitive causes by time and append order and removes duplicates', () => {
  const truth = new TruthModel(incident());
  const first = truth.append(event(-1));
  const earlier = truth.append(event(-3));
  for (let index = 0; index < 7; index++) truth.append(event(0));
  const later = truth.append(event(-1, { causes: [first, earlier] }));
  const root = truth.append(event(4, { causes: [later, earlier] }));
  expect(truth.causalChain(root)).toEqual([earlier, first, later]);
  expect(truth.events().slice(0, 3).map(({ id }) => id)).toEqual([earlier, first, later]);
  expect(() => truth.causalChain('ev_99')).toThrow(expect.objectContaining({ code: 'TRUTH_UNKNOWN_EVENT' }));
});

test('detaches the appended event from its source and deeply freezes it', () => {
  const log = new TruthLog();
  const interval = { from: 0, to: 2 };
  const source = event(0, { facts: [{ kind: 'at', who: anna, where: hall, interval }] });
  const stored = log.append(source);
  const [fact] = stored.facts;
  if (fact?.kind !== 'at') throw new Error('Expected presence fact');

  source.actorIds.push(ivan);
  interval.to = 99;
  expect(log.get(stored.id)?.actorIds).toEqual([anna]);
  expect(fact.interval.to).toBe(2);
  expect(() => stored.facts.pop()).toThrow(TypeError);
  expect(() => { fact.interval.to = 99; }).toThrow(TypeError);
  expect(Object.isFrozen(stored)).toBe(true);
  expect(Object.isFrozen(log.events())).toBe(true);
});

test('round-trips incident, events and IDs and rebuilds the indexes', () => {
  const truth = scenario();
  const json = truth.serialize();
  const restored = TruthModel.deserialize(json);

  expect(restored.serialize()).toBe(json);
  expect(restored.events()).toEqual(truth.events());
  expect(restored.incident.culpritIds).toEqual([anna]);
  expect(Object.isFrozen(restored.incident.culpritIds)).toBe(true);
  expect(restored.whereWas(anna, 4)).toBe(office);
  expect(restored.possession(item)).toEqual(truth.possession(item));
  expect(restored.causalChain('ev_3')).toEqual(['ev_2']);
  expect(restored.append(event(9))).toBe('ev_4');

  expect(() => TruthModel.deserialize(json.replace('"id":"ev_1"', '"id":"ev_9"')))
    .toThrow(expect.objectContaining({ code: 'TRUTH_INVALID_EVENT_ID' }));
});
