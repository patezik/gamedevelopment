import { canonicalJson } from '@hs/core/common';
import type { Clue } from '@hs/core/evidence';
import {
  deserializeInvestigation,
  snapshotInvestigation,
  type Investigation,
  type InvestigationSnapshot,
} from '@hs/core/game';
import { LocationGraph } from '@hs/core/world';
import { tinyManor } from '../../core/test/fixtures/tiny-manor.ts';
import type { ValidationContext } from '../src/check.ts';

/** First minute of tiny-manor's prehistory (the fixture's HISTORY_START). */
export const TINY_MANOR_HISTORY_START = -60;

interface TruthEventJson {
  id: string;
  t: number;
  duration: number;
  verb: string;
  actorIds: string[];
  location: string;
  targets: unknown[];
  causes: string[];
  facts: unknown[];
  traceIds: string[];
  visibility: string;
}
interface TruthJson {
  incident: { keyEventIds: string[]; window: { from: number; to: number } };
  events: TruthEventJson[];
}

/** A snapshot as plain JSON that a mutation may edit freely. */
export interface MutableSnapshot {
  readonly raw: InvestigationSnapshot;
  readonly truth: TruthJson;
  event(verb: string): TruthEventJson;
}

/** A deliberately broken investigation and the finding the validator must report for it. */
export interface Mutation {
  readonly name: string;
  readonly check: string;
  readonly code: string;
  /** What the mutation breaks, in words. */
  readonly why: string;
  /** Replaces matching fields of `cleanContext()`; everything else stays valid. */
  readonly context?: ValidationContext;
  /** True when the finding must link to the log events involved. */
  readonly linksEvents: boolean;
  make(base: Investigation): Investigation;
}

/** Edits the investigation's snapshot and restores it (references are still validated). */
function viaSnapshot(
  base: Investigation,
  edit: (snapshot: MutableSnapshot) => void,
): Investigation {
  const raw = structuredClone(snapshotInvestigation(base));
  const truth = raw.truth as unknown as TruthJson;
  edit({
    raw,
    truth,
    event(verb) {
      const found = truth.events.find((event) => event.verb === verb);
      if (!found) throw new Error(`tiny-manor has no ${verb} event`);
      return found;
    },
  });
  return deserializeInvestigation(canonicalJson(raw));
}

/** A harmless event at the given time: it breaks nothing but its own position in time. Ids must run ev_1, ev_2, ... */
const lone = (id: string, t: number, duration: number): TruthEventJson => ({
  id,
  t,
  duration,
  verb: 'wait',
  actorIds: ['ch_porter'],
  location: 'loc_hall',
  targets: [],
  causes: [],
  facts: [],
  traceIds: [],
  visibility: 'public',
});

/** Rebuilds an investigation around a changed world or cast, without re-validating the routines. */
export function withCast(
  base: Investigation,
  characters: Investigation['characters'],
  world: Investigation['world'] = base.world,
): Investigation {
  return { ...base, characters, world };
}

/** A mandatory clue for the phone tests: only its id and capture mode matter. */
export const clue = (id: string, captureMode: Clue['captureMode']): Clue => ({
  id,
  traceId: `trace_${id}`,
  sourceEventId: 'ev_1',
  supports: [],
  discovery: {
    locationId: 'loc_hall',
    action: { type: 'examineHotspot', hotspotId: 'hs_desk' },
    requires: [],
    availableFrom: 0,
  },
  captureMode,
  presentation: id,
});

/** Five mandatory clues, two of them by QR (40 %), against a minimum of 30 %. */
export const CLEAN_CLUES: readonly Clue[] = [
  clue('cl_1', 'qr'),
  clue('cl_2', 'qr'),
  clue('cl_3', 'auto'),
  clue('cl_4', 'auto'),
  clue('cl_5', 'auto'),
];

/** A context in which an unbroken case passes; `regenerate` is up to the test (repeat the case under test). */
export const cleanContext = (): ValidationContext => ({
  historyStartMinutes: TINY_MANOR_HISTORY_START,
  clues: CLEAN_CLUES,
  requiredClueIds: CLEAN_CLUES.map(({ id }) => id),
  minQrShare: 0.3,
});

const bursarRoutine = (base: Investigation) => {
  const bursar = base.characters.find(({ id }) => id === 'ch_bursar');
  if (!bursar) throw new Error('tiny-manor has no bursar');
  return bursar;
};

export const replaceBursar = (
  base: Investigation,
  routine: Investigation['characters'][number]['routine'],
) =>
  base.characters.map((character) =>
    character.id === 'ch_bursar' ? { ...character, routine } : character,
  );

export const MUTATIONS: readonly Mutation[] = [
  // ---- V-TRUTH-INV: one mutation per invariant that checkTruthInvariants covers ----
  {
    name: 'the bursar is in two places at once',
    check: 'V-TRUTH-INV',
    code: 'PRESENCE_OVERLAP',
    why: 'invariant 1: overlapping stays in different locations',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.event('take').facts.push({
          kind: 'at',
          who: 'ch_bursar',
          where: 'loc_hall',
          interval: { from: -21, to: -18 },
        });
      }),
  },
  {
    name: 'the bursar crosses the study to the archive too fast',
    check: 'V-TRUTH-INV',
    code: 'TRAVEL_TOO_FAST',
    why: 'invariant 2: the move lasts 1 minute, the route takes 4',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.event('move').duration = 1;
      }),
  },
  {
    name: 'the theft is caused by something that happens after it',
    check: 'V-TRUTH-INV',
    code: 'CAUSE_NOT_BEFORE_EFFECT',
    why: 'invariant 3: a cause must end before its effect starts',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.event('take').causes = [s.event('hide').id];
      }),
  },
  {
    name: 'the ledger is held by two people at once',
    check: 'V-TRUTH-INV',
    code: 'ITEM_HOLDER_OVERLAP',
    why: 'invariant 4: one item, two holders in the same minutes',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.event('read').facts.push({
          kind: 'possessed',
          who: 'ch_owner',
          item: 'it_ledger',
          interval: { from: -18, to: -12 },
        });
      }),
  },
  {
    name: 'the bursar acts after he is dead',
    check: 'V-TRUTH-INV',
    code: 'ACTION_AFTER_DEATH',
    why: 'invariant 5: a dead character takes part in events',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.event('write').facts.push({
          kind: 'state',
          entity: { kind: 'character', id: 'ch_bursar' },
          property: 'alive',
          value: false,
          interval: { from: -22, to: 0 },
        });
      }),
  },
  {
    name: 'the key event is one that the culprit took no part in',
    check: 'V-TRUTH-INV',
    code: 'KEY_EVENT_WITHOUT_CULPRIT',
    why: 'invariant 7: a key event needs a culprit among its actors',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.truth.incident.keyEventIds = [
          s.truth.events.find((e) => e.actorIds[0] === 'ch_cook')?.id ?? '',
        ];
      }),
  },

  // ---- V-TIMELINE ----
  {
    name: 'an event ends after the scenario does',
    check: 'V-TIMELINE',
    code: 'TIMELINE_EVENT_AFTER_END',
    why: 'the scenario lasts 1440 minutes; this event runs to 1444',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) =>
        s.truth.events.push(lone(`ev_${s.truth.events.length + 1}`, 1439, 5)),
      ),
  },
  {
    name: 'an event happens before the prehistory begins',
    check: 'V-TIMELINE',
    code: 'TIMELINE_EVENT_BEFORE_HISTORY',
    why: 'the prehistory starts at -60; this event is at -100',
    context: { historyStartMinutes: TINY_MANOR_HISTORY_START },
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) =>
        s.truth.events.push(lone(`ev_${s.truth.events.length + 1}`, -100, 1)),
      ),
  },
  {
    name: 'the incident window runs past the end',
    check: 'V-TIMELINE',
    code: 'TIMELINE_INCIDENT_WINDOW_AFTER_END',
    why: 'the window ends at 2000 in a 1440-minute scenario',
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.truth.incident.window = { from: -20, to: 2000 };
      }),
  },
  {
    name: 'the incident window starts before the prehistory',
    check: 'V-TIMELINE',
    code: 'TIMELINE_INCIDENT_WINDOW_BEFORE_HISTORY',
    why: 'the window starts at -500, before the prehistory at -60',
    context: { historyStartMinutes: TINY_MANOR_HISTORY_START },
    linksEvents: true,
    make: (base) =>
      viaSnapshot(base, (s) => {
        s.truth.incident.window = { from: -500, to: -8 };
      }),
  },
  {
    name: 'a routine has a gap: nobody knows where the bursar is from 07:00 to 08:00',
    check: 'V-TIMELINE',
    code: 'CHAR_SCHEDULE_GAP',
    why: 'blocks cover 00:00-07:00 and 08:00-24:00',
    linksEvents: false,
    make: (base) =>
      withCast(
        base,
        replaceBursar(base, [
          { from: 0, to: 420, location: 'loc_archive', activity: 'rest', flexibility: 0.2 },
          { from: 480, to: 1440, location: 'loc_archive', activity: 'bursar', flexibility: 0.4 },
        ]),
      ),
  },
  {
    name: 'a routine overlaps itself',
    check: 'V-TIMELINE',
    code: 'CHAR_SCHEDULE_OVERLAP',
    why: 'the second block starts at 05:00 while the first runs to 07:00',
    linksEvents: false,
    make: (base) =>
      withCast(
        base,
        replaceBursar(base, [
          { from: 0, to: 420, location: 'loc_archive', activity: 'rest', flexibility: 0.2 },
          { from: 300, to: 1440, location: 'loc_archive', activity: 'bursar', flexibility: 0.4 },
        ]),
      ),
  },
  {
    name: 'a routine block that starts and ends at the same minute',
    check: 'V-TIMELINE',
    code: 'CHAR_INVALID_SCHEDULE',
    why: 'a block from 07:00 to 07:00 has no length',
    linksEvents: false,
    make: (base) =>
      withCast(
        base,
        replaceBursar(base, [
          { from: 0, to: 1440, location: 'loc_archive', activity: 'rest', flexibility: 0.2 },
          { from: 420, to: 420, location: 'loc_archive', activity: 'bursar', flexibility: 0.4 },
        ]),
      ),
  },
  {
    name: 'a routine moves to a room nobody can walk to',
    check: 'V-TIMELINE',
    code: 'TIMELINE_ROUTINE_UNREACHABLE',
    why: 'the bursar spends the afternoon in a cellar with no door',
    linksEvents: false,
    make: (base) => {
      const snapshot = base.world.locations.snapshot();
      const cellar = {
        ...snapshot.locations[0]!,
        id: 'loc_cellar',
        name: 'Cellar',
        connections: [],
        access: [],
      };
      const world = {
        ...base.world,
        locations: new LocationGraph({
          locations: [...snapshot.locations, cellar],
          preset: { time: { startDateTime: snapshot.startDateTime } },
        }),
      };
      return withCast(
        base,
        replaceBursar(base, [
          {
            from: 0,
            to: 720,
            location: bursarRoutine(base).routine[0]!.location,
            activity: 'rest',
            flexibility: 0.2,
          },
          { from: 720, to: 1440, location: 'loc_cellar', activity: 'hide', flexibility: 0.4 },
        ]),
        world,
      );
    },
  },
  {
    name: 'a routine refers to a room that does not exist',
    check: 'V-TIMELINE',
    code: 'TIMELINE_ROUTINE_UNKNOWN_LOCATION',
    why: 'loc_nowhere is not in the world',
    linksEvents: false,
    make: (base) =>
      withCast(
        base,
        replaceBursar(base, [
          { from: 0, to: 720, location: 'loc_archive', activity: 'rest', flexibility: 0.2 },
          { from: 720, to: 1440, location: 'loc_nowhere', activity: 'bursar', flexibility: 0.4 },
        ]),
      ),
  },

  // ---- V-PHONE-REQUIRED: the broken part is the clue set, so the investigation is left as is ----
  {
    name: 'only one mandatory clue in five is captured by QR',
    check: 'V-PHONE-REQUIRED',
    code: 'PHONE_QR_SHARE_TOO_LOW',
    why: '1 of 5 is 20 %, below the 30 % the preset demands',
    context: { clues: CLEAN_CLUES.map((c) => (c.id === 'cl_2' ? clue(c.id, 'auto') : c)) },
    linksEvents: true,
    make: (base) => base,
  },
  {
    name: 'a mandatory clue is missing from the clues of the case',
    check: 'V-PHONE-REQUIRED',
    code: 'PHONE_UNKNOWN_REQUIRED_CLUE',
    why: 'cl_9 is mandatory but no such clue exists',
    context: { requiredClueIds: [...CLEAN_CLUES.map(({ id }) => id), 'cl_9'] },
    linksEvents: false,
    make: (base) => base,
  },
  {
    name: 'the case has no mandatory clues at all',
    check: 'V-PHONE-REQUIRED',
    code: 'PHONE_NO_REQUIRED_CLUES',
    why: 'nothing is mandatory, so no mandatory clue uses the phone',
    context: { requiredClueIds: [] },
    linksEvents: false,
    make: (base) => base,
  },
  {
    name: 'the preset asks for a share above 100 %',
    check: 'V-PHONE-REQUIRED',
    code: 'PHONE_INVALID_MIN_SHARE',
    why: 'minQrShare 1.2 is not a share',
    context: { minQrShare: 1.2 },
    linksEvents: false,
    make: (base) => base,
  },

  // ---- V-DETERMINISM ----
  {
    name: 'a second generation produces a different case',
    check: 'V-DETERMINISM',
    code: 'DETERMINISM_HASH_MISMATCH',
    why: 'the repeat has one more event than the first generation',
    context: { regenerate: () => addLoneEvent(cleanInvestigation(), 1000, 1) },
    linksEvents: false,
    make: (base) => base,
  },
  {
    name: 'a second generation fails outright',
    check: 'V-DETERMINISM',
    code: 'DETERMINISM_REGENERATION_FAILED',
    why: 'the repeat throws instead of returning a case',
    context: {
      regenerate: () => {
        throw new Error('generator exploded');
      },
    },
    linksEvents: false,
    make: (base) => base,
  },
];

/** An unbroken tiny-manor: the baseline every check must accept. */
export const cleanInvestigation = (): Investigation => tinyManor();

/** The same investigation after a save/restore round trip, with nothing changed. */
export const roundTripped = (base: Investigation): Investigation =>
  viaSnapshot(base, () => undefined);

/** tiny-manor plus one harmless event, to test the edges of the scenario. */
export const addLoneEvent = (base: Investigation, t: number, duration: number): Investigation =>
  viaSnapshot(base, (s) =>
    s.truth.events.push(lone(`ev_${s.truth.events.length + 1}`, t, duration)),
  );
