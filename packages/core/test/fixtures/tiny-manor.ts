import { deriveClues, type Clue } from '../../src/evidence/index.ts';
import { RelationshipGraph, type Character } from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import { InvestigationBuilder, type Investigation } from '@hs/core/game';
import { buildLiePolicy, KnowledgeStore, type SpeakerContext } from '@hs/core/knowledge';
import { factId, TruthLog, TruthModel, type Fact, type TruthEventInput } from '@hs/core/truth';
import { ItemRegistry, LocationGraph } from '@hs/core/world';

type Location = ScenarioContent['locations'][number];
const START_DATE_TIME = '2026-01-14T08:00:00';
const HISTORY_START = -60;
const owner = 'ch_owner';
const bursar = 'ch_bursar';
const cook = 'ch_cook';
const porter = 'ch_porter';
const hall = 'loc_hall';
const archive = 'loc_archive';
const pantry = 'loc_pantry';
const study = 'loc_study';
const key = 'it_study_key';
const ledger = 'it_ledger';
const trunk = 'it_trunk';
const secretId = 'sec_manor_debt';
const ARCHIVE_TRAVEL_MINUTES = 4;

function room(
  id: string,
  name: string,
  description: string,
  connections: Location['connections'],
  access: Location['access'] = [],
  hotspots: Location['hotspots'] = [],
): Location {
  return {
    id,
    name,
    description,
    connections,
    access,
    tags: [],
    hotspots,
    lighting: { morning: 'bright', day: 'bright', evening: 'dim', night: 'dark' },
  };
}

function character(id: string, name: string, home: string, activity: string): Character {
  return {
    id,
    name,
    archetypeId: activity,
    age: 40,
    socialStatus: 'resident',
    personality: {
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
      honesty: 0.5,
      courage: 0.5,
      impulsivity: 0.5,
    },
    biography: [],
    goals: [],
    fears: [],
    habits: [],
    desires: [],
    secrets: [],
    access: [],
    routine: [
      { from: 0, to: 420, location: home, activity: 'rest', flexibility: 0.2 },
      { from: 420, to: 1440, location: home, activity, flexibility: 0.4 },
    ],
  };
}

const at = (who: string, where: string, from: number, to: number): Fact => ({
  kind: 'at',
  who,
  where,
  interval: { from, to },
});

/**
 * The bursar steals the manor's ledger to conceal a debt while the owner is in the hall.
 * Every call builds a fresh server-side scenario with an hour of prehistory.
 */
export function tinyManor(
  seed = 'tiny-manor-fixture',
  studyHotspots: Location['hotspots'] = [],
): Investigation {
  const locations = [
    room(hall, 'Hall', 'The entrance connects the study and pantry.', [
      { to: study, minutes: 3 },
      { to: pantry, minutes: 2 },
    ]),
    room(
      study,
      'Study',
      'The ledger is normally kept on the desk.',
      [
        { to: hall, minutes: 3 },
        { to: archive, minutes: ARCHIVE_TRAVEL_MINUTES, locked: { itemId: key } },
      ],
      [],
      studyHotspots,
    ),
    room(
      archive,
      'Archive',
      'Records and an old trunk are kept behind a locked door.',
      [{ to: study, minutes: ARCHIVE_TRAVEL_MINUTES, locked: { itemId: key } }],
      [{ itemId: key }],
    ),
    room(pantry, 'Pantry', 'The cook can hear visitors entering the hall.', [
      { to: hall, minutes: 2 },
    ]),
  ];
  const items = new ItemRegistry(
    {
      locations,
      items: [
        { id: key, name: 'Study key', kind: 'key', tags: [], ownerArchetype: 'bursar' },
        { id: ledger, name: 'Manor ledger', kind: 'book', tags: [], locationId: study },
        { id: trunk, name: 'Archive trunk', kind: 'container', tags: [], locationId: archive },
      ],
    },
    new Map([['bursar', bursar]]),
    HISTORY_START,
  );
  const characters = [
    { ...character(owner, 'Ada Vale', hall, 'owner'), secrets: [secretId] },
    {
      ...character(bursar, 'Morgan Pike', archive, 'bursar'),
      secrets: [secretId],
      access: [{ locationId: archive, itemId: key }],
    },
    character(cook, 'Ellis Ward', pantry, 'cook'),
    character(porter, 'Robin Shaw', hall, 'porter'),
  ];

  const debt: Fact = {
    kind: 'relation',
    a: owner,
    b: bursar,
    relType: 'debt',
    since: HISTORY_START,
  };
  const motive: Fact = {
    kind: 'motive',
    who: bursar,
    against: owner,
    motiveType: 'conceal_debt',
    basis: [factId(debt)],
  };
  const log = new TruthLog();
  const record = (
    t: number,
    verb: TruthEventInput['verb'],
    location: string,
    details: Partial<Omit<TruthEventInput, 't' | 'verb' | 'location'>>,
  ) =>
    log.append({
      t,
      verb,
      location,
      duration: 0,
      actorIds: [bursar],
      targets: [],
      causes: [],
      facts: [],
      traceIds: [],
      visibility: 'covert',
      ...details,
    }).id;

  const move = (t: number, from: string, to: string, stayUntil: number, cause: string) =>
    record(t, 'move', from, {
      duration: ARCHIVE_TRAVEL_MINUTES,
      targets: [{ kind: 'location', id: to }],
      causes: [cause],
      facts: [at(bursar, to, t + ARCHIVE_TRAVEL_MINUTES, stayUntil)],
    });

  const debtRecorded = record(HISTORY_START, 'write', archive, {
    duration: 5,
    facts: [
      at(bursar, archive, HISTORY_START, -25),
      debt,
      motive,
      { kind: 'possessed', who: bursar, item: key, interval: { from: HISTORY_START, to: 1 } },
    ],
  });
  for (const { who, t, duration, verb, location } of [
    { t: -50, duration: 45, verb: 'work', location: pantry, who: cook },
    { t: -48, duration: 40, verb: 'work', location: hall, who: porter },
    { t: -40, duration: 30, verb: 'read', location: hall, who: owner },
  ]) {
    record(t, verb, location, { duration, actorIds: [who], facts: [at(who, location, t, 1)] });
  }
  const entered = move(-25, archive, study, -15, debtRecorded);
  const taken = record(-20, 'take', study, {
    duration: 2,
    targets: [{ kind: 'item', id: ledger }],
    causes: [entered],
    facts: [{ kind: 'possessed', who: bursar, item: ledger, interval: { from: -20, to: -10 } }],
  });
  const returned = move(-15, study, archive, 1, taken);
  const hidden = record(-10, 'hide', archive, {
    duration: 2,
    targets: [
      { kind: 'item', id: ledger },
      { kind: 'item', id: trunk },
    ],
    causes: [returned],
  });
  items.move(ledger, { kind: 'character', id: bursar }, -20, taken);
  items.move(ledger, { kind: 'container', id: trunk }, -10, hidden);
  const truth = new TruthModel(
    {
      type: 'theft',
      victimIds: [owner],
      culpritIds: [bursar],
      motive: factId(motive),
      means: key,
      keyEventIds: [taken, hidden],
      window: { from: -20, to: -8 },
    },
    log.inAppendOrder(),
  );
  const relationships = new RelationshipGraph([
    {
      a: owner,
      b: bursar,
      type: 'debt',
      trust: -0.5,
      valence: 0.2,
      intensity: 0.8,
      history: [debtRecorded],
    },
    { a: cook, b: porter, type: 'friendship', trust: 0.5, valence: 0.7, intensity: 0.4 },
  ]);

  return new InvestigationBuilder({ scenarioId: 'tiny-manor', seed, generatorVersion: '0.1.0' })
    .withWorld({
      locations: new LocationGraph({
        locations,
        preset: { time: { startDateTime: START_DATE_TIME } },
      }),
      items,
      durationMinutes: 1440,
    })
    .withCharacters(characters)
    .withRelationships(relationships)
    .withTruth(truth)
    .withSecrets([{ id: secretId, fact: debt, knownBy: [owner, bursar] }])
    .build();
}

export function tinyManorWithClues(
  seed?: string,
): Investigation & { readonly clues: readonly Clue[] } {
  const investigation = tinyManor(seed);
  const sourceEventId = investigation.truth.incident.keyEventIds[0]!;
  const clues = deriveClues(
    [
      {
        id: 'trace_missing_ledger',
        kind: 'document',
        sourceEventId,
        template: 'missing_ledger',
        supports: ['means(bursar)'],
        captureMode: 'qr',
        location: study,
        availableFrom: 0,
      },
    ],
    new Map([['missing_ledger', { action: { type: 'read', documentId: 'ledger_note' } }]]),
  );
  return { ...investigation, clues };
}

export function tinyManorWitness(): SpeakerContext {
  const witness = tinyManor().characters.find(({ id }) => id === bursar)!;
  const speaker = { ...witness, personality: { ...witness.personality, honesty: 0.4 } };
  const knowledge = new KnowledgeStore();
  const observed = at(bursar, study, -21, -15);
  knowledge.add({
    proposition: observed,
    source: 'observed',
    confidence: 1,
    acquiredAt: -15,
    fuzzMinutes: 0,
  });
  const replaces = { kind: 'at', who: bursar, where: study } as const;
  const guilt = {
    protect: [replaces],
    alternatives: [
      { replaces, proposition: at(bursar, archive, -21, -15) },
      { replaces, proposition: at(bursar, hall, -21, -15) },
    ],
  };
  return {
    character: speaker,
    knowledge,
    policy: buildLiePolicy(speaker, knowledge, [], guilt),
    now: 0,
  };
}
