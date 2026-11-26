import { GameEngine } from '@hs/core/game';
import { loadScenarioFromDir } from '@hs/core/content';
import { createPhoneState } from '@hs/core/phone';
import { FORBIDDEN_VIEW_KEYS } from '@hs/protocol';
import { defaultScenariosDir } from '../routes/generation.ts';

import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  PhoneView,
  PlayerView,
  PROTOCOL_VERSION,
  ServerMessage,
  type ClientMessage,
} from '@hs/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { SessionGateway } from '../gateway/index.ts';
import { issueToken } from '../pairing/index.ts';
import { SessionManager, Session } from '../sessions/index.ts';
import { ViewCache, engineEvents } from './index.ts';
import {
  tinyManor,
  tinyManorWithClues,
  tinyManorWitness,
} from '../../../../packages/core/test/fixtures/tiny-manor.ts';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../packages/protocol/fixtures/views/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const playerView = PlayerView.parse(fixture('player-view.start'));
const phoneView = PhoneView.parse(fixture('phone-view.start'));

const apps: ReturnType<typeof buildApp>[] = [];
const sockets = new Set<WebSocket>();
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function client(address: string) {
  const socket = new WebSocket(address + '/ws');
  sockets.add(socket);
  const inbox: string[] = [];
  socket.on('message', (data) => {
    if (Buffer.isBuffer(data)) inbox.push(data.toString('utf8'));
  });
  await once(socket, 'open');
  return {
    send(message: Omit<ClientMessage, 'v' | 'id'>) {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id: 'request', ...message }));
    },
    /** The next message of any type. */
    async any() {
      await vi.waitFor(() => expect(inbox.length).toBeGreaterThan(0), { interval: 5 });
      return ServerMessage.parse(JSON.parse(inbox.shift()!));
    },
    /** Next message of `type`; presence updates are not under test and are skipped. */
    async receive<T extends ServerMessage['type']>(type: T) {
      for (;;) {
        await vi.waitFor(() => expect(inbox.length).toBeGreaterThan(0), { interval: 5 });
        const message = ServerMessage.parse(JSON.parse(inbox.shift()!));
        if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
        expect(message.type).toBe('peer.status');
      }
    },
  };
}

test('a phone action updates both roles with monotonic stateVersion and role-only events', async () => {
  const dispatch = vi.fn(() => ({ ok: true, minutesSpent: 1, events: [] }));
  const sessions = new SessionManager(
    { create: () => ({ investigation: tinyManor(), ports: { startLocationId: 'loc_hall' } }) },
    { createEngine: () => ({ dispatch }) },
  );
  const session = await sessions.create('tiny-manor', 'views');
  await session.activate();
  const projected: string[] = [];
  const gateway = new SessionGateway({
    serverVersion: '0.0.0',
    sessions,
    snapshot: (_session, role) => {
      projected.push(`${role}:${session.stateVersion}`);
      return role === 'desktop' ? playerView : phoneView;
    },
    events: (_session, role) => (role === 'phone' ? [{ type: 'incomingCall', callId: 'c1' }] : []),
  });
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), { gateway });
  apps.push(app);
  const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(/^http:/, 'ws:');

  const desktop = await client(address);
  desktop.send({
    type: 'hello',
    payload: { role: 'desktop', token: issueToken(session, 'desktop'), appVersion: '1' },
  });
  await desktop.receive('welcome');
  expect((await desktop.receive('view.update')).payload.stateVersion).toBe(0);
  const phone = await client(address);
  phone.send({
    type: 'hello',
    payload: { role: 'phone', token: issueToken(session, 'phone'), appVersion: '1' },
  });
  await phone.receive('welcome');
  expect((await phone.receive('view.update')).payload.view).toEqual(phoneView);

  const versions: number[] = [];
  for (const expected of [1, 2]) {
    phone.send({ type: 'action.request', payload: { action: { type: 'addNote', text: 'n' } } });
    expect((await phone.receive('action.result')).payload.ok).toBe(true);
    const own = await phone.receive('view.update');
    expect(own.payload).toMatchObject({ stateVersion: expected, view: phoneView });
    expect((await phone.receive('event')).payload.event).toEqual({
      type: 'incomingCall',
      callId: 'c1',
    });
    const other = await desktop.receive('view.update');
    expect(other.payload).toMatchObject({ stateVersion: expected, view: playerView });
    versions.push(other.payload.stateVersion);
  }
  expect(versions).toEqual([1, 2]);
  expect(dispatch).toHaveBeenCalledTimes(2);
  // Exactly one projection per role and version, each taken at the version it is labelled with.
  expect(projected).toEqual([
    'desktop:0',
    'phone:0',
    'desktop:1',
    'phone:1',
    'desktop:2',
    'phone:2',
  ]);
});

test('concurrent desktop and phone actions give each role strictly increasing versions', async () => {
  // An async engine: the dispatch of one role is still running when the other one is queued.
  const dispatch = vi.fn(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return { ok: true, minutesSpent: 1, events: [] };
  });
  const sessions = new SessionManager(
    { create: () => ({ investigation: tinyManor(), ports: { startLocationId: 'loc_hall' } }) },
    { createEngine: () => ({ dispatch }) },
  );
  const session = await sessions.create('tiny-manor', 'views-race');
  await session.activate();
  const seen: number[] = [];
  const gateway = new SessionGateway({
    serverVersion: '0.0.0',
    sessions,
    snapshot: (_session, role) => {
      seen.push(session.stateVersion);
      return role === 'desktop' ? playerView : phoneView;
    },
  });
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), { gateway });
  apps.push(app);
  const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(/^http:/, 'ws:');
  const desktop = await client(address);
  desktop.send({
    type: 'hello',
    payload: { role: 'desktop', token: issueToken(session, 'desktop'), appVersion: '1' },
  });
  const phone = await client(address);
  phone.send({
    type: 'hello',
    payload: { role: 'phone', token: issueToken(session, 'phone'), appVersion: '1' },
  });
  for (const c of [desktop, phone]) {
    await c.receive('welcome');
    await c.receive('view.update');
  }

  desktop.send({ type: 'action.request', payload: { action: { type: 'wait', minutes: 5 } } });
  phone.send({ type: 'action.request', payload: { action: { type: 'addNote', text: 'n' } } });
  for (const c of [desktop, phone]) {
    // Order between a role's own result and the other role's view is not fixed; collect both.
    const versions: number[] = [];
    let result: boolean | undefined;
    while (result === undefined || versions.at(-1) !== 2) {
      const message = await c.any();
      if (message.type === 'action.result') result = message.payload.ok;
      else if (message.type === 'view.update') versions.push(message.payload.stateVersion);
    }
    expect(result).toBe(true);
    expect(versions.every((v, i) => i === 0 || v > versions[i - 1]!)).toBe(true);
  }
  expect(session.stateVersion).toBe(2);
  expect(dispatch).toHaveBeenCalledTimes(2);
  // A projection is never taken from a state other than the version it is published under.
  expect(seen.every((v) => v === 0 || v === 1 || v === 2)).toBe(true);
});

test('ViewCache serves a version once and never caches a view taken while the state moved', () => {
  const session = { stateVersion: 1 } as Session;
  let calls = 0;
  let moveOnNext = false;
  const cache = new ViewCache(() => {
    calls++;
    if (moveOnNext) (session as { stateVersion: number }).stateVersion++;
    return playerView;
  });
  expect(cache.get(session, 'desktop')).toBe(playerView);
  expect(cache.get(session, 'desktop')).toBe(playerView);
  expect(calls).toBe(1);
  expect(cache.get(session, 'desktop', 0)).toBeUndefined();
  moveOnNext = true;
  (session as { stateVersion: number }).stateVersion = 2;
  expect(cache.get(session, 'desktop')).toBeUndefined();
  expect(calls).toBe(2);
  moveOnNext = false;
  expect(cache.get(session, 'desktop')).toBe(playerView);
  expect(calls).toBe(3);
});

function realCase() {
  const content = loadScenarioFromDir(`${defaultScenariosDir()}sanatorium_winter`);
  const witness = tinyManorWitness();
  const investigation = tinyManor();
  investigation.truth.append({
    t: 1,
    duration: 0,
    verb: 'work',
    location: 'loc_archive',
    actorIds: ['ch_bursar'],
    targets: [],
    causes: [],
    facts: [
      { kind: 'at', who: 'ch_bursar', where: 'loc_archive', interval: { from: 1, to: 1440 } },
    ],
    traceIds: [],
    visibility: 'covert',
  });
  return {
    investigation,
    ports: {
      startLocationId: 'loc_archive',
      texts: new Map(Object.values(content.text.ru!).flatMap(Object.entries)),
      testimony: { witness: () => witness },
      phone: {
        initial: createPhoneState({
          contacts: [{ id: 'contact', name: 'Witness', number: '123' }],
          threads: [
            {
              id: 'thread',
              contactId: 'contact',
              messages: [],
              availableReplies: [{ id: 'ask', text: 'Question' }],
            },
          ],
          files: [
            {
              id: 'secret',
              name: 'Secret',
              hidden: true,
              locked: true,
              password: 'secret-password',
              content: 'hidden-content',
            },
          ],
        }),
        messageReply: () => ({ delayMinutes: 0, text: 'Reply' }),
      },
    },
  };
}

test('default gateway sends real role views, Russian testimony and phone-only notifications', async () => {
  const sessions = new SessionManager({ create: realCase });
  const session = await sessions.create('tiny-manor', 'real-views');
  await session.activate();
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
    gateway: new SessionGateway({ sessions, serverVersion: '1' }),
  });
  apps.push(app);
  const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(/^http:/, 'ws:');
  const desktop = await client(address);
  const phone = await client(address);
  for (const [role, c] of [
    ['desktop', desktop],
    ['phone', phone],
  ] as const) {
    c.send({ type: 'hello', payload: { role, token: issueToken(session, role), appVersion: '1' } });
    await c.receive('welcome');
    const view = (await c.receive('view.update')).payload.view;
    expect(view).toEqual(
      role === 'desktop' ? session.engine.playerView!() : session.engine.phoneView!(),
    );
    const json = JSON.stringify(view);
    for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}"`);
    expect(json).not.toContain('secret-password');
    expect(json).not.toContain('hidden-content');
  }
  desktop.send({
    type: 'action.request',
    payload: { action: { type: 'talk', characterId: 'ch_bursar', topicId: 'where:-60:0' } },
  });
  expect((await desktop.receive('action.result')).payload.ok).toBe(true);
  const talk = PlayerView.parse((await desktop.receive('view.update')).payload.view);
  const text = talk.interaction!.history.at(-1)!.text;
  expect(text).toMatch(/[\u0400-\u04ff]/);
  expect(text).not.toMatch(/testimony_|\{.*\}/);
  await phone.receive('view.update');
  phone.send({
    type: 'action.request',
    payload: { action: { type: 'message', contactId: 'contact', templateId: 'ask' } },
  });
  expect((await phone.receive('action.result')).payload.ok).toBe(true);
  await phone.receive('view.update');
  await desktop.receive('view.update');
  phone.send({
    type: 'action.request',
    payload: { action: { type: 'addNote', text: 'Remember' } },
  });
  expect((await phone.receive('action.result')).payload.ok).toBe(true);
  const reply = PhoneView.parse((await phone.receive('view.update')).payload.view);
  const notification = reply.notifications.at(-1)!;
  expect(notification.text).toBe('Reply');
  expect((await phone.receive('event')).payload.event).toEqual({
    type: 'notification',
    notificationId: notification.id,
  });
  await desktop.receive('view.update');
  // Pong is a queue barrier: a wrongly routed phone event would arrive before it.
  desktop.send({ type: 'ping', payload: {} });
  await desktop.receive('pong');
});

test('event allowlist checks real projections and never copies raw payloads', () => {
  const { investigation, ports } = realCase();
  const notification = {
    id: 'n',
    appId: 'messages',
    title: 'Call',
    text: 'Answer',
    at: 0,
    read: false,
    hallucination: true,
  };
  const call = {
    callId: 'c',
    contactId: 'contact',
    state: 'ringing' as const,
    startedAt: 0,
    lines: [],
    choices: [],
  };
  const engine = GameEngine.create(investigation, {
    ...ports,
    phone: { initial: createPhoneState({ notifications: [notification], activeCall: call }) },
  });
  const batch = {
    events: [
      { type: 'NotificationPosted', notification },
      { type: 'CallStarted', call },
      { type: 'NotificationPosted', notification: { id: 'invisible' } },
      { type: 'CallStarted', call: { callId: 'invisible' } },
      { type: 'EvidenceCaptured', clueId: 'uncollected' },
      { type: 'StatementHeard', truth: 'server-secret' },
      { type: 'gameOver', culpritIds: ['ch_bursar'] },
      null,
    ],
  };
  expect(engineEvents(new Session('test', engine, () => 0), 'desktop', batch)).toEqual([]);
  expect(engineEvents(new Session('test', engine, () => 0), 'phone', batch)).toEqual([
    { type: 'notification', notificationId: 'n' },
    { type: 'incomingCall', callId: 'c' },
  ]);
  const active = GameEngine.create(investigation, {
    ...ports,
    phone: { initial: createPhoneState({ activeCall: { ...call, state: 'active' } }) },
  });
  expect(engineEvents(new Session('active', active, () => 0), 'phone', batch)).toEqual([]);
});

test('scan result refers only to evidence actually captured in the real engine', () => {
  const investigation = tinyManorWithClues();
  const engine = GameEngine.create(investigation, {
    startLocationId: 'loc_study',
    clues: investigation.clues,
    phone: { initial: createPhoneState() },
    evidenceTokens: { issue: () => 'token', revoke: () => undefined },
  });
  const session = new Session('capture', engine, () => 0);
  expect(engine.dispatch('desktop', { type: 'read', documentId: 'ledger_note' }).ok).toBe(true);
  const clueId = investigation.clues[0]!.id;
  expect(
    engineEvents(session, 'phone', { events: [{ type: 'EvidenceCaptured', clueId }] }),
  ).toEqual([]);
  const captured = engine.dispatch('phone', { type: 'captureEvidence', tokenId: 'token' });
  expect(captured.ok).toBe(true);
  expect(engineEvents(session, 'phone', captured)).toEqual([
    { type: 'scanResult', ok: true, clueRef: clueId },
  ]);
  expect(engineEvents(session, 'desktop', captured)).toEqual([]);
});
