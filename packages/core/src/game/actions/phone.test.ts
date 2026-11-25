import { PhoneView, type PlayerAction } from '@hs/protocol';
import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../../test/fixtures/tiny-manor.ts';
import { deriveClues } from '../../evidence/index.ts';
import { createPhoneState, type PhoneState } from '../../phone/index.ts';
import { GameEngine, type DispatchResult, type EnginePorts, type GameSnapshot } from '../engine.ts';
import { deserializeInvestigation } from '../investigation.ts';
import { gameReplayRuntime } from '../save.ts';
import type { GameEvent, PhonePort } from './index.ts';

const study = 'loc_study';
const friend = 'ch_friend';

function startPhone(): PhoneState {
  return createPhoneState({
    contacts: [{ id: friend, name: 'Friend', number: '101', hallucination: true }],
    threads: [
      {
        id: 'th_friend',
        contactId: friend,
        messages: [],
        availableReplies: [
          { id: 'tpl_hello', text: 'Hello' },
          { id: 'tpl_help', text: 'Need help' },
        ],
      },
    ],
    browserPages: [{ id: 'pg_news', title: 'News', url: 'local://news', text: 'Rain.' }],
    files: [
      {
        id: 'f_open',
        name: 'Open',
        locked: false,
        content: 'open text',
        hidden: false,
      },
      {
        id: 'f_locked',
        name: 'Locked',
        locked: true,
        password: 'swordfish',
        passwordHint: 'a fish',
        content: 'SECRET-CONTENT',
        hidden: false,
      },
      { id: 'f_hidden', name: 'Hidden', locked: false, content: 'hid', hidden: true },
    ],
  });
}

const port: PhonePort = {
  callGreeting: (contactId) =>
    contactId === friend
      ? {
          text: 'Hi',
          choices: [
            { id: 'ask_ledger', text: 'About the ledger' },
            { id: 'ask_more', text: 'More' },
          ],
        }
      : undefined,
  callReply: (_contact, choiceId) =>
    choiceId === 'ask_more'
      ? { text: 'Bye', minutes: 4, end: true }
      : { text: 'Ledger is missing', minutes: 3, choices: [{ id: 'ask_more', text: 'More' }] },
  messageReply: (_contact, templateId) =>
    templateId === 'tpl_hello' ? { delayMinutes: 25, text: 'Hello back' } : undefined,
};

function setup(overrides: Partial<EnginePorts> = {}) {
  const investigation = tinyManor();
  const sourceEventId = investigation.truth.incident.keyEventIds[0]!;
  const clues = deriveClues(
    [
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
    new Map([['ledger_note', { action: { type: 'read', documentId: 'ledger_note' } } as const]]),
  );
  const ports: EnginePorts = {
    startLocationId: study,
    clues,
    phone: { initial: startPhone(), ...port },
    evidenceTokens: { issue: () => 'tok_1', revoke: () => undefined },
    ...overrides,
  };
  const engine = GameEngine.create(investigation, ports);
  return { engine, investigation, clues, ports };
}

const phone = (engine: GameEngine, action: PlayerAction): DispatchResult =>
  engine.dispatch('phone', action);
const ofType = <T extends GameEvent['type']>(result: DispatchResult, type: T) =>
  result.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
const state = (engine: GameEngine) => (engine.snapshot().phone as { state: PhoneState }).state;

function expectRejected(
  engine: GameEngine,
  action: PlayerAction,
  error: string,
  source: 'phone' | 'desktop' = 'phone',
): void {
  const before = engine.stateHash();
  expect(engine.dispatch(source, action)).toMatchObject({ ok: false, error, minutesSpent: 0 });
  expect(engine.stateHash()).toBe(before);
}

describe('call', () => {
  test('a call to an unknown contact is impossible', () => {
    const { engine } = setup();
    expectRejected(engine, { type: 'call', contactId: 'ch_nobody' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(engine, { type: 'call', contactId: 'ch_nobody' }, 'ACTION_INVALID', 'desktop');
  });

  test('a call opens a conversation with limited topics and costs time and battery', () => {
    const { engine } = setup();
    const started = phone(engine, { type: 'call', contactId: friend });
    expect(started).toMatchObject({ ok: true, minutesSpent: 5 });
    expect(ofType(started, 'CallStarted')).toHaveLength(1);
    expect(state(engine).battery).toBe(98);
    const call = state(engine).activeCall!;
    expect(call).toMatchObject({ contactId: friend, state: 'active' });
    expect(call.choices.map(({ id }) => id)).toEqual(['ask_ledger', 'ask_more']);

    expectRejected(engine, { type: 'callChoice', choiceId: 'nope' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(engine, { type: 'call', contactId: friend }, 'ACTION_NOT_AVAILABLE');

    const first = phone(engine, { type: 'callChoice', choiceId: 'ask_ledger' });
    expect(first.minutesSpent).toBe(3);
    expect(state(engine).activeCall?.lines.map(({ text }) => text)).toEqual([
      'Алло?',
      'Hi',
      'About the ledger',
      'Ledger is missing',
    ]);
    const last = phone(engine, { type: 'callChoice', choiceId: 'ask_more' });
    expect(last.minutesSpent).toBe(4);
    expect(ofType(last, 'CallEnded')).toHaveLength(1);
    expect(state(engine).activeCall).toBeUndefined();
    expect(state(engine).callLog).toMatchObject([
      { contactId: friend, direction: 'outgoing', at: 5, durationMinutes: 7 },
    ]);
  });

  test('an unanswered call is logged as missed and costs no call battery', () => {
    const { engine } = setup({ phone: { initial: startPhone() } });
    const result = phone(engine, { type: 'call', contactId: friend });
    expect(result).toMatchObject({ ok: true, minutesSpent: 5 });
    expect(ofType(result, 'CallMissed')).toHaveLength(1);
    expect(state(engine).callLog).toMatchObject([{ direction: 'missed' }]);
    expect(state(engine).battery).toBe(100);
  });

  test('a call blocks a face-to-face conversation; a conversation blocks a call', () => {
    const { engine } = setup();
    phone(engine, { type: 'call', contactId: friend });
    const talk = engine.dispatch('desktop', {
      type: 'talk',
      characterId: 'ch_bursar',
      topicId: 'whereWereYou',
    });
    expect(talk).toMatchObject({
      ok: false,
      error: 'ACTION_BLOCKED',
      blockedReason: 'call_active',
    });
  });

  test('an incoming call is answered with answerCall', () => {
    const { engine } = setup();
    engine.receivePhoneEvent({
      type: 'CallStarted',
      call: {
        callId: 'in_1',
        contactId: friend,
        state: 'ringing',
        startedAt: 0,
        lines: [{ speaker: 'other', text: 'Pick up' }],
        choices: [{ id: 'ask_more', text: 'More' }],
      },
    });
    expect(engine.dispatch('phone', { type: 'call', contactId: friend })).toMatchObject({
      ok: false,
      error: 'ACTION_BLOCKED',
      blockedReason: 'call_ringing',
    });
    expectRejected(engine, { type: 'answerCall', callId: 'other' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(engine, { type: 'callChoice', choiceId: 'ask_more' }, 'ACTION_NOT_AVAILABLE');

    const answered = phone(engine, { type: 'answerCall', callId: 'in_1' });
    expect(answered).toMatchObject({ ok: true, minutesSpent: 1 });
    expect(state(engine).activeCall?.state).toBe('active');
    expect(state(engine).battery).toBe(98);
    expectRejected(engine, { type: 'answerCall', callId: 'in_1' }, 'ACTION_NOT_AVAILABLE');
    phone(engine, { type: 'callChoice', choiceId: 'ask_more' });
    expect(state(engine).callLog).toMatchObject([{ id: 'in_1', direction: 'incoming' }]);
  });
});

describe('message', () => {
  test('the reply arrives after the time the simulation chose', () => {
    const { engine } = setup();
    expectRejected(
      engine,
      { type: 'message', contactId: friend, templateId: 'x' },
      'ACTION_NOT_AVAILABLE',
    );
    expectRejected(
      engine,
      { type: 'message', contactId: 'ch_nobody', templateId: 'tpl_hello' },
      'ACTION_NOT_AVAILABLE',
    );

    const sent = phone(engine, { type: 'message', contactId: friend, templateId: 'tpl_hello' });
    expect(sent).toMatchObject({ ok: true, minutesSpent: 2 });
    let thread = state(engine).threads[0]!;
    expect(thread.messages).toMatchObject([{ from: 'me', text: 'Hello', at: 2 }]);
    expect(thread.typing).toBe(true);

    // minute 2 + 25 = 27: not yet at minute 17, delivered by minute 32.
    engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    thread = state(engine).threads[0]!;
    expect(thread.messages).toHaveLength(1);
    const late = engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    expect(ofType(late, 'MessageReceived')).toHaveLength(1);
    thread = state(engine).threads[0]!;
    expect(thread.messages.map(({ from, text, at }) => [from, text, at])).toEqual([
      ['me', 'Hello', 2],
      ['them', 'Hello back', 27],
    ]);
    expect(thread.typing).toBeUndefined();
    expect(state(engine).notifications).toMatchObject([{ appId: 'messages', title: 'Friend' }]);
  });

  test('a message the simulation does not answer gets no reply', () => {
    const { engine } = setup();
    phone(engine, { type: 'message', contactId: friend, templateId: 'tpl_help' });
    engine.dispatch('desktop', { type: 'wait', minutes: 120 });
    expect(state(engine).threads[0]!.messages).toHaveLength(1);
    expect(state(engine).threads[0]!.typing).toBeUndefined();
  });

  test('a queued reply survives a snapshot', () => {
    const { engine, investigation, ports } = setup();
    phone(engine, { type: 'message', contactId: friend, templateId: 'tpl_hello' });
    const restored = GameEngine.restore(structuredClone(engine.snapshot()), investigation, ports);
    expect(restored.stateHash()).toBe(engine.stateHash());
    restored.dispatch('desktop', { type: 'wait', minutes: 30 });
    expect(state(restored).threads[0]!.messages).toHaveLength(2);
  });
});

describe('captureEvidence', () => {
  function withPending() {
    const ctx = setup();
    ctx.engine.dispatch('desktop', { type: 'read', documentId: 'ledger_note' });
    return ctx;
  }

  test('captures the clue, clears the pending capture and costs a scan', () => {
    const { engine, clues } = withPending();
    expect(engine.pendingEvidenceCapture()?.tokenId).toBe('tok_1');
    expect(engine.snapshot().desktop?.knowledge).toMatchObject({ clues: [] });
    const battery = state(engine).battery;

    expectRejected(engine, { type: 'captureEvidence', tokenId: 'wrong' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(
      engine,
      { type: 'captureEvidence', tokenId: 'tok_1' },
      'ACTION_INVALID',
      'desktop',
    );
    const result = phone(engine, { type: 'captureEvidence', tokenId: 'tok_1' });
    expect(result).toMatchObject({ ok: true, minutesSpent: 2 });
    expect(ofType(result, 'EvidenceCaptured')).toMatchObject([{ clueId: clues[0]!.id }]);
    expect(engine.snapshot().desktop?.knowledge).toMatchObject({
      clues: [{ clueId: clues[0]!.id, captured: true }],
    });
    expect(engine.pendingEvidenceCapture()).toBeUndefined();
    expect(engine.playerView().pendingCapture).toBeUndefined();
    expect(state(engine).gallery).toHaveLength(1);
    expect(state(engine).battery).toBe(battery - 1);
    expect(engine.playerView().caseBoard.clues).toMatchObject([
      { id: clues[0]!.id, captured: true },
    ]);

    expectRejected(engine, { type: 'captureEvidence', tokenId: 'tok_1' }, 'ACTION_NOT_AVAILABLE');
  });

  test('an expired token cannot be used', () => {
    const { engine } = withPending();
    for (let i = 0; i < 8; i++) engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    expectRejected(engine, { type: 'captureEvidence', tokenId: 'tok_1' }, 'ACTION_NOT_AVAILABLE');
  });
});

describe('files, pages and notes', () => {
  test('browse and openFile work on visible content only', () => {
    const { engine } = setup();
    expect(phone(engine, { type: 'browse', pageId: 'pg_news' })).toMatchObject({
      ok: true,
      minutesSpent: 1,
    });
    expectRejected(engine, { type: 'browse', pageId: 'pg_none' }, 'ACTION_NOT_AVAILABLE');
    expect(phone(engine, { type: 'openFile', fileId: 'f_open' }).ok).toBe(true);
    expectRejected(engine, { type: 'openFile', fileId: 'f_locked' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(engine, { type: 'openFile', fileId: 'f_hidden' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(
      engine,
      { type: 'unlockFile', fileId: 'f_hidden', password: 'x' },
      'ACTION_NOT_AVAILABLE',
    );
    expectRejected(
      engine,
      { type: 'unlockFile', fileId: 'f_open', password: 'x' },
      'ACTION_NOT_AVAILABLE',
    );
  });

  test('unlockFile needs the right password, which costs time either way', () => {
    const { engine } = setup();
    const wrong = phone(engine, { type: 'unlockFile', fileId: 'f_locked', password: 'nope' });
    expect(wrong).toMatchObject({ ok: true, minutesSpent: 1 });
    expect(ofType(wrong, 'FileUnlockAttempted')).toMatchObject([{ success: false }]);
    expect(state(engine).files.find(({ id }) => id === 'f_locked')?.locked).toBe(true);

    const right = phone(engine, { type: 'unlockFile', fileId: 'f_locked', password: 'swordfish' });
    expect(ofType(right, 'FileUnlockAttempted')).toMatchObject([{ success: true }]);
    expect(state(engine).files.find(({ id }) => id === 'f_locked')?.locked).toBe(false);
    expect(phone(engine, { type: 'openFile', fileId: 'f_locked' }).ok).toBe(true);
  });

  test('addNote stores the player note', () => {
    const { engine } = setup();
    phone(engine, { type: 'addNote', text: 'check the desk' });
    expect(state(engine).notes).toMatchObject([
      { source: 'player', text: 'check the desk', at: 1 },
    ]);
    expectRejected(engine, { type: 'addNote', text: '' }, 'ACTION_INVALID');
  });
});

describe('battery', () => {
  test('drains with time and switches the phone off at 0 %', () => {
    const { engine } = setup({ phone: { initial: { ...startPhone(), battery: 2 } } });
    engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    expect(state(engine).battery).toBe(1);
    engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    expect(state(engine).battery).toBe(0);
    expectRejected(engine, { type: 'addNote', text: 'dark' }, 'ACTION_NOT_AVAILABLE');
    expectRejected(engine, { type: 'browse', pageId: 'pg_news' }, 'ACTION_NOT_AVAILABLE');
  });

  test('splitting time does not change the drain', () => {
    const a = setup().engine;
    const b = setup().engine;
    a.dispatch('desktop', { type: 'wait', minutes: 30 });
    for (let i = 0; i < 2; i++) b.dispatch('desktop', { type: 'wait', minutes: 15 });
    expect(state(a).battery).toBe(state(b).battery);
  });
});

describe('world effects', () => {
  const playerEvents = (engine: GameEngine) =>
    deserializeInvestigation(engine.snapshot().investigation)
      .truth.events()
      .filter(({ actorIds }) => actorIds.includes('player'));

  test('using the phone spends time but adds nothing to the truth log', () => {
    const { engine } = setup();
    phone(engine, { type: 'addNote', text: 'x' });
    phone(engine, { type: 'browse', pageId: 'pg_news' });
    expect(playerEvents(engine)).toEqual([]);
    engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    expect(playerEvents(engine)).toHaveLength(1);
  });

  test('a phone action does not close an open conversation', () => {
    const { engine, investigation, ports } = setup();
    const snapshot = structuredClone(engine.snapshot()) as {
      desktop: Record<string, unknown>;
    } & GameSnapshot;
    snapshot.desktop.interaction = { kind: 'dialogue', characterId: 'ch_bursar', history: [] };
    const talking = GameEngine.restore(snapshot, investigation, ports);
    const result = phone(talking, { type: 'addNote', text: 'while talking' });
    expect(ofType(result, 'InteractionEnded')).toEqual([]);
    expect(talking.snapshot().desktop?.interaction).toMatchObject({ characterId: 'ch_bursar' });
    // The call is blocked while the conversation is open.
    expect(phone(talking, { type: 'call', contactId: friend })).toMatchObject({
      error: 'ACTION_BLOCKED',
      blockedReason: 'dialogue_open',
    });
  });
});

describe('no phone', () => {
  test('an engine without ports.phone rejects phone actions and keeps its snapshot', () => {
    const { engine, investigation, ports } = setup({ phone: undefined as never });
    const bare = GameEngine.create(investigation, { ...ports, phone: undefined as never });
    expectRejected(bare, { type: 'addNote', text: 'x' }, 'ACTION_NOT_AVAILABLE');
    expect(bare.snapshot()).not.toHaveProperty('phone');
    expect(bare.phoneView()).toBeUndefined();
    expect(engine.phoneView()).toBeUndefined();
  });
});

describe('phoneView', () => {
  test('carries nothing server-only', () => {
    const { engine } = setup();
    phone(engine, { type: 'call', contactId: friend });
    const view = engine.phoneView()!;
    expect(PhoneView.safeParse(view).success).toBe(true);
    const json = JSON.stringify(view);
    expect(json).not.toContain('swordfish');
    expect(json).not.toContain('SECRET-CONTENT');
    expect(json).not.toContain('hallucination');
    expect(json).not.toContain('"hid"');
  });
});

describe('save and replay', () => {
  test('a journal with phone actions replays to the same state', () => {
    const { engine, investigation, ports } = setup();
    const actions: ['desktop' | 'phone', PlayerAction][] = [
      ['phone', { type: 'message', contactId: friend, templateId: 'tpl_hello' }],
      ['desktop', { type: 'wait', minutes: 30 }],
      ['phone', { type: 'call', contactId: friend }],
      ['phone', { type: 'callChoice', choiceId: 'ask_more' }],
    ];
    for (const [source, action] of actions) expect(engine.dispatch(source, action).ok).toBe(true);
    const runtime = gameReplayRuntime(investigation, ports);
    const replayed = runtime.engine;
    for (const [source, action] of actions) replayed.dispatch(source, action);
    expect(replayed.stateHash()).toBe(engine.stateHash());
    expect(runtime.restore(JSON.parse(JSON.stringify(engine.snapshot()))).stateHash()).toBe(
      engine.stateHash(),
    );
  });
});
