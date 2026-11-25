import { describe, expect, it } from 'vitest';
import type { Character, RoutineBlock, ScheduleOverride } from '../characters/index.ts';
import { stateHash } from '../common/index.ts';
import type { ScenarioContent } from '../content/index.ts';
import { createRng, restoreRng, type Rng } from '../rng/index.ts';
import { Calendar, TickPhase, TimeSystem } from '../time/index.ts';
import { checkTruthInvariants, TruthModel } from '../truth/index.ts';
import { ItemRegistry, LocationGraph } from '../world/index.ts';
import { SimulationRunner } from '@hs/core/simulation';

const startDateTime = '2026-01-14T00:00:00';
const bed = 'loc_bed';
const corridor = 'loc_corridor';
const office = 'loc_office';
const outside = 'loc_outside';
const key = 'it_key';

type Location = ScenarioContent['locations'][number];

function location(
  id: string,
  connections: Location['connections'] = [],
  access: Location['access'] = [],
): Location {
  return {
    id,
    name: id,
    description: id,
    tags: [],
    lighting: { morning: 'dim', day: 'bright', evening: 'dim', night: 'dark' },
    access,
    connections,
    hotspots: [],
  };
}

const locations = [
  location(bed, [{ to: corridor, minutes: 2 }]),
  location(corridor, [
    { to: office, minutes: 3 },
    { to: bed, minutes: 2 },
  ]),
  location(office, [{ to: corridor, minutes: 3 }]),
  location(outside),
];

function block(from: number, to: number, location: string, activity = 'idle'): RoutineBlock {
  return { from, to, location, activity, flexibility: 0 };
}

function character(id: string, routine: RoutineBlock[], access: Character['access'] = []) {
  return { id, routine, access, archetypeId: 'staff' };
}

type AgentCharacter = ReturnType<typeof character>;
const alpha = character('ch_alpha', [block(0, 10, bed, 'sleep'), block(10, 1440, office, 'work')]);
const beta = character('ch_beta', alpha.routine);
const lockedLocations = [
  location(bed, [{ to: office, minutes: 3, locked: { itemId: key } }]),
  location(office, [{ to: bed, minutes: 3 }]),
];

function setup(
  characters: AgentCharacter[] = [alpha],
  setupOptions: {
    start?: number;
    calendarStart?: string;
    endAt?: number;
    worldLocations?: Location[];
    worldItems?: ScenarioContent['items'];
    ownerByArchetype?: ReadonlyMap<string, string>;
    itemChangeMinutes?: readonly number[];
    overrides?: ScheduleOverride[];
    initialLocations?: ReadonlyMap<string, string>;
    exits?: ReadonlyMap<string, number>;
    rng?: Rng;
  } = {},
) {
  const {
    start = 0,
    calendarStart = startDateTime,
    endAt = 1440,
    worldLocations = locations,
    worldItems = [],
    ownerByArchetype,
    rng = createRng('routine-test'),
    ...options
  } = setupOptions;
  const calendar = new Calendar(calendarStart);
  const time = new TimeSystem(calendar, endAt, start);
  const preset: ScenarioContent['preset'] = {
    id: 'simulation_test',
    version: 1,
    title: { ru: 'Рутины NPC' },
    time: { startDateTime: calendarStart, durationMinutes: endAt, historyStartMinutes: start },
    cast: { min: 2, max: 2, quotas: [] },
    incident: {
      types: ['theft'],
      templates: ['missing_record'],
      minMotive: 0.4,
      victimConstraints: { excludeArchetypes: [] },
    },
    criticalEvents: [],
    deadlines: [],
    endings: ['solved'],
    survival: { startVitals: { health: 10, sanity: 8, fatigue: 0 }, staticCurve: 'default' },
    phone: { minQrShare: 0 },
  };
  const world = new LocationGraph({ preset, locations: worldLocations });
  const items = new ItemRegistry(
    { locations: worldLocations, items: worldItems },
    ownerByArchetype,
    start,
  );
  const truth = new TruthModel({
    type: 'theft',
    victimIds: [beta.id],
    culpritIds: [alpha.id],
    motive: 'f_0000000000000000',
    means: 'it_record',
    keyEventIds: [],
    window: { from: -10, to: -1 },
  });
  const runner = new SimulationRunner({
    time,
    calendar,
    world,
    items,
    truth,
    rng,
    characters,
    endAt,
    ...options,
  });
  return { runner, time, truth, world, items };
}

it('records public routine observations after all positions for the minute are available', () => {
  const absent = character('ch_absent', [block(0, 1440, outside)]);
  const { runner, time, truth } = setup([alpha, absent, beta]);
  time.advance(1);
  for (const event of truth.events()) {
    const present = truth.whoWasAt(event.location, { from: event.t, to: event.t + 1 });
    for (const observer of [alpha, beta, absent]) {
      expect(
        runner.knowledgeOf(observer.id)?.query({
          kind: 'did',
          who: event.actorIds[0]!,
          verb: event.verb,
          at: event.t,
        }),
      ).toHaveLength(present.includes(observer.id) ? 1 : 0);
    }
  }
});

function moveItem(
  state: Pick<ReturnType<typeof setup>, 'items' | 'truth'>,
  id: string,
  recipient: string,
  minute: number,
  giver?: string,
): void {
  const cause = state.truth.append({
    t: minute,
    duration: 0,
    verb: giver ? 'give' : 'take',
    actorIds: [giver ?? recipient],
    location: bed,
    targets: [{ kind: 'item', id }],
    causes: [],
    facts: [],
    traceIds: [],
    visibility: 'public',
  });
  state.items.move(id, { kind: 'character', id: recipient }, minute, cause);
}

describe('SimulationRunner', () => {
  it('follows the active routine over real graph edges and indexes only stationary presence', () => {
    const { runner, time, truth } = setup();
    expect(time.now()).toBe(0);
    expect(truth.events()).toEqual([]);
    expect(runner.getAgent(alpha.id)?.activity).toBeUndefined();

    time.advance(9);
    expect(runner.getAgent(alpha.id)?.activity).toEqual({
      block: alpha.routine[0],
      step: { kind: 'stay', location: bed, from: 0, to: 10 },
    });
    expect(truth.whereWas(alpha.id, 9)).toBe(bed);

    time.advance(1);
    expect(truth.whereWas(alpha.id, 10)).toBe('in_transit');
    expect(runner.getAgent(alpha.id)?.activity?.step).toEqual({
      kind: 'move',
      origin: bed,
      destination: corridor,
      from: 10,
      to: 12,
    });
    time.advance(4);
    expect(truth.whereWas(alpha.id, 12)).toBe('in_transit');
    expect(truth.whereWas(alpha.id, 14)).toBe('in_transit');
    time.advance(1);
    expect(truth.whereWas(alpha.id, 15)).toBe(office);
    expect(truth.presenceIntervals(alpha.id)).toEqual([
      { location: bed, interval: { from: 0, to: 10 } },
      { location: office, interval: { from: 15, to: 1440 } },
    ]);
    expect(truth.whoWasAt(corridor, { from: 10, to: 15 })).toEqual([]);

    expect(
      truth.events().map(({ t, verb, location, duration }) => [t, verb, location, duration]),
    ).toEqual([
      [0, 'stay', bed, 10],
      [10, 'move', bed, 2],
      [12, 'move', corridor, 3],
      [15, 'stay', office, 1425],
    ]);
    const target = { kind: 'location', id: corridor };
    expect(truth.events()[1]).toMatchObject({
      targets: [target],
      facts: [{ kind: 'did', who: alpha.id, verb: 'move', target, at: 10, where: bed }],
    });
    expect(truth.facts({ kind: 'at' })).toEqual([
      { kind: 'at', who: alpha.id, where: bed, interval: { from: 0, to: 10 } },
      { kind: 'at', who: alpha.id, where: office, interval: { from: 15, to: 1440 } },
    ]);
  });

  it('runs schedules before simulation and commits simultaneous steps by character ID', () => {
    const { time, truth } = setup([beta, alpha]);
    const seen: string[][] = [];
    for (const [kind, phase] of [
      ['schedule_probe', TickPhase.Schedules],
      ['simulation_probe', TickPhase.Simulation],
    ] as const) {
      time.registerHandler(kind, {
        phase,
        handle: () => {
          seen.push(
            truth
              .events()
              .filter((event) => event.t === 10)
              .flatMap((event) => event.actorIds),
          );
        },
      });
      time.schedule({ at: 10, kind, priority: 100, payload: null });
    }

    time.advance(15);
    expect(seen).toEqual([[], [alpha.id, beta.id]]);
    for (const minute of [0, 10, 12, 15]) {
      expect(
        truth
          .events()
          .filter((event) => event.t === minute)
          .map((event) => event.actorIds),
      ).toEqual([[alpha.id], [beta.id]]);
    }
  });

  it('ignores midnight inside a night block and uses the calendar offset in prehistory', () => {
    const night = character(alpha.id, [
      block(23 * 60, 10, bed, 'sleep'),
      block(10, 23 * 60, office, 'work'),
    ]);
    const { time, truth } = setup([night], { start: -30, calendarStart: '2026-01-14T00:05:00' });
    expect(time.advance(40)).toMatchObject({ from: -30, to: 10 });
    expect(truth.events()[0]).toMatchObject({ t: -30, duration: 35, verb: 'stay' });
    expect(truth.whereWas(alpha.id, -6)).toBe(bed);
    expect(truth.whereWas(alpha.id, -5)).toBe(bed);
    expect(truth.whereWas(alpha.id, 0)).toBe(bed);
    expect(truth.whereWas(alpha.id, 5)).toBe('in_transit');
    expect(truth.whereWas(alpha.id, 10)).toBe(office);
  });

  it('applies the latest active override and finishes the edge already in progress', () => {
    const routine = character(alpha.id, [block(0, 1440, bed)]);
    const overrides: ScheduleOverride[] = [
      { characterId: alpha.id, interval: { from: 5, to: 15 }, block: block(0, 1440, office) },
      { characterId: alpha.id, interval: { from: 7, to: 12 }, block: block(0, 1440, bed) },
    ];
    const { time, truth } = setup([routine], { overrides });
    time.advance(20);
    const moves = truth.events().filter((event) => event.verb === 'move');
    expect(
      moves.map(({ t, duration, location, targets }) => [t, duration, location, targets[0]?.id]),
    ).toEqual([
      [5, 2, bed, corridor],
      [7, 2, corridor, bed],
      [12, 2, bed, corridor],
      [14, 3, corridor, office],
      [17, 3, office, corridor],
      [20, 2, corridor, bed],
    ]);
    expect(truth.whereWas(alpha.id, 16)).toBe('in_transit');
    expect(truth.whereWas(alpha.id, 17)).toBe('in_transit');
  });

  it('checks access on arrival, leaving NPCs in place for denied, locked and unreachable steps', () => {
    const staffWithGrant = character(alpha.id, alpha.routine, [{ itemId: key }]);
    const { time, truth } = setup([staffWithGrant, beta], {
      worldItems: [{ id: key, name: 'Key', kind: 'key', tags: [], ownerArchetype: 'staff' }],
      ownerByArchetype: new Map([['staff', beta.id]]),
      worldLocations: [
        location(bed, [{ to: corridor, minutes: 2, locked: { itemId: key } }]),
        location(
          corridor,
          [{ to: office, minutes: 3 }],
          [{ from: 12, to: 13, archetypes: ['staff'], itemId: key }],
        ),
        location(office, [], [{ from: 0, to: 15 }]),
        location(outside),
      ],
      overrides: [
        { characterId: alpha.id, interval: { from: 20, to: 30 }, block: block(0, 1440, outside) },
      ],
    });

    time.advance(30);
    expect(truth.events().filter((event) => event.verb === 'move')).toMatchObject([
      {
        actorIds: [beta.id],
        t: 10,
        duration: 2,
        location: bed,
        targets: [
          { kind: 'location', id: corridor },
          { kind: 'item', id: key },
        ],
      },
    ]);
    expect(truth.whereWas(beta.id, 12)).toBe(corridor);
    expect(truth.whereWas(beta.id, 29)).toBe(corridor);
    expect(truth.whereWas(alpha.id, 29)).toBe(bed);
    expect(truth.whoWasAt(office, { from: 0, to: 30 })).toEqual([]);
  });

  it('uses the new key holder when a handover is applied in the departure minute', () => {
    function replay(characters: AgentCharacter[], advances: number[]) {
      const state = setup(characters, {
        worldItems: [{ id: key, name: 'Key', kind: 'key', tags: [], ownerArchetype: 'staff' }],
        ownerByArchetype: new Map([['staff', alpha.id]]),
        worldLocations: lockedLocations,
      });
      state.time.registerHandler('handover', {
        phase: TickPhase.Schedules,
        handle: () => moveItem(state, key, beta.id, 10, alpha.id),
      });
      state.time.schedule({ at: 10, kind: 'handover', priority: -1, payload: null });

      for (const minutes of advances) state.time.advance(minutes);
      expect(state.truth.events().filter(({ verb }) => verb === 'move')).toMatchObject([
        { t: 10, duration: 3, actorIds: [beta.id] },
      ]);
      expect(state.truth.whereWas(alpha.id, 13)).toBe(bed);
      expect(state.truth.whereWas(beta.id, 13)).toBe(office);
      return { journal: state.truth.serialize(), hash: stateHash(state.truth.events()) };
    }

    expect(replay([beta, alpha], [13])).toEqual(replay([alpha, beta], [10, 3]));
  });

  it('uses a preregistered acquisition only from its minute, including a key carried in a bag', () => {
    const bag = 'it_bag';
    const state = setup([alpha], {
      worldLocations: lockedLocations,
      worldItems: [
        { id: key, name: 'Key', kind: 'key', tags: [], containerId: bag },
        { id: bag, name: 'Bag', kind: 'container', tags: [], locationId: bed },
      ],
    });
    // The key is acquired at the original route's hypothetical arrival minute.
    moveItem(state, bag, alpha.id, 13);
    state.time.advance(12);
    expect(state.truth.events().filter(({ verb }) => verb === 'move')).toEqual([]);
    expect(state.truth.whereWas(alpha.id, 12)).toBe(bed);
    state.time.advance(4);
    expect(state.truth.events().filter(({ verb }) => verb === 'move')).toMatchObject([
      {
        t: 13,
        duration: 3,
        targets: [
          { kind: 'location', id: office },
          { kind: 'item', id: key },
        ],
      },
    ]);
    expect(state.truth.whereWas(alpha.id, 16)).toBe(office);
  });

  it('replans a blocked route at a declared minute for a live acquisition', () => {
    const state = setup([alpha], {
      worldLocations: lockedLocations,
      worldItems: [{ id: key, name: 'Key', kind: 'key', tags: [], locationId: bed }],
      itemChangeMinutes: [13],
    });
    state.time.registerHandler('acquire', {
      phase: TickPhase.Schedules,
      handle: () => moveItem(state, key, alpha.id, 13),
    });
    state.time.schedule({ at: 13, kind: 'acquire', priority: -1, payload: null });

    state.time.advance(16);
    expect(state.truth.events().filter(({ verb }) => verb === 'move')).toMatchObject([
      { t: 13, duration: 3 },
    ]);
    expect(
      state.truth.presenceIntervals(alpha.id).map(({ location, interval }) => [location, interval]),
    ).toEqual([
      [bed, { from: 0, to: 10 }],
      [bed, { from: 10, to: 13 }],
      [office, { from: 16, to: 1440 }],
    ]);
  });

  it('chooses an open detour when a physical key is unavailable', () => {
    const staffWithGrant = character(alpha.id, alpha.routine, [{ itemId: key }]);
    const { time, truth } = setup([staffWithGrant], {
      worldLocations: [
        location(bed, [
          { to: office, minutes: 3, locked: { itemId: key } },
          { to: corridor, minutes: 2 },
        ]),
        location(corridor, [{ to: office, minutes: 3 }]),
        location(office),
      ],
      worldItems: [{ id: key, name: 'Key', kind: 'key', tags: [], locationId: bed }],
    });
    time.advance(15);
    expect(truth.events().filter(({ verb }) => verb === 'move')).toMatchObject([
      { t: 10, duration: 2, targets: [{ kind: 'location', id: corridor }] },
      { t: 12, duration: 3, targets: [{ kind: 'location', id: office }] },
    ]);
  });

  it('takes an open detour if the shorter route would arrive too late', () => {
    const { time, truth } = setup([alpha], {
      worldLocations: [
        location(bed, [
          { to: corridor, minutes: 2 },
          { to: outside, minutes: 4 },
        ]),
        location(corridor, [{ to: office, minutes: 3 }], [{ from: 0, to: 12 }]),
        location(outside, [{ to: office, minutes: 4 }]),
        location(office),
      ],
    });
    time.advance(18);
    expect(
      truth
        .events()
        .filter(({ verb }) => verb === 'move')
        .map(({ t, duration, targets }) => [t, duration, targets[0]?.id]),
    ).toEqual([
      [10, 4, outside],
      [14, 4, office],
    ]);
    expect(truth.whereWas(alpha.id, 18)).toBe(office);
  });

  it('waits at its current location and departs in time for the next opening', () => {
    const { time, truth } = setup([alpha], {
      worldLocations: [
        location(bed, [{ to: office, minutes: 3 }]),
        location(office, [], [{ from: 20, to: 5 }]),
      ],
    });
    time.advance(20);
    expect(truth.events().map(({ t, verb, duration }) => [t, verb, duration])).toEqual([
      [0, 'stay', 10],
      [10, 'stay', 7],
      [17, 'move', 3],
      [20, 'stay', 1420],
    ]);
    expect(truth.whereWas(alpha.id, 16)).toBe(bed);
    expect(truth.whereWas(alpha.id, 17)).toBe('in_transit');
    expect(truth.whereWas(alpha.id, 20)).toBe(office);
  });

  it('allows an explicit physical starting location and stops at the exclusive horizon', () => {
    const routine = character(alpha.id, [block(0, 1440, office)]);
    const { runner, time, truth } = setup([routine], {
      endAt: 3,
      initialLocations: new Map([[alpha.id, bed]]),
    });
    expect(time.advance(10)).toMatchObject({ to: 3, limit: 'TIME_BEYOND_SCENARIO_END' });
    expect(
      truth.events().map(({ t, verb, location, duration }) => [t, verb, location, duration]),
    ).toEqual([
      [0, 'move', bed, 2],
      [2, 'stay', corridor, 1],
    ]);
    expect(runner.getAgent(alpha.id)?.activity).toBeUndefined();
  });

  it('ends the actions and observations of a character at its exit minute', () => {
    const { runner, time, truth } = setup([alpha, beta], { exits: new Map([[alpha.id, 11]]) });
    time.advance(20);
    const steps = (id: string) =>
      truth
        .events()
        .filter(({ actorIds }) => actorIds.includes(id))
        .map(({ t, verb, location, duration }) => [t, verb, location, duration]);
    // The transition at minute 10 would arrive after the exit, so alpha waits in place.
    expect(steps(alpha.id)).toEqual([
      [0, 'stay', bed, 10],
      [10, 'stay', bed, 1],
    ]);
    expect(steps(beta.id).slice(0, 3)).toEqual([
      [0, 'stay', bed, 10],
      [10, 'move', bed, 2],
      [12, 'move', corridor, 3],
    ]);
    expect(runner.getAgent(alpha.id)?.activity).toBeUndefined();

    // The caller keeps the body in place; it is present but no longer observes.
    truth.append({
      t: 11,
      duration: 0,
      verb: 'die',
      actorIds: [alpha.id],
      location: bed,
      targets: [],
      causes: [],
      facts: [{ kind: 'at', who: alpha.id, where: bed, interval: { from: 11, to: 1440 } }],
      traceIds: [],
      visibility: 'public',
    });
    const event = {
      t: 16,
      verb: 'knock',
      actorIds: [beta.id],
      location: bed,
      visibility: 'public' as const,
    };
    const id = truth.append({
      ...event,
      duration: 0,
      targets: [],
      causes: [],
      facts: [],
      traceIds: [],
    });
    runner.observe({ ...event, id });
    expect(runner.knowledgeOf(alpha.id)?.query({ kind: 'did', who: beta.id, at: 16 })).toEqual([]);
    expect(() => setup([alpha], { exits: new Map([['ch_missing', 3]]) })).toThrow(/unknown/);
    expect(() => setup([alpha], { exits: new Map([[alpha.id, 1.5]]) })).toThrow(/Invalid exit/);
  });

  it('does not run later steps when TimeSystem is interrupted', () => {
    const { time, truth } = setup();
    time.registerHandler('pause', {
      phase: TickPhase.WorldEvents,
      handle: () => ({ interrupt: 'pause' }),
    });
    time.schedule({ at: 11, kind: 'pause', priority: 0, payload: null });
    expect(time.advance(20, { interruptible: true })).toMatchObject({ to: 11, interruptedAt: 11 });
    expect(truth.events().map(({ t }) => t)).toEqual([0, 10]);
    expect(truth.whereWas(alpha.id, 11)).toBe('in_transit');
    expect(time.advance(1)).toMatchObject({ from: 11, to: 12 });
    expect(truth.events().map(({ t }) => t)).toEqual([0, 10, 12]);
  });

  it('validates agent identity, routine coverage and locations at startup', () => {
    expect(() => setup([alpha, alpha])).toThrow(/Duplicate character/);
    expect(() => setup([character(alpha.id, [block(1, 1440, bed)])])).toThrow(/CHAR_SCHEDULE_GAP/);
    expect(() => setup([character(alpha.id, [block(0, 1440, 'loc_missing')])])).toThrow(
      /Unknown location/,
    );
    expect(() =>
      setup([alpha], {
        overrides: [
          { characterId: alpha.id, interval: { from: 5, to: 5 }, block: alpha.routine[0]! },
        ],
      }),
    ).toThrow(/Invalid schedule override/);
  });

  it('requires the actual initial position when its scheduled location is inaccessible', () => {
    const worldLocations = [location(office, [], [{ from: 20 }])];
    const staff = character(alpha.id, [block(0, 1440, office)]);
    expect(() => setup([staff], { worldLocations })).toThrow(/initial location is required/);
    const { time, truth } = setup([staff], {
      worldLocations,
      initialLocations: new Map([[alpha.id, office]]),
    });
    time.advance(0);
    expect(truth.whereWas(alpha.id, 0)).toBe(office);
  });

  it('allocates an independent RNG substream per NPC without consuming the parent stream', () => {
    const rng = createRng('stream-test');
    const parentState = rng.state;
    const { runner, time } = setup([beta, alpha], { rng });
    time.advance(20);
    const alphaState = runner.getAgent(alpha.id)!.rngState;
    const betaState = runner.getAgent(beta.id)!.rngState;
    const alphaAlone = setup([alpha], { rng }).runner;
    expect(alphaState).toEqual(alphaAlone.getAgent(alpha.id)!.rngState);
    expect(alphaState).toEqual(rng.fork('sim').fork('agent').fork(alpha.id).state);
    expect(betaState).toEqual(rng.fork('sim').fork('agent').fork(beta.id).state);
    expect(rng.state).toEqual(parentState);
    const alphaStream = restoreRng(alphaState);
    for (let i = 0; i < 20; i++) alphaStream.nextU32();
    expect(runner.getAgent(beta.id)?.rngState).toEqual(betaState);
    expect(runner.getAgent('ch_missing')).toBeUndefined();
  });

  it('TIME-003 test 10: reproduces the journal and stateHash for 24 hours of prehistory', () => {
    const simulate = (characters: AgentCharacter[], advances: number[]) => {
      const { time, truth, world, items } = setup(characters, {
        start: -1440,
        rng: createRng('same-seed'),
      });
      for (const advance of advances) time.advance(advance);
      expect(time.now()).toBe(0);
      const events = truth.events();
      for (const npc of characters) {
        const steps = events.filter((event) => event.actorIds.includes(npc.id));
        const presence = truth.presenceIntervals(npc.id);
        for (const step of steps.filter((event) => event.verb === 'move')) {
          expect(step.duration).toBe(world.travelTime(step.location, step.targets[0]!.id));
        }
        for (let minute = -1440; minute <= 0; minute++) {
          const active = steps.filter(
            (event) => event.t <= minute && minute < event.t + event.duration,
          );
          const present = presence.filter(
            ({ interval }) => interval.from <= minute && minute < interval.to,
          );
          expect(active).toHaveLength(1);
          const step = active[0]!;
          expect(present).toHaveLength(step.verb === 'move' ? 0 : 1);
          expect(truth.whereWas(npc.id, minute)).toBe(
            step.verb === 'move' ? 'in_transit' : step.location,
          );
        }
      }
      expect(checkTruthInvariants(truth, { locations: world, items })).toEqual([]);
      return { journal: truth.serialize(), hash: stateHash(events) };
    };

    expect(simulate([alpha, beta], [1440])).toEqual(simulate([beta, alpha], [10, 210, 1220]));
  });
});
