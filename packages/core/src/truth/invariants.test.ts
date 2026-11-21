import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadScenarioFromDir } from '../content/index.ts';
import { ItemRegistry, LocationGraph } from '../world/index.ts';
import {
  assertInvariants,
  checkTruthInvariants,
  factId,
  TruthInvariantError,
  TruthModel,
  withInvariantChecks,
  type EntityRef,
  type EventId,
  type Fact,
  type IncidentRecord,
  type InvariantViolation,
  type TruthEventInput,
} from './index.ts';

const anna = 'ch_anna';
const ivan = 'ch_ivan';
const boris = 'ch_boris';
const hall = 'loc_hall';
const office = 'loc_office';
const cellar = 'loc_cellar';
const vault = 'loc_vault';
const garden = 'loc_garden';
const knife = 'it_knife';
const key = 'it_key';
const box = 'it_box';
const chest = 'it_chest';
const ring = 'it_ring';

const minimal = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const template = minimal.locations[0]!;

function place(id: string, connections: (typeof template)['connections']) {
  return { ...template, id, name: id, connections };
}

// hall ⇄ office (5), hall → cellar (3, one way), office → vault (2, locked by the key),
// vault → office (2); the garden has no connections.
const locations = [
  place(hall, [
    { to: office, minutes: 5 },
    { to: cellar, minutes: 3 },
  ]),
  place(office, [
    { to: hall, minutes: 5 },
    { to: vault, minutes: 2, locked: { itemId: key } },
  ]),
  place(cellar, []),
  place(vault, [{ to: office, minutes: 2 }]),
  place(garden, []),
];
const items = [
  { id: knife, name: 'Knife', kind: 'tool', tags: [], locationId: office },
  { id: key, name: 'Key', kind: 'key', tags: [], locationId: hall },
  { id: chest, name: 'Chest', kind: 'chest', tags: [], locationId: cellar },
  { id: box, name: 'Box', kind: 'box', tags: [], containerId: chest },
  { id: ring, name: 'Ring', kind: 'jewel', tags: [], containerId: box },
];

function world() {
  return {
    locations: new LocationGraph({ preset: minimal.preset, locations }),
    items: new ItemRegistry({ locations, items }, new Map(), -60),
  };
}

function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    type: 'murder',
    victimIds: [ivan],
    culpritIds: [anna],
    motive: factId({ kind: 'motive', who: anna, against: ivan, motiveType: 'debt', basis: [] }),
    means: knife,
    keyEventIds: ['ev_5', 'ev_9'],
    window: { from: -60, to: 60 },
    ...overrides,
  };
}

function event(t: number, overrides: Partial<TruthEventInput> = {}): TruthEventInput {
  return {
    t,
    duration: 0,
    verb: 'stay',
    actorIds: [],
    location: hall,
    targets: [],
    causes: [],
    facts: [],
    traceIds: [],
    visibility: 'public',
    ...overrides,
  };
}

function at(who: string, where: string, from: number, to: number): Fact {
  return { kind: 'at', who, where, interval: { from, to } };
}

function holds(who: string, itemId: string, from: number, to: number): Fact {
  return { kind: 'possessed', who, item: itemId, interval: { from, to } };
}

function dies(who: string, from: number): Fact {
  const entity: EntityRef = { kind: 'character', id: who };
  return { kind: 'state', entity, property: 'alive', value: false, interval: { from, to: 4320 } };
}

const target = (kind: EntityRef['kind'], id: string): EntityRef => ({ kind, id });

/** A transition in the SIM-001 format: the origin is the location, the destination a target. */
function move(
  who: string,
  from: string,
  to: string,
  t: number,
  duration: number,
  facts: Fact[] = [],
): TruthEventInput {
  return event(t, {
    verb: 'move',
    duration,
    actorIds: [who],
    location: from,
    targets: [target('location', to)],
    facts: [
      { kind: 'did', who, verb: 'move', target: target('location', to), at: t, where: from },
      ...facts,
    ],
  });
}

/** A stay in the SIM-001 format. */
function stay(who: string, where: string, from: number, to: number): TruthEventInput {
  return event(from, {
    duration: to - from,
    actorIds: [who],
    location: where,
    facts: [at(who, where, from, to)],
  });
}

/**
 * A consistent murder: Anna takes the knife in the office, strikes Ivan in the hall at minute 36
 * and hides the knife in the box in the cellar. Boris stays in the hall throughout.
 */
function story(options: { incident?: Partial<IncidentRecord>; debug?: boolean } = {}) {
  const w = world();
  const truth = new TruthModel(incident(options.incident));
  const writer =
    options.debug === undefined ? truth : withInvariantChecks(truth, w, { enabled: options.debug });
  const append = (input: TruthEventInput): EventId => writer.append(input);

  append(event(-60, { actorIds: [anna], facts: [at(anna, hall, -60, -10)] })); // ev_1
  append(event(-60, { actorIds: [ivan], location: office, facts: [at(ivan, office, -60, 0)] }));
  append(event(-60, { actorIds: [boris], facts: [at(boris, hall, -60, 100)] })); // ev_3
  const arrive = append(move(anna, hall, office, -10, 5, [at(anna, office, -5, 30)]));
  const take = append(
    event(0, {
      verb: 'take',
      actorIds: [anna],
      location: office,
      targets: [target('item', knife)],
      causes: [arrive],
      facts: [
        holds(anna, knife, 0, 55),
        {
          kind: 'did',
          who: anna,
          verb: 'take',
          target: target('item', knife),
          at: 0,
          where: office,
        },
      ],
    }),
  ); // ev_5
  w.items.move(knife, { kind: 'character', id: anna }, 0, take);
  append(move(ivan, office, hall, 0, 10, [at(ivan, hall, 10, 40)]));
  append(event(15, { verb: 'talk', duration: 10, actorIds: [boris, ivan] })); // ev_7
  append(move(anna, office, hall, 30, 5, [at(anna, hall, 35, 50)]));
  const strike = append(
    event(36, {
      verb: 'strike',
      actorIds: [anna],
      targets: [target('character', ivan), target('item', knife)],
      causes: [take],
      facts: [dies(ivan, 36)],
      visibility: 'covert',
    }),
  ); // ev_9
  append(event(36, { verb: 'shout', actorIds: [boris], causes: [strike] })); // ev_10
  append(move(anna, hall, cellar, 50, 3, [at(anna, cellar, 53, 70)]));
  const hide = append(
    event(55, {
      verb: 'hide',
      actorIds: [anna],
      location: cellar,
      targets: [target('item', knife), target('item', box)],
      causes: [strike],
    }),
  ); // ev_12
  w.items.move(knife, { kind: 'container', id: box }, 55, hide);
  return { truth, world: w, append };
}

/** A log with only the incident, for focused cases. */
function blank(incidentOverrides: Partial<IncidentRecord> = { keyEventIds: [] }) {
  const w = world();
  const truth = new TruthModel(incident(incidentOverrides));
  return { truth, world: w, append: (input: TruthEventInput) => truth.append(input) };
}

function check({ truth, world: w }: { truth: TruthModel; world: ReturnType<typeof world> }) {
  return checkTruthInvariants(truth, w);
}

const codes = (violations: readonly InvariantViolation[]) => violations.map(({ code }) => code);

describe('a consistent log', () => {
  test('passes every checked invariant, including prehistory and same-minute causes', () => {
    expect(check(story())).toEqual([]);
  });

  test('gives the same result on repeated checks and after a serialization round trip', () => {
    const broken = story();
    broken.append(event(10, { actorIds: [anna], facts: [at(anna, cellar, 20, 25)] }));
    broken.append(event(40, { actorIds: [ivan], causes: ['ev_99'] }));
    const first = check(broken);
    expect(codes(first)).toEqual([
      'PRESENCE_OVERLAP',
      'ACTOR_ELSEWHERE',
      'CAUSE_UNKNOWN',
      'ACTION_AFTER_DEATH',
    ]);
    expect(first.map(({ invariant }) => invariant)).toEqual([1, 1, 3, 5]);
    expect(check(broken)).toEqual(first);
    const restored = TruthModel.deserialize(broken.truth.serialize());
    expect(checkTruthInvariants(restored, broken.world)).toEqual(first);
  });
});

describe('invariant 1: one place at a time', () => {
  test('reports overlapping stays in different locations with both events', () => {
    const log = story();
    const id = log.append(event(20, { facts: [at(anna, cellar, 20, 25)] }));
    expect(check(log)).toEqual([
      expect.objectContaining({
        invariant: 1,
        code: 'PRESENCE_OVERLAP',
        eventIds: [id, 'ev_4'],
        subject: { kind: 'character', id: anna },
        minute: 20,
      }),
    ]);
  });

  test('treats stays as half-open and allows repeated stays in one location', () => {
    const touching = blank();
    touching.append(event(0, { facts: [at(anna, hall, 0, 10), at(anna, hall, 5, 10)] }));
    touching.append(event(0, { facts: [at(anna, office, 10, 20)] }));
    // Leaving at 10 and arriving at 10 is instantaneous travel, not a double presence.
    expect(codes(check(touching))).toEqual(['TRAVEL_TOO_FAST']);
  });

  test('reports an actor who acts away from where the truth places them', () => {
    const log = story();
    const id = log.append(event(10, { verb: 'read', actorIds: [anna] }));
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'ACTOR_ELSEWHERE', eventIds: [id, 'ev_4'], minute: 10 }),
    ]);

    const prehistory = story();
    prehistory.append(event(-20, { actorIds: [anna] }));
    expect(check(prehistory)).toEqual([]);
    prehistory.append(event(-20, { actorIds: [anna], location: office }));
    expect(check(prehistory)).toEqual([
      expect.objectContaining({
        code: 'ACTOR_ELSEWHERE',
        eventIds: ['ev_14', 'ev_1'],
        minute: -20,
      }),
    ]);
  });

  test('checks the whole span of an event and skips travel and unknown presence', () => {
    const log = story();
    log.append(event(29, { verb: 'search', duration: 1, actorIds: [anna], location: office }));
    log.append(event(30, { verb: 'search', duration: 5, actorIds: [anna], location: garden }));
    log.append(event(10, { verb: 'move', actorIds: [anna], location: hall }));
    expect(check(log)).toEqual([]);

    const id = log.append(
      event(29, { verb: 'search', duration: 10, actorIds: [anna], location: office }),
    );
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'ACTOR_ELSEWHERE', eventIds: [id, 'ev_8'], minute: 35 }),
    ]);
  });
});

describe('invariant 2: travel takes at least the route time', () => {
  test('accepts a trip that takes exactly the route time, also in prehistory', () => {
    const log = blank();
    log.append(event(-60, { facts: [at(anna, hall, -60, -30), at(anna, office, -25, -10)] }));
    expect(check(log)).toEqual([]);
  });

  test('reports a trip faster than the shortest route', () => {
    const log = blank();
    log.append(event(0, { facts: [at(anna, office, 0, 30)] }));
    const id = log.append(event(30, { facts: [at(anna, hall, 33, 40)] }));
    expect(check(log)).toEqual([
      {
        invariant: 2,
        code: 'TRAVEL_TOO_FAST',
        eventIds: [id, 'ev_1'],
        subject: { kind: 'character', id: anna },
        minute: 33,
        message: `${anna} travels from ${office} to ${hall} in 3 min, the route takes 5 min`,
      },
    ]);
  });

  test('respects connection direction and reports missing routes', () => {
    const oneWay = blank();
    oneWay.append(event(0, { facts: [at(anna, hall, 0, 10), at(anna, cellar, 13, 20)] }));
    expect(check(oneWay)).toEqual([]);
    oneWay.append(event(0, { facts: [at(anna, hall, 100, 110)] }));
    oneWay.append(event(0, { facts: [at(anna, garden, 200, 210)] }));
    expect(check(oneWay)).toEqual([
      expect.objectContaining({ code: 'TRAVEL_NO_ROUTE', eventIds: ['ev_2', 'ev_1'], minute: 100 }),
      expect.objectContaining({ code: 'TRAVEL_NO_ROUTE', eventIds: ['ev_3', 'ev_2'], minute: 200 }),
    ]);
  });

  test('reports locations missing from the world', () => {
    const log = blank();
    log.append(event(0, { facts: [at(anna, hall, 0, 10), at(anna, 'loc_moon', 20, 30)] }));
    expect(codes(check(log))).toEqual(['TRAVEL_UNKNOWN_LOCATION']);
  });

  test('opens a locked route only for a character holding the key', () => {
    const locked = blank();
    locked.append(event(0, { facts: [at(anna, office, 0, 10), at(anna, vault, 12, 20)] }));
    expect(codes(check(locked))).toEqual(['TRAVEL_NO_ROUTE']);

    // The key is known from a possession fact that the registry mirrors.
    const owned = blank();
    owned.append(event(0, { facts: [at(anna, office, 0, 10), at(anna, vault, 12, 20)] }));
    const take = owned.append(
      event(-5, { verb: 'take', actorIds: [anna], facts: [holds(anna, key, -5, 15)] }),
    );
    owned.append(event(-10, { facts: [at(anna, hall, -10, -5)] }));
    owned.world.items.move(key, { kind: 'character', id: anna }, -5, take);
    expect(check(owned)).toEqual([]);

    // The key is known only from the registry.
    const registered = blank();
    registered.append(event(0, { facts: [at(anna, office, 0, 10), at(anna, vault, 12, 20)] }));
    const pick = registered.append(event(-30, { verb: 'take', targets: [target('item', key)] }));
    registered.world.items.move(key, { kind: 'character', id: anna }, -30, pick);
    expect(check(registered)).toEqual([]);
  });
});

describe('invariant 3: causes precede effects', () => {
  test('accepts causes that end exactly when the effect starts', () => {
    const log = blank();
    const cause = log.append(event(10, { duration: 5 }));
    log.append(event(15, { causes: [cause, cause] }));
    expect(check(log)).toEqual([]);
  });

  test('reports unknown, self and late causes', () => {
    const log = blank();
    const cause = log.append(event(10, { duration: 10 }));
    log.append(event(15, { causes: [cause] }));
    log.append(event(20, { causes: ['ev_99'] }));
    log.append(event(-5, { causes: ['ev_4'] }));
    log.append(event(-10, { causes: [cause] }));
    // By code in table order, then by the log order of the events.
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'CAUSE_UNKNOWN', eventIds: ['ev_3'], minute: 20 }),
      expect.objectContaining({ code: 'CAUSE_SELF', eventIds: ['ev_4'], minute: -5 }),
      expect.objectContaining({
        code: 'CAUSE_NOT_BEFORE_EFFECT',
        eventIds: ['ev_5', cause],
        minute: -10,
      }),
      expect.objectContaining({
        code: 'CAUSE_NOT_BEFORE_EFFECT',
        eventIds: ['ev_2', cause],
        minute: 15,
      }),
    ]);
  });

  test('reports a cycle of instantaneous events in the same minute once', () => {
    const log = blank();
    log.append(event(5, { causes: ['ev_3'] }));
    log.append(event(5, { causes: ['ev_1'] }));
    log.append(event(5, { causes: ['ev_2'] }));
    log.append(event(5, { causes: ['ev_1', 'ev_2'] }));
    expect(check(log)).toEqual([
      expect.objectContaining({
        code: 'CAUSE_CYCLE',
        eventIds: ['ev_1', 'ev_3', 'ev_2'],
        minute: 5,
      }),
    ]);

    const diamond = blank();
    diamond.append(event(5));
    diamond.append(event(5, { causes: ['ev_1'] }));
    diamond.append(event(5, { causes: ['ev_1'] }));
    diamond.append(event(5, { causes: ['ev_2', 'ev_3'] }));
    expect(check(diamond)).toEqual([]);
  });

  test('checks the causes of item moves in the registry', () => {
    const log = blank();
    const take = log.append(event(10, { verb: 'take', targets: [target('item', knife)] }));
    log.world.items.move(knife, { kind: 'location', id: hall }, 5, take);
    log.world.items.move(knife, { kind: 'location', id: cellar }, 10, 'ev_404');
    log.world.items.move(knife, { kind: 'location', id: office }, 12, take);
    // Codes follow the table order: unknown causes before early moves.
    expect(check(log)).toEqual([
      expect.objectContaining({
        code: 'ITEM_MOVE_UNKNOWN_CAUSE',
        eventIds: [],
        subject: { kind: 'item', id: knife },
        minute: 10,
      }),
      expect.objectContaining({ code: 'ITEM_MOVE_BEFORE_CAUSE', eventIds: [take], minute: 5 }),
    ]);
  });
});

describe('invariant 4: one holder and one placement per item', () => {
  test('reports two holders at once together with the registry mismatch', () => {
    const log = story();
    const id = log.append(event(20, { facts: [holds(boris, knife, 20, 40)] }));
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'ITEM_HOLDER_OVERLAP', eventIds: [id, 'ev_5'], minute: 20 }),
      expect.objectContaining({ code: 'ITEM_PLACEMENT_CONFLICT', eventIds: [id], minute: 20 }),
    ]);
  });

  test('allows consecutive holders and repeated possession by one holder', () => {
    const log = blank();
    const first = log.append(
      event(0, { facts: [holds(anna, knife, 0, 10), holds(anna, knife, 5, 10)] }),
    );
    const second = log.append(event(10, { facts: [holds(boris, knife, 10, 20)] }));
    log.world.items.move(knife, { kind: 'character', id: anna }, 0, first);
    log.world.items.move(knife, { kind: 'character', id: boris }, 10, second);
    expect(check(log)).toEqual([]);
  });

  test('reports the first minute the registry places a held item elsewhere', () => {
    const log = blank();
    const take = log.append(event(0, { verb: 'take', facts: [holds(anna, knife, 0, 30)] }));
    const drop = log.append(event(20, { verb: 'drop' }));
    log.world.items.move(knife, { kind: 'character', id: anna }, 0, take);
    log.world.items.move(knife, { kind: 'location', id: hall }, 20, drop);
    expect(check(log)).toEqual([
      expect.objectContaining({
        code: 'ITEM_PLACEMENT_CONFLICT',
        eventIds: [take],
        minute: 20,
        message: `${knife} is held by ${anna} in the truth but is at location ${hall} in the registry at minute 20`,
      }),
    ]);
  });

  test('follows containers through their own history', () => {
    const log = blank();
    const take = log.append(event(0, { verb: 'take', facts: [holds(anna, ring, 0, 20)] }));
    const drop = log.append(event(10, { verb: 'drop', targets: [target('item', box)] }));
    log.world.items.move(box, { kind: 'character', id: anna }, 0, take);
    expect(check(log)).toEqual([]);
    log.world.items.move(box, { kind: 'location', id: cellar }, 10, drop);
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'ITEM_PLACEMENT_CONFLICT', eventIds: [take], minute: 10 }),
    ]);
  });

  test('checks only the part of a possession the registry covers', () => {
    const before = blank();
    before.append(event(-100, { facts: [holds(anna, knife, -100, -70)] }));
    expect(check(before)).toEqual([]);
    before.append(event(-100, { facts: [holds(anna, knife, -100, -50)] }));
    expect(check(before)).toEqual([
      expect.objectContaining({ code: 'ITEM_PLACEMENT_CONFLICT', eventIds: ['ev_2'], minute: -60 }),
    ]);
  });

  test('reports possession of an item the registry does not know', () => {
    const log = blank();
    log.append(event(0, { facts: [holds(anna, 'it_ghost', 0, 5), holds(anna, 'it_ghost', 5, 9)] }));
    expect(check(log)).toEqual([
      expect.objectContaining({
        code: 'ITEM_UNKNOWN',
        eventIds: ['ev_1'],
        subject: { kind: 'item', id: 'it_ghost' },
      }),
    ]);
  });
});

describe('invariant 5: the dead do not act', () => {
  test('reports actions from the minute of death on', () => {
    const later = story();
    const id = later.append(event(40, { verb: 'talk', actorIds: [ivan] }));
    expect(check(later)).toEqual([
      expect.objectContaining({
        invariant: 5,
        code: 'ACTION_AFTER_DEATH',
        eventIds: [id, 'ev_9'],
        subject: { kind: 'character', id: ivan },
        minute: 40,
      }),
    ]);

    const same = story();
    same.append(event(36, { verb: 'scream', actorIds: [ivan] }));
    expect(codes(check(same))).toEqual(['ACTION_AFTER_DEATH']);
  });

  test('reports an action that continues past the death', () => {
    const log = story();
    log.append(event(30, { verb: 'read', duration: 6, actorIds: [ivan] }));
    expect(check(log)).toEqual([]);
    const id = log.append(event(30, { verb: 'read', duration: 7, actorIds: [ivan] }));
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'ACTION_SPANS_DEATH', eventIds: [id, 'ev_9'], minute: 36 }),
    ]);
  });

  test('reports did facts after death', () => {
    const log = story();
    const id = log.append(
      event(45, {
        actorIds: [boris],
        facts: [{ kind: 'did', who: ivan, verb: 'write', at: 50, where: hall }],
      }),
    );
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'ACTION_AFTER_DEATH', eventIds: [id, 'ev_9'], minute: 50 }),
    ]);
  });

  test('does not treat targets, presence or other states as actions or deaths', () => {
    const log = story();
    log.append(
      event(45, { verb: 'stage', actorIds: [anna], targets: [target('character', ivan)] }),
    );
    expect(check(log)).toEqual([]);

    const unconscious = blank();
    const state: Fact = {
      kind: 'state',
      entity: target('character', boris),
      property: 'conscious',
      value: false,
      interval: { from: 0, to: 10 },
    };
    unconscious.append(event(0, { facts: [state, { ...state, property: 'alive', value: true }] }));
    unconscious.append(event(5, { actorIds: [boris] }));
    expect(check(unconscious)).toEqual([]);
  });

  test('lets the dying character act in the event that records the death', () => {
    const log = blank();
    log.append(event(5, { verb: 'collapse', actorIds: [boris], facts: [dies(boris, 5)] }));
    log.append(event(7, { facts: [dies(boris, 7)] }));
    expect(check(log)).toEqual([]);
    log.append(event(6, { actorIds: [boris] }));
    expect(check(log)).toEqual([expect.objectContaining({ eventIds: ['ev_3', 'ev_1'] })]);
  });

  test('does not excuse actions in an event with a later death fact or a backdated death', () => {
    const repeated = blank();
    repeated.append(event(5, { verb: 'collapse', actorIds: [boris], facts: [dies(boris, 5)] }));
    const id = repeated.append(event(7, { actorIds: [boris], facts: [dies(boris, 7)] }));
    expect(check(repeated)).toEqual([
      expect.objectContaining({ code: 'ACTION_AFTER_DEATH', eventIds: [id, 'ev_1'], minute: 7 }),
    ]);

    // The body is found at minute 10; the death itself happened at minute 5.
    const backdated = blank();
    const found = backdated.append(event(10, { actorIds: [boris], facts: [dies(boris, 5)] }));
    expect(check(backdated)).toEqual([
      expect.objectContaining({ code: 'ACTION_AFTER_DEATH', eventIds: [found, found], minute: 10 }),
    ]);
  });
});

describe('invariant 7: key events and culprits', () => {
  test('accepts key events where one of several culprits acts', () => {
    expect(check(story({ incident: { culpritIds: [boris, anna] } }))).toEqual([]);
  });

  test('reports missing key events and key events without a culprit', () => {
    const log = story({ incident: { keyEventIds: ['ev_99', 'ev_7', 'ev_9'] } });
    expect(check(log)).toEqual([
      expect.objectContaining({ invariant: 7, code: 'KEY_EVENT_UNKNOWN', eventIds: ['ev_99'] }),
      expect.objectContaining({
        invariant: 7,
        code: 'KEY_EVENT_WITHOUT_CULPRIT',
        eventIds: ['ev_7'],
        minute: 15,
      }),
    ]);
  });
});

describe('debug checks', () => {
  test('pass while a consistent log is written in order', () => {
    // Key events are appended after the incident, and the registry mirrors each take afterwards.
    expect(check(story({ debug: true }))).toEqual([]);
  });

  test('throw after the append that breaks an invariant and keep the event', () => {
    const log = story({ debug: true });
    let error: unknown;
    try {
      log.append(event(40, { actorIds: [ivan] }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TruthInvariantError);
    expect(error).toMatchObject({
      code: 'TRUTH_INVARIANT_VIOLATION',
      eventId: 'ev_13',
      violations: [
        expect.objectContaining({ code: 'ACTION_AFTER_DEATH', eventIds: ['ev_13', 'ev_9'] }),
      ],
    });
    expect(log.truth.events()).toHaveLength(13);
  });

  test('do nothing when disabled', () => {
    const log = story({ debug: false });
    expect(log.append(event(40, { actorIds: [ivan] }))).toBe('ev_13');
    expect(codes(check(log))).toEqual(['ACTION_AFTER_DEATH']);
  });

  test('defer only what the next append can still resolve', () => {
    const w = world();
    const truth = new TruthModel(incident({ keyEventIds: ['ev_2'] }));
    const writer = withInvariantChecks(truth, w, { enabled: true });
    writer.append(event(0, { causes: ['ev_2'] }));
    expect(() => assertInvariants(truth, w)).toThrow(TruthInvariantError);

    const take = writer.append(event(0, { actorIds: [anna], facts: [holds(anna, knife, 0, 10)] }));
    expect(() => assertInvariants(truth, w, { incremental: true })).not.toThrow();
    // The registry was not updated before the next append.
    expect(() => writer.append(event(1))).toThrow(
      expect.objectContaining({
        eventId: 'ev_3',
        violations: [expect.objectContaining({ code: 'ITEM_PLACEMENT_CONFLICT' })],
      }),
    );
    w.items.move(knife, { kind: 'character', id: anna }, 1, take);
    expect(() => assertInvariants(truth, w)).toThrow(/ITEM_PLACEMENT_CONFLICT/);
  });

  test('assertInvariants passes on a consistent log', () => {
    const log = story();
    expect(() => assertInvariants(log.truth, log.world)).not.toThrow();
  });
});

describe('audit regressions: explicit move events', () => {
  test('a transition shorter than the route is reported once', () => {
    const log = blank();
    log.append(stay(anna, hall, 0, 10));
    const id = log.append(move(anna, hall, cellar, 10, 1));
    log.append(stay(anna, cellar, 11, 20));
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'TRAVEL_TOO_FAST', eventIds: [id], minute: 10 }),
    ]);
  });

  test('a transition against a one-way connection has no route', () => {
    const log = blank();
    const id = log.append(move(anna, cellar, hall, 0, 30));
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'TRAVEL_NO_ROUTE', eventIds: [id] }),
    ]);
  });

  test('a transition to an unknown location is reported', () => {
    const log = blank();
    const id = log.append(move(anna, hall, 'loc_moon', 0, 30));
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'TRAVEL_UNKNOWN_LOCATION', eventIds: [id] }),
    ]);
  });

  test('a transition that overlaps a stay elsewhere is reported', () => {
    const log = blank();
    const there = log.append(stay(anna, garden, 1, 5));
    const id = log.append(move(anna, hall, cellar, 0, 3));
    expect(check(log)).toEqual([
      expect.objectContaining({
        invariant: 1,
        code: 'TRANSIT_OVERLAP',
        eventIds: [there, id],
        minute: 1,
      }),
    ]);
  });

  test('a transition must start where the previous stay ended', () => {
    const log = blank();
    const there = log.append(stay(anna, garden, 0, 5));
    const id = log.append(move(anna, hall, cellar, 6, 3));
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'TRAVEL_NO_ROUTE', eventIds: [id, there], minute: 6 }),
    ]);
  });

  test('accepts a transition that takes the route time and a SIM-001 style itinerary', () => {
    const single = blank();
    single.append(move(anna, hall, cellar, 0, 3));
    expect(check(single)).toEqual([]);

    const log = blank();
    log.append(stay(anna, hall, -20, 10));
    log.append(move(anna, hall, office, 10, 5));
    log.append(move(anna, office, hall, 15, 5));
    log.append(stay(anna, hall, 20, 30));
    log.append(move(anna, hall, cellar, 30, 3));
    log.append(stay(anna, cellar, 33, 40));
    expect(check(log)).toEqual([]);
  });
});

describe('audit regressions: keys at the time of the transition', () => {
  function locked(keyFrom: number | undefined, format: 'move' | 'stays' = 'move') {
    const log = blank();
    log.append(stay(anna, office, 0, 10));
    if (format === 'move') log.append(move(anna, office, vault, 10, 2));
    log.append(stay(anna, vault, 12, 20));
    if (keyFrom !== undefined) {
      const take = log.append(
        event(keyFrom, { verb: 'take', facts: [holds(anna, key, keyFrom, 30)] }),
      );
      log.world.items.move(key, { kind: 'character', id: anna }, keyFrom, take);
    }
    return log;
  }

  test('a key held before departure opens the door', () => {
    expect(check(locked(-5))).toEqual([]);
    expect(check(locked(-5, 'stays'))).toEqual([]);
  });

  test('a key obtained only after arrival does not open the door', () => {
    expect(codes(check(locked(12)))).toEqual(['TRAVEL_NO_ROUTE']);
    expect(codes(check(locked(12, 'stays')))).toEqual(['TRAVEL_NO_ROUTE']);
  });

  test('a key obtained between two transitions opens the second door', () => {
    const log = blank();
    log.append(stay(anna, vault, -10, 0));
    log.append(move(anna, vault, office, 0, 2));
    const take = log.append(
      event(2, { verb: 'take', location: office, facts: [holds(anna, key, 2, 30)] }),
    );
    log.world.items.move(key, { kind: 'character', id: anna }, 2, take);
    log.append(move(anna, office, vault, 2, 2));
    log.append(stay(anna, vault, 4, 10));
    expect(check(log)).toEqual([]);

    const without = blank();
    without.append(stay(anna, vault, -10, 0));
    without.append(move(anna, vault, office, 0, 2));
    const id = without.append(move(anna, office, vault, 2, 2));
    without.append(stay(anna, vault, 4, 10));
    expect(check(without)).toEqual([
      expect.objectContaining({ code: 'TRAVEL_NO_ROUTE', eventIds: [id] }),
    ]);
  });

  test('a key handed over before departure no longer opens the door for its former holder', () => {
    const log = blank();
    const take = log.append(event(-5, { verb: 'take', facts: [holds(anna, key, -5, 5)] }));
    const give = log.append(event(5, { verb: 'give', facts: [holds(boris, key, 5, 30)] }));
    log.world.items.move(key, { kind: 'character', id: anna }, -5, take);
    log.world.items.move(key, { kind: 'character', id: boris }, 5, give);
    log.append(stay(anna, office, 0, 10));
    log.append(move(anna, office, vault, 10, 2));
    expect(codes(check(log))).toEqual(['TRAVEL_NO_ROUTE']);
  });

  test('later registry history does not open a door retroactively', () => {
    const log = blank();
    log.append(stay(anna, office, 0, 10));
    log.append(move(anna, office, vault, 10, 2));
    const take = log.append(event(15, { verb: 'take', targets: [target('item', key)] }));
    log.world.items.move(key, { kind: 'character', id: anna }, 15, take);
    expect(codes(check(log))).toEqual(['TRAVEL_NO_ROUTE']);
  });
});

describe('audit regressions: actions inside the death event', () => {
  test('a did fact after the death recorded in the same event is reported', () => {
    const log = blank();
    const id = log.append(
      event(5, {
        verb: 'collapse',
        actorIds: [boris],
        facts: [
          dies(boris, 7),
          { kind: 'did', who: boris, verb: 'call', at: 8, where: hall },
          { kind: 'did', who: boris, verb: 'gasp', at: 6, where: hall },
        ],
      }),
    );
    expect(check(log)).toEqual([
      expect.objectContaining({ code: 'ACTION_AFTER_DEATH', eventIds: [id, id], minute: 8 }),
    ]);
  });
});

describe('audit regressions: location of did facts', () => {
  test('reports a did fact away from where the character is, even if not an actor', () => {
    const log = blank();
    const here = log.append(stay(anna, hall, 0, 3));
    const id = log.append(
      event(1, {
        actorIds: [boris],
        location: office,
        facts: [{ kind: 'did', who: anna, verb: 'take', at: 1, where: office }],
      }),
    );
    expect(check(log)).toEqual([
      expect.objectContaining({
        code: 'ACTOR_ELSEWHERE',
        eventIds: [id, here],
        subject: target('character', anna),
        minute: 1,
      }),
    ]);
  });

  test('accepts a did fact where the character is and reports an actor only once', () => {
    const log = blank();
    log.append(stay(anna, hall, 0, 3));
    const fact = (where: string, t: number): Fact => ({
      kind: 'did',
      who: anna,
      verb: 'take',
      at: t,
      where,
    });
    log.append(event(1, { actorIds: [boris], facts: [fact(hall, 1)] }));
    expect(check(log)).toEqual([]);
    log.append(event(2, { actorIds: [anna], location: office, facts: [fact(office, 2)] }));
    expect(codes(check(log))).toEqual(['ACTOR_ELSEWHERE']);
  });
});

describe('audit regressions: causes of container moves', () => {
  test('checks every container an item can be in, once each', () => {
    const log = blank();
    const look = log.append(
      event(10, { verb: 'look', targets: [target('item', ring), target('item', box)] }),
    );
    log.world.items.move(chest, { kind: 'location', id: hall }, 3, look);
    log.world.items.move(box, { kind: 'location', id: cellar }, 12, 'ev_404');
    expect(check(log)).toEqual([
      expect.objectContaining({
        code: 'ITEM_MOVE_UNKNOWN_CAUSE',
        subject: target('item', box),
        minute: 12,
      }),
      expect.objectContaining({
        code: 'ITEM_MOVE_BEFORE_CAUSE',
        eventIds: [look],
        subject: target('item', chest),
        minute: 3,
      }),
    ]);
  });

  test('accepts container moves that follow their causes', () => {
    const log = blank();
    const look = log.append(event(10, { verb: 'look', targets: [target('item', ring)] }));
    log.world.items.move(chest, { kind: 'location', id: hall }, 10, look);
    log.world.items.move(box, { kind: 'container', id: chest }, 11, look);
    expect(check(log)).toEqual([]);
  });
});

describe('audit regressions: debug checks with registry mirroring', () => {
  test('takes, hand-overs and moves mirrored right after each append pass', () => {
    const w = world();
    const truth = new TruthModel(incident({ keyEventIds: [] }));
    const writer = withInvariantChecks(truth, w, { enabled: true });
    writer.append(stay(anna, office, 0, 10));
    const take = writer.append(
      event(5, {
        verb: 'take',
        actorIds: [anna],
        location: office,
        facts: [holds(anna, knife, 5, 20)],
      }),
    );
    w.items.move(knife, { kind: 'character', id: anna }, 5, take);
    const give = writer.append(
      event(8, {
        verb: 'give',
        actorIds: [anna],
        location: office,
        facts: [holds(boris, knife, 20, 30)],
      }),
    );
    w.items.move(knife, { kind: 'character', id: boris }, 20, give);
    writer.append(move(anna, office, hall, 10, 5));
    expect(() => assertInvariants(truth, w)).not.toThrow();
  });
});
