import { FORBIDDEN_VIEW_KEYS, PlayerView, type PlayerAction } from '@hs/protocol';
import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../../test/fixtures/tiny-manor.ts';
import { deriveClues, type Clue } from '../../evidence/index.ts';
import { buildLiePolicy, KnowledgeStore } from '../../knowledge/index.ts';
import type { PackItem, Vitals } from '../../survival/index.ts';
import { TickPhase, createActionCostTable } from '../../time/index.ts';
import type { Fact } from '../../truth/index.ts';
import { GameEngine, type DispatchResult, type EnginePorts } from '../engine.ts';
import { deserializeInvestigation, type Investigation } from '../investigation.ts';
import { gameReplayRuntime } from '../save.ts';
import type { GameEvent, PlayerActionObserved } from './index.ts';

const bursar = 'ch_bursar';
const hall = 'loc_hall';
const study = 'loc_study';
const archive = 'loc_archive';
const at = (who: string, where: string, from: number, to: number): Fact => ({
  kind: 'at',
  who,
  where,
  interval: { from, to },
});

/** tiny-manor where the bursar walks into the study at minute 1 and stays there. */
function manor(honesty = 0.5): Investigation {
  const base = tinyManor(undefined, [
    { id: 'hs_desk', name: 'Desk', description: 'A writing desk with muddy footprints.' },
  ]);
  base.truth.append({
    t: 1,
    verb: 'move',
    location: archive,
    duration: 0,
    actorIds: [bursar],
    targets: [{ kind: 'location', id: study }],
    causes: [],
    facts: [at(bursar, study, 1, 1440)],
    traceIds: [],
    visibility: 'covert',
  });
  return {
    ...base,
    characters: base.characters.map((c) =>
      c.id === bursar ? { ...c, personality: { ...c.personality, honesty } } : c,
    ),
  };
}

function cluesOf(investigation: Investigation): Clue[] {
  const sourceEventId = investigation.truth.incident.keyEventIds[0]!;
  return deriveClues(
    [
      {
        id: 'trace_mud',
        kind: 'physical',
        sourceEventId,
        template: 'muddy_desk',
        supports: [`presence(${bursar},${study},-60)`],
        captureMode: 'auto',
        location: study,
        availableFrom: 0,
      },
      {
        id: 'trace_note',
        kind: 'document',
        sourceEventId,
        template: 'ledger_note',
        supports: ['means(bursar)'],
        captureMode: 'qr',
        location: study,
        availableFrom: 0,
      },
    ],
    new Map([
      ['muddy_desk', { action: { type: 'examineHotspot', hotspotId: 'hs_desk' } } as const],
      ['ledger_note', { action: { type: 'read', documentId: 'ledger_note' } } as const],
    ]),
  );
}

/** The bursar saw themself in the study and would rather say archive, or else the hall. */
function testimony(): NonNullable<EnginePorts['testimony']> {
  const knowledge = new KnowledgeStore();
  knowledge.add({
    proposition: at(bursar, study, -120, 0),
    source: 'observed',
    confidence: 1,
    acquiredAt: -1,
    fuzzMinutes: 0,
  });
  const replaces = { kind: 'at', who: bursar, where: study } as const;
  const guilt = {
    protect: [replaces],
    alternatives: [
      { replaces, proposition: at(bursar, archive, -120, 0) },
      { replaces, proposition: at(bursar, hall, -120, 0) },
    ],
  };
  const speaker = { id: bursar, personality: { honesty: 0.5 } } as never;
  const policy = buildLiePolicy(speaker, knowledge, [], guilt);
  return { witness: (id) => (id === bursar ? { knowledge, policy } : undefined) };
}

interface Setup {
  honesty?: number;
  startLocationId?: string;
  inventory?: PackItem[];
  startVitals?: Vitals;
  ports?: Partial<EnginePorts>;
}

function setup(options: Setup = {}) {
  const investigation = manor(options.honesty);
  const clues = cluesOf(investigation);
  const issued: string[] = [];
  const observed: PlayerActionObserved[] = [];
  const ports: EnginePorts = {
    startLocationId: options.startLocationId ?? study,
    clues,
    testimony: testimony(),
    evidenceTokens: {
      issue: (clueId) => {
        issued.push(clueId);
        return `tok_${issued.length}`;
      },
      revoke: () => undefined,
    },
    simulation: { onPlayerAction: (event) => observed.push(event) },
    ...(options.inventory && { inventory: options.inventory }),
    ...(options.startVitals && { startVitals: options.startVitals }),
    ...options.ports,
  };
  const engine = GameEngine.create(investigation, ports);
  return { engine, investigation, clues, issued, observed, ports };
}

const ofType = <T extends GameEvent['type']>(result: DispatchResult, type: T) =>
  result.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);

function expectRejected(engine: GameEngine, action: PlayerAction, error: string): void {
  const before = engine.stateHash();
  expect(engine.dispatch('desktop', action)).toEqual({
    ok: false,
    error,
    minutesSpent: 0,
    events: [],
  });
  expect(engine.stateHash()).toBe(before);
}

function lastVerb(engine: GameEngine): string | undefined {
  return deserializeInvestigation(engine.snapshot().investigation)
    .truth.events()
    .filter(({ actorIds }) => actorIds.includes('player'))
    .at(-1)?.verb;
}

describe('examineLocation and examineHotspot', () => {
  test('examining the room opens its hotspots once; a hotspot finds an auto clue', () => {
    const { engine, clues, observed } = setup();
    expect(engine.playerView().location.hotspots).toEqual([]);
    expectRejected(
      engine,
      { type: 'examineHotspot', hotspotId: 'hs_desk' },
      'ACTION_NOT_AVAILABLE',
    );

    expect(engine.dispatch('desktop', { type: 'examineLocation' })).toMatchObject({
      ok: true,
      minutesSpent: 15,
    });
    expect(lastVerb(engine)).toBe('examine_location');
    expect(engine.playerView().location.hotspots).toEqual([
      { id: 'hs_desk', name: 'Desk', examined: false },
    ]);
    expectRejected(engine, { type: 'examineLocation' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(
      engine,
      { type: 'examineHotspot', hotspotId: 'hs_none' },
      'ACTION_NOT_AVAILABLE',
    );

    const result = engine.dispatch('desktop', { type: 'examineHotspot', hotspotId: 'hs_desk' });
    expect(result).toMatchObject({ ok: true, minutesSpent: 5 });
    const mud = clues.find(({ captureMode }) => captureMode === 'auto')!;
    expect(ofType(result, 'ClueDiscovered')).toEqual([
      {
        type: 'ClueDiscovered',
        clueId: mud.id,
        locationId: study,
        at: 20,
        captureRequested: false,
      },
    ]);
    const view = engine.playerView();
    expect(view.location.hotspots[0]?.examined).toBe(true);
    expect(view.caseBoard.clues).toMatchObject([
      { id: mud.id, title: 'muddy_desk', kind: 'physical', discoveredAt: 20, captured: false },
    ]);
    expect(view.pendingCapture).toBeUndefined();
    expect(observed.map(({ action }) => action)).toEqual(['examineLocation', 'examineHotspot']);
    expect(observed[0]).toMatchObject({ witnessIds: [], heardByIds: [], locationId: study });
  });

  test('costs come from the TIME-004 table with the survival modifiers', () => {
    const custom = setup({
      ports: { actionCosts: createActionCostTable({ examineLocation: { base: 7 } }) },
    });
    expect(custom.engine.dispatch('desktop', { type: 'examineLocation' }).minutesSpent).toBe(7);

    const tired = setup({ startVitals: { health: 10, sanity: 10, fatigue: 80 } });
    const preview = tired.engine
      .playerView()
      .availableActions.find(({ action }) => action.type === 'examineLocation');
    expect(preview?.costPreview).toEqual({ min: 19, max: 19 });
    expect(tired.engine.dispatch('desktop', { type: 'examineLocation' }).minutesSpent).toBe(19);
  });
});

describe('read', () => {
  test('reading a document finds a QR clue and asks the phone to capture it', () => {
    const { engine, clues, issued } = setup();
    expectRejected(engine, { type: 'read', documentId: 'unknown_doc' }, 'ACTION_NOT_AVAILABLE');
    expect(engine.playerView().availableActions).toContainEqual(
      expect.objectContaining({ action: { type: 'read', documentId: 'ledger_note' } }),
    );

    const result = engine.dispatch('desktop', { type: 'read', documentId: 'ledger_note' });
    const note = clues.find(({ captureMode }) => captureMode === 'qr')!;
    expect(result).toMatchObject({ ok: true, minutesSpent: 10 });
    expect(ofType(result, 'ClueDiscovered')).toEqual([
      {
        type: 'ClueDiscovered',
        clueId: note.id,
        locationId: study,
        at: 10,
        captureRequested: true,
      },
    ]);
    expect(issued).toEqual([note.id]);
    expect(engine.pendingEvidenceCapture()).toMatchObject({ tokenId: 'tok_1', clueId: note.id });
    expect(engine.playerView().pendingCapture).toMatchObject({ tokenId: 'tok_1' });
    expect(engine.playerView().caseBoard.clues).toEqual([]);
    expect(engine.snapshot().desktop?.knowledge).toMatchObject({ clues: [], journal: [] });
    expect(JSON.stringify(engine.playerView())).not.toContain(note.supports[0]!);

    // Reading again while the token is active does not replace it.
    const again = engine.dispatch('desktop', { type: 'read', documentId: 'ledger_note' });
    expect(ofType(again, 'ClueDiscovered')).toEqual([]);
    expect(issued).toEqual([note.id]);

    for (let i = 0; i < 8; i++) {
      expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 }).ok).toBe(true);
    }
    expect(engine.pendingEvidenceCapture()).toBeUndefined();
    const retry = engine.dispatch('desktop', { type: 'read', documentId: 'ledger_note' });
    expect(ofType(retry, 'ClueDiscovered')).toMatchObject([{ captureRequested: true }]);
    expect(engine.pendingEvidenceCapture()).toMatchObject({ tokenId: 'tok_2', clueId: note.id });
    expect(engine.snapshot().desktop?.knowledge).toMatchObject({ clues: [], journal: [] });
  });

  test('a document cannot be read from another room', () => {
    const { engine } = setup({ startLocationId: hall });
    expectRejected(engine, { type: 'read', documentId: 'ledger_note' }, 'ACTION_NOT_AVAILABLE');
  });
});

describe('talk and interrogate', () => {
  function toContradiction(honesty?: number) {
    const context = setup(honesty === undefined ? {} : { honesty });
    const { engine } = context;
    expectRejected(
      engine,
      { type: 'talk', characterId: bursar, topicId: 'self' },
      'ACTION_NOT_AVAILABLE',
    );
    engine.dispatch('desktop', { type: 'examineLocation' });
    engine.dispatch('desktop', { type: 'examineHotspot', hotspotId: 'hs_desk' });
    const talk = engine.dispatch('desktop', {
      type: 'talk',
      characterId: bursar,
      topicId: 'where:-120:0',
    });
    return { ...context, talk };
  }

  test('talk records a statement without veracity, opens the dialogue and finds the contradiction', () => {
    const { engine, talk, observed } = toContradiction();
    expect(talk).toMatchObject({ ok: true, minutesSpent: 10 });
    const [heard] = ofType(talk, 'StatementHeard');
    expect(heard).toMatchObject({ characterId: bursar, topicId: 'whereWereYou', at: 30 });
    const [found] = ofType(talk, 'ContradictionFound');
    expect(found).toMatchObject({ statementId: heard!.statementId, at: 30 });
    expect(observed.at(-1)).toMatchObject({
      action: 'talk',
      characterId: bursar,
      topicId: 'where:-120:0',
      witnessIds: [bursar],
    });

    const view = engine.playerView();
    expect(view.caseBoard.statements).toEqual([
      {
        id: heard!.statementId,
        characterId: bursar,
        topicId: 'whereWereYou',
        text: 'testimony_whereWereYou_at',
        heardAt: 30,
      },
    ]);
    expect(view.caseBoard.contradictions).toMatchObject([{ id: found!.contradictionId }]);
    expect(view.interaction).toMatchObject({
      characterId: bursar,
      characterName: 'Morgan Pike',
      history: [
        { speaker: 'player', text: 'Где вы были?', at: 30 },
        { speaker: 'other', text: 'testimony_whereWereYou_at', at: 30 },
      ],
    });
    expect(view.interaction?.presentable).toContainEqual({
      type: 'contradiction',
      id: found!.contradictionId,
      label: 'Противоречие',
    });
    expect(view.interaction?.topics.map(({ id }) => id)).toEqual([
      'self',
      'where:-210:30',
      'saw:-210:30',
    ]);
  });

  test('topics are validated', () => {
    const { engine } = setup();
    engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    for (const topicId of [
      'bogus',
      'where:5:1',
      'where:0:999',
      `person:${bursar}`,
      'person:nobody',
    ]) {
      expectRejected(engine, { type: 'talk', characterId: bursar, topicId }, 'ACTION_INVALID');
    }
    expectRejected(
      engine,
      { type: 'talk', characterId: 'ch_cook', topicId: 'self' },
      'ACTION_NOT_AVAILABLE',
    );
    expect(
      engine.dispatch('desktop', { type: 'talk', characterId: bursar, topicId: 'self' }),
    ).toMatchObject({
      ok: true,
      minutesSpent: 10,
    });
  });

  test('a rebutted lie is admitted by an honest enough witness (KNOW-002)', () => {
    const { engine, talk } = toContradiction(0.5);
    const [found] = ofType(talk, 'ContradictionFound');
    const result = engine.dispatch('desktop', {
      type: 'interrogate',
      characterId: bursar,
      subject: { type: 'contradiction', contradictionId: found!.contradictionId },
    });
    expect(result).toMatchObject({ ok: true, minutesSpent: 20 });
    expect(ofType(result, 'InterrogationReaction')).toEqual([
      { type: 'InterrogationReaction', characterId: bursar, reaction: 'admit', at: 50 },
    ]);
    expect(ofType(result, 'StatementHeard')).toHaveLength(1);
    expect(engine.playerView().caseBoard.statements).toHaveLength(2);
  });

  test('an interrogation holds the hero in place until another action ends it (ENG-005)', () => {
    const { engine, talk } = toContradiction(0.5);
    const [found] = ofType(talk, 'ContradictionFound');
    engine.dispatch('desktop', {
      type: 'interrogate',
      characterId: bursar,
      subject: { type: 'contradiction', contradictionId: found!.contradictionId },
    });
    const hash = engine.stateHash();
    expect(engine.dispatch('desktop', { type: 'move', locationId: hall })).toMatchObject({
      ok: false,
      error: 'ACTION_BLOCKED',
      blockedReason: 'interrogation_open',
    });
    expect(engine.stateHash()).toBe(hash);
    expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 }).ok).toBe(true);
    expect(engine.dispatch('desktop', { type: 'move', locationId: hall }).ok).toBe(true);
  });

  test('a dishonest witness changes the story instead', () => {
    const { engine, talk } = toContradiction(0.4);
    const [found] = ofType(talk, 'ContradictionFound');
    const result = engine.dispatch('desktop', {
      type: 'interrogate',
      characterId: bursar,
      subject: { type: 'contradiction', contradictionId: found!.contradictionId },
    });
    expect(ofType(result, 'InterrogationReaction')[0]?.reaction).toBe('change');
    expect(lastVerb(engine)).toBe('interrogate');
  });

  test('interrogation needs a held clue or contradiction of this witness', () => {
    const { engine, clues } = setup();
    engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    const mud = clues.find(({ captureMode }) => captureMode === 'auto')!;
    const ask = (subject: Extract<PlayerAction, { type: 'interrogate' }>['subject']) =>
      ({ type: 'interrogate', characterId: bursar, subject }) as const;
    expectRejected(engine, ask({ type: 'evidence', clueId: mud.id }), 'ACTION_NOT_AVAILABLE');
    expectRejected(
      engine,
      ask({ type: 'contradiction', contradictionId: 'ctr_x' }),
      'ACTION_NOT_AVAILABLE',
    );

    engine.dispatch('desktop', { type: 'examineLocation' });
    engine.dispatch('desktop', { type: 'examineHotspot', hotspotId: 'hs_desk' });
    const result = engine.dispatch('desktop', ask({ type: 'evidence', clueId: mud.id }));
    expect(result).toMatchObject({ ok: true, minutesSpent: 20 });
    expect(engine.playerView().interaction?.history.at(-1)).toMatchObject({
      speaker: 'other',
      text: 'testimony_whatIsThis_at',
    });
  });

  test('another action ends the dialogue', () => {
    const { engine } = toContradiction();
    const result = engine.dispatch('desktop', { type: 'move', locationId: hall });
    expect(ofType(result, 'InteractionEnded')).toEqual([
      { type: 'InteractionEnded', characterId: bursar, at: 33 },
    ]);
    expect(engine.playerView().interaction).toBeUndefined();
  });
});

describe('useItem', () => {
  const pack: PackItem[] = [
    { id: 'pk', kind: 'lockpick' },
    { id: 'med', kind: 'medkit' },
    { id: 'torch', kind: 'flashlight', chargeMinutes: 30 },
  ];

  test('a medkit heals and is spent; a flashlight toggles and burns charge', () => {
    const { engine } = setup({
      inventory: pack,
      startVitals: { health: 5, sanity: 10, fatigue: 0 },
    });
    const result = engine.dispatch('desktop', { type: 'useItem', itemId: 'med' });
    expect(result).toMatchObject({ ok: true, minutesSpent: 5 });
    expect(ofType(result, 'ItemUsed')).toEqual([{ type: 'ItemUsed', itemId: 'med', at: 5 }]);
    const view = engine.playerView();
    expect(view.vitals.health).toBe(8);
    expect(view.inventory.map(({ id }) => id)).toEqual(['pk', 'torch']);

    engine.dispatch('desktop', { type: 'useItem', itemId: 'torch' });
    expect(engine.snapshot().desktop?.inventory).toMatchObject({ flashlightOn: true });
    engine.dispatch('desktop', { type: 'wait', minutes: 30 });
    expect(engine.snapshot().desktop?.inventory.flashlightOn).toBe(false);
    expectRejected(engine, { type: 'useItem', itemId: 'torch' }, 'ACTION_NOT_AVAILABLE');
  });

  test('items not in the pack, without a use, or aimed at a target are refused', () => {
    const { engine } = setup({ inventory: pack });
    expectRejected(engine, { type: 'useItem', itemId: 'nothing' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(engine, { type: 'useItem', itemId: 'pk' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(
      engine,
      { type: 'useItem', itemId: 'med', targetId: bursar },
      'ACTION_NOT_AVAILABLE',
    );
  });
});

describe('pickLock', () => {
  test('needs a lockpick and a locked door; is noisy; success opens the door both ways', () => {
    const none = setup();
    expectRejected(none.engine, { type: 'pickLock', targetId: archive }, 'ACTION_NOT_AVAILABLE');

    const { engine, observed } = setup({ inventory: [{ id: 'pk', kind: 'lockpick' }] });
    expectRejected(engine, { type: 'pickLock', targetId: hall }, 'ACTION_NOT_AVAILABLE');
    expectRejected(engine, { type: 'move', locationId: archive }, 'ACTION_NOT_AVAILABLE');
    engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    expect(engine.playerView().availableActions).toContainEqual({
      action: { type: 'pickLock', targetId: archive },
      label: 'Archive',
      costPreview: { min: 20, max: 30 },
    });

    let success = false;
    for (let attempt = 0; attempt < 20 && !success; attempt++) {
      const result = engine.dispatch('desktop', { type: 'pickLock', targetId: archive });
      const [picked] = ofType(result, 'LockPicked');
      success = picked!.success;
      expect(result.minutesSpent).toBe(success ? 20 : 30);
      expect(lastVerb(engine)).toBe(success ? 'pick_lock' : 'attempt_pick_lock');
      expect(observed.at(-1)).toMatchObject({
        action: 'pickLock',
        witnessIds: [bursar],
        heardByIds: [bursar],
      });
    }
    expect(success).toBe(true);
    expectRejected(engine, { type: 'pickLock', targetId: archive }, 'ACTION_NOT_AVAILABLE');
    expect(engine.dispatch('desktop', { type: 'move', locationId: archive }).ok).toBe(true);
    expect(engine.dispatch('desktop', { type: 'move', locationId: study }).ok).toBe(true);
  });
});

describe('rest', () => {
  test('restores vitals, only for allowed durations, and is refused after the end', () => {
    const { engine, investigation } = setup({
      startVitals: { health: 10, sanity: 8, fatigue: 50 },
    });
    expectRejected(engine, { type: 'rest', minutes: 61 }, 'ACTION_INVALID');
    const result = engine.dispatch('desktop', { type: 'rest', minutes: 120 });
    expect(result).toMatchObject({ ok: true, minutesSpent: 120 });
    expect(engine.playerView().vitals).toEqual({ health: 10, sanity: 9, fatigue: 0 });
    expect(lastVerb(engine)).toBe('rest');

    const short = { ...investigation, world: { ...investigation.world, durationMinutes: 30 } };
    const ending = GameEngine.create(short, { startLocationId: study });
    expect(ending.dispatch('desktop', { type: 'rest', minutes: 60 })).toMatchObject({
      minutesSpent: 30,
      outcome: 'time_expired',
    });
    expectRejected(ending, { type: 'rest', minutes: 60 }, 'GAME_OVER');
  });

  test('is interrupted by a time handler and restores only the minutes slept', () => {
    const { engine } = setup({
      startVitals: { health: 10, sanity: 10, fatigue: 50 },
      ports: {
        attachTime: (time) => {
          time.registerHandler('npc_arrives', {
            phase: TickPhase.Simulation,
            handle: () => ({ interrupt: 'npc_arrived' }),
          });
          time.schedule({ at: 30, priority: 0, kind: 'npc_arrives', payload: null });
        },
      },
    });
    const result = engine.dispatch('desktop', { type: 'rest', minutes: 60 });
    expect(result).toMatchObject({ ok: true, minutesSpent: 30 });
    expect(ofType(result, 'ActionInterrupted')).toEqual([
      { type: 'ActionInterrupted', at: 30, reason: 'npc_arrived' },
    ]);
    expect(engine.playerView().vitals.fatigue).toBe(35);
    // Ordinary actions are not interruptible: the handler only runs.
    expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 }).minutesSpent).toBe(15);
  });
});

const script: PlayerAction[] = [
  { type: 'examineLocation' },
  { type: 'examineHotspot', hotspotId: 'hs_desk' },
  { type: 'read', documentId: 'ledger_note' },
  { type: 'talk', characterId: bursar, topicId: 'where:-120:0' },
  { type: 'useItem', itemId: 'med' },
  { type: 'pickLock', targetId: archive },
  { type: 'rest', minutes: 60 },
];

describe('determinism and secrecy', () => {
  test('the same actions give the same results, and a snapshot replays identically', () => {
    const options = {
      inventory: [
        { id: 'pk', kind: 'lockpick' },
        { id: 'med', kind: 'medkit' },
      ] as PackItem[],
    };
    const first = setup(options);
    const second = setup(options);
    const half = script.length - 3;
    for (const action of script.slice(0, half)) {
      expect(first.engine.dispatch('desktop', action)).toEqual(
        second.engine.dispatch('desktop', action),
      );
    }
    const restored = gameReplayRuntime(first.investigation, first.ports).restore(
      JSON.parse(JSON.stringify(first.engine.snapshot())),
    );
    expect(restored.stateHash()).toBe(first.engine.stateHash());
    expect(restored.playerView()).toEqual(first.engine.playerView());
    for (const action of script.slice(half)) {
      const expected = first.engine.dispatch('desktop', action);
      expect(second.engine.dispatch('desktop', action)).toEqual(expected);
      expect(restored.dispatch('desktop', action)).toEqual(expected);
    }
    expect(restored.stateHash()).toBe(first.engine.stateHash());
    expect(second.engine.stateHash()).toBe(first.engine.stateHash());
  });

  test('views and events never carry the truth', () => {
    const { engine, investigation } = setup({ inventory: [{ id: 'med', kind: 'medkit' }] });
    const events: GameEvent[] = [];
    for (const action of script) {
      events.push(...engine.dispatch('desktop', action).events);
      const json = JSON.stringify(engine.playerView());
      expect(PlayerView.parse(JSON.parse(json))).toEqual(engine.playerView());
      for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}"`);
      expect(json).not.toContain(investigation.truth.incident.motive);
    }
    const json = JSON.stringify(events);
    for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}"`);
    expect(json).not.toContain('"lie"');
  });

  test('phone sources cannot dispatch desktop actions', () => {
    const { engine } = setup();
    const before = engine.stateHash();
    expect(engine.dispatch('phone', { type: 'examineLocation' })).toMatchObject({
      error: 'ACTION_INVALID',
    });
    expect(engine.stateHash()).toBe(before);
    expectRejected(
      engine,
      { type: 'accuse', caseFile: { accusedIds: [bursar], evidence: [] }, confirm: true },
      'ACTION_NOT_AVAILABLE',
    );
  });
});
