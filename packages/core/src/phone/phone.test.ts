import { FORBIDDEN_VIEW_KEYS, PhoneView } from '@hs/protocol';
import { expect, test } from 'vitest';
import { Calendar } from '../time/index.ts';
import {
  createPhoneState,
  initialPhoneState,
  projectPhoneView,
  reducePhone,
  type PhoneEvent,
  type PhoneState,
  type PhoneSurvival,
} from './index.ts';

const calendar = new Calendar('2025-01-10T08:00');
const calm: PhoneSurvival = { vitals: { health: 10, sanity: 10, fatigue: 0 }, static: 0 };
const context = { minute: 75, calendar };
const view = (s: PhoneState, survival = calm) => projectPhoneView(s, survival, context);
const apply = (s: PhoneState, ...events: PhoneEvent[]) => events.reduce(reducePhone, s);

const contact = { id: 'c1', name: 'Anna', number: '+100' };

test('initial state comes from unconditional preset templates', () => {
  const s = initialPhoneState(
    [
      { id: 'pg', kind: 'page', template: 'Welcome', title: 'Site' },
      { id: 'f1', kind: 'file', template: 'secret', title: 'Diary', hidden: true, password: 'pw' },
      { id: 'wp', kind: 'wallpaper', template: 'dim' },
      { id: 'm1', kind: 'message', template: 'later', event: 'ev_x' },
    ],
    { contacts: [contact], battery: 80 },
  );
  expect(s.browserPages).toHaveLength(1);
  expect(s.threads).toEqual([]);
  expect(s.battery).toBe(80);
  const v = view(s);
  expect(PhoneView.parse(v)).toEqual(v);
  expect(v.files).toEqual([]); // hidden
  expect(v.effects.wallpaperVariant).toBe('dim');
  expect(v.contacts).toEqual([{ ...contact, portraitRef: '' }]);
});

test('messages: receive, unread badge, read, send, typing', () => {
  let s = apply(createPhoneState({ contacts: [contact] }), {
    type: 'MessageReceived',
    thread: { id: 't1', contactId: 'c1', availableReplies: [{ id: 'r1', text: 'Ok' }] },
    message: { id: 'm1', text: 'Hi', at: 70 },
  });
  let v = view(s);
  expect(v.threads[0]).toMatchObject({ unread: 1, availableReplies: [{ id: 'r1', text: 'Ok' }] });
  expect(v.apps.find((a) => a.id === 'messages')?.badge).toBe(1);
  s = apply(
    s,
    {
      type: 'MessageReceived',
      thread: { id: 't1', contactId: 'c1' },
      message: { id: 'm1', text: 'Hi', at: 70 },
    },
    { type: 'TypingChanged', threadId: 't1', typing: true },
  );
  expect(view(s).threads[0]?.messages).toHaveLength(1); // duplicate ignored
  expect(view(s).threads[0]?.typing).toBe(true);
  s = apply(
    s,
    { type: 'TypingChanged', threadId: 't1', typing: false },
    { type: 'ThreadRead', threadId: 't1' },
    { type: 'MessageSent', threadId: 't1', message: { id: 'm2', text: 'Ok', at: 72 } },
  );
  v = view(s);
  expect(v.threads[0]).toMatchObject({ unread: 0 });
  expect(v.threads[0]?.typing).toBeUndefined();
  expect(v.threads[0]?.messages.map((m) => m.from)).toEqual(['them', 'me']);
});

test('calls: ring, answer, lines, end logs duration; unanswered logs missed', () => {
  const call = {
    callId: 'k1',
    contactId: 'c1',
    state: 'ringing' as const,
    startedAt: 60,
    lines: [],
    choices: [],
  };
  let s = apply(createPhoneState(), { type: 'CallStarted', call });
  expect(view(s).activeCall?.state).toBe('ringing');
  s = apply(
    s,
    { type: 'CallAnswered', callId: 'k1' },
    {
      type: 'CallLineAdded',
      callId: 'k1',
      speaker: 'other',
      text: 'Hello',
      choices: [{ id: 'a', text: 'Hi' }],
    },
    { type: 'CallLineAdded', callId: 'zzz', speaker: 'other', text: 'stale' },
    { type: 'CallEnded', callId: 'k1', at: 65 },
  );
  expect(view(s).activeCall).toBeUndefined();
  expect(view(s).callLog).toEqual([
    { id: 'k1', contactId: 'c1', direction: 'incoming', at: 60, durationMinutes: 5 },
  ]);
  s = apply(
    s,
    { type: 'CallStarted', call: { ...call, callId: 'k2' } },
    { type: 'CallEnded', callId: 'k2', at: 70 },
    { type: 'CallMissed', entry: { id: 'k3', contactId: 'c1', at: 71, durationMinutes: 0 } },
  );
  expect(view(s).callLog.map((c) => c.direction)).toEqual(['incoming', 'missed', 'missed']);
  expect(view(s).apps.find((a) => a.id === 'calls')?.badge).toBe(2);
});

test('files: hidden, locked content withheld until unlocked, password never projected', () => {
  const file = {
    id: 'f1',
    name: 'Diary',
    locked: true,
    password: 'pw',
    passwordHint: 'pet',
    content: 'TOP',
    hidden: true,
  };
  let s = apply(createPhoneState(), { type: 'FileAdded', file });
  expect(view(s).files).toEqual([]);
  s = apply(s, { type: 'FileRevealed', fileId: 'f1' });
  expect(view(s).files).toEqual([{ id: 'f1', name: 'Diary', locked: true, passwordHint: 'pet' }]);
  expect(JSON.stringify(view(s))).not.toContain('TOP');
  s = apply(s, { type: 'FileUnlocked', fileId: 'f1' });
  expect(view(s).files[0]).toMatchObject({ locked: false, content: 'TOP' });
  expect(JSON.stringify(view(s))).not.toContain('"pw"');
});

test('gallery, notes, pins, pages, notifications, battery, wallpaper, contacts', () => {
  let s = createPhoneState();
  s = apply(
    s,
    { type: 'ContactAdded', contact },
    { type: 'ContactChanged', contact: { ...contact, name: 'Anya' } },
    { type: 'ContactChanged', contact: { id: 'nope', name: 'x', number: '1' } },
    { type: 'PhotoAdded', photo: { id: 'p1', title: 'Door', imageRef: 'img', takenAt: 50 } },
    { type: 'NoteAdded', note: { id: 'n1', source: 'auto', text: 'Found', at: 51 } },
    { type: 'MapPinAdded', pin: { id: 'pin1', locationId: 'loc', label: 'Hall' } },
    { type: 'MapPinAdded', pin: { id: 'pin1', locationId: 'loc', label: 'Hall', seenAt: 60 } },
    { type: 'PageAdded', page: { id: 'b1', title: 'T', url: 'u', text: 'x' } },
    {
      type: 'NotificationPosted',
      notification: { id: 'x1', appId: 'messages', title: 'T', text: 'x', at: 1, read: false },
    },
    { type: 'NotificationRead', notificationId: 'x1' },
    { type: 'BatteryChanged', battery: 140 },
    { type: 'WallpaperChanged', variant: 'blood' },
    { type: 'Unrelated' } as never,
  );
  const v = view(s);
  expect(PhoneView.parse(v)).toEqual(v);
  expect(v.contacts).toEqual([{ ...contact, name: 'Anya', portraitRef: '' }]);
  expect(v.gallery).toHaveLength(1);
  expect(v.notes).toHaveLength(1);
  expect(v.mapPins).toEqual([{ id: 'pin1', locationId: 'loc', label: 'Hall', seenAt: 60 }]);
  expect(v.browserPages).toHaveLength(1);
  expect(v.notifications[0]?.read).toBe(true);
  expect(v.status).toEqual({ time: '09:15', battery: 100, signal: 100 });
  expect(v.effects.wallpaperVariant).toBe('blood');
  s = apply(s, { type: 'WallpaperChanged', variant: undefined });
  expect(view(s).effects.wallpaperVariant).toBeUndefined();
});

test('reducer does not mutate its input', () => {
  const s = createPhoneState();
  const frozen = JSON.stringify(s);
  apply(s, { type: 'ContactAdded', contact }, { type: 'BatteryChanged', battery: 1 });
  expect(JSON.stringify(s)).toBe(frozen);
});

test('static and sanity drive signal, glitch and the browser', () => {
  const s = createPhoneState();
  expect(view(s).effects.glitchLevel).toBe(0);
  const low = view(s, { vitals: { health: 10, sanity: 2, fatigue: 0 }, static: 20 });
  expect(low.effects.glitchLevel).toBeGreaterThan(50);
  expect(low.status.signal).toBe(80);
  const noisy = view(s, { ...calm, static: 95 });
  expect(noisy.apps.find((a) => a.id === 'browser')?.enabled).toBe(false);
  expect(noisy.status.signal).toBe(5);
});

test('leak test: hallucination flags and server-only keys never reach the view', () => {
  for (let i = 0; i < 50; i++) {
    const hallucinated = i % 2 === 0;
    const s = apply(
      createPhoneState({ contacts: [{ ...contact, hallucination: hallucinated }] }),
      {
        type: 'MessageReceived',
        thread: { id: 't', contactId: 'c1' },
        message: { id: 'm', text: 'boo', at: i, hallucination: hallucinated },
      },
      {
        type: 'PhotoAdded',
        photo: { id: 'p', title: 'x', imageRef: 'r', takenAt: i, hallucination: hallucinated },
      },
      {
        type: 'NotificationPosted',
        notification: {
          id: 'n',
          appId: 'a',
          title: 't',
          text: 'x',
          at: i,
          read: false,
          hallucination: hallucinated,
        },
      },
      {
        type: 'FileAdded',
        file: {
          id: 'f',
          name: 'n',
          locked: true,
          password: 'hunter2',
          content: 'SECRET',
          hidden: false,
        },
      },
    );
    const v = view(s, { vitals: { health: 10, sanity: i % 11, fatigue: 0 }, static: i * 2 });
    const json = JSON.stringify(v);
    expect(PhoneView.parse(JSON.parse(json))).toEqual(v);
    for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}":`);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('password"');
  }
});

test('ENG-008: every contact has a portraitRef, from the cast by id or "" otherwise', () => {
  const s = apply(
    createPhoneState({
      contacts: [
        contact,
        { id: 'ch_2', name: 'Nurse', number: '+200' },
        { id: 'ch_3', name: 'Set', number: '+300', portraitRef: 'cook.m1' },
      ],
    }),
    {
      type: 'ContactAdded',
      contact: { id: 'ev_1_c', name: 'Unknown', number: '', hallucination: true },
    },
  );
  const portraits = new Map([
    ['ch_2', 'nurse.f1'],
    ['ch_3', 'head_doctor.m1'],
  ]);
  const v = projectPhoneView(s, calm, { ...context, portraits });
  expect(PhoneView.parse(v)).toEqual(v);
  expect(v.contacts.map(({ id, portraitRef }) => [id, portraitRef])).toEqual([
    ['c1', ''],
    ['ch_2', 'nurse.f1'],
    ['ch_3', 'cook.m1'],
    ['ev_1_c', ''],
  ]);
  expect(JSON.stringify(v)).not.toContain('hallucination');
});

test('ENG-008 leak test: portraitRef depends on the contact id, never on the hallucination flag', () => {
  const portraits = new Map([['ch_1', 'nurse.f1']]);
  const project = (hallucination: boolean) =>
    projectPhoneView(
      createPhoneState({
        contacts: [
          { id: 'ch_1', name: 'Nurse', number: '+1', hallucination },
          { id: 'ch_2', name: 'Cook', number: '+2', hallucination },
          { id: 'ev_5_a_c', name: 'Unknown', number: '', hallucination },
        ],
      }),
      calm,
      { ...context, portraits },
    );
  // The same phone with every contact real or every contact hallucinated projects identically:
  // the flag adds no bit to the view, through portraitRef or anything else.
  expect(project(true)).toEqual(project(false));
  expect(project(true).contacts.map(({ portraitRef }) => portraitRef)).toEqual([
    'nurse.f1',
    '',
    '',
  ]);
});
