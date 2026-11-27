import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import {
  PlayerAction,
  PlayerView,
  PROTOCOL_VERSION,
  ServerMessage,
  type ClientMessage,
} from '@hs/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { issueToken, PairingService } from '../pairing/index.ts';
import { QrService } from '../qr/index.ts';
import { SessionManager } from '../sessions/index.ts';
import { SessionGateway, type GatewayOptions } from './index.ts';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';

const view = PlayerView.parse(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/protocol/fixtures/views/player-view.start.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
);
const apps: ReturnType<typeof buildApp>[] = [];
const sockets = new Set<WebSocket>();
type Input<T = ClientMessage> = T extends ClientMessage
  ? Omit<T, 'v' | 'id'> & { id?: string }
  : never;
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(options: Partial<GatewayOptions> = {}) {
  const dispatch = vi.fn(() => ({ ok: true, minutesSpent: 15, events: [] }));
  const sessions = new SessionManager(
    {
      create: () => ({ investigation: tinyManor(), ports: { startLocationId: 'loc_hall' } }),
    },
    { createEngine: () => ({ dispatch }) },
  );
  const session = await sessions.create('tiny-manor', 'gateway');
  const desktopToken = issueToken(session, 'desktop');
  const pairing = new PairingService(sessions, { host: () => 'localhost', port: 7420 });
  const gateway = new SessionGateway({ serverVersion: '0.0.0', sessions, ...options });
  const qr = new QrService({ gameMinute: () => 0 });
  const store = qr.createStore();
  qr.attach(session, store);
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
    pairing,
    gateway,
    qr: {
      qr,
      authorizeDesktop: pairing.authorizeDesktop.bind(pairing),
      activePairingCode: pairing.activeCode.bind(pairing),
    },
  });
  apps.push(app);
  const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(/^http:/, 'ws:');
  return { app, address, dispatch, gateway, session, desktopToken, pairing, store };
}

async function client(address: string) {
  const socket = new WebSocket(address + '/ws');
  sockets.add(socket);
  const inbox: string[] = [];
  socket.on('message', (data) => {
    if (Buffer.isBuffer(data)) inbox.push(data.toString('utf8'));
  });
  await once(socket, 'open');
  return {
    socket,
    send(message: Input) {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id: 'request', ...message }));
    },
    async receive<T extends ServerMessage['type']>(type: T) {
      await vi.waitFor(() => expect(inbox.length).toBeGreaterThan(0), { interval: 5 });
      const message = ServerMessage.parse(JSON.parse(inbox.shift()!));
      expect(message.type).toBe(type);
      return message as Extract<ServerMessage, { type: T }>;
    },
    /** The next message of this type; others before it are skipped. */
    async until<T extends ServerMessage['type']>(type: T) {
      for (;;) {
        await vi.waitFor(() => expect(inbox.length).toBeGreaterThan(0), { interval: 5 });
        const message = ServerMessage.parse(JSON.parse(inbox.shift()!));
        if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
      }
    },
    async close() {
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    },
  };
}

test('real pairing notifies both clients and authenticates action roles', async () => {
  const { app, address, dispatch, session, desktopToken, pairing } = await setup();
  const desktop = await client(address);
  desktop.send({
    type: 'hello',
    payload: { role: 'desktop', token: desktopToken, appVersion: '1' },
  });
  expect((await desktop.receive('welcome')).payload).toMatchObject({
    role: 'desktop',
    sessionId: session.id,
  });
  expect((await desktop.receive('peer.status')).payload.phone).toBe('unpaired');

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    payload: {
      code: pairing.createCode(session).code,
      deviceName: 'Phone',
      appVersion: '1',
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  expect(response.statusCode).toBe(200);
  const phone = await client(address);
  phone.send({
    type: 'hello',
    payload: {
      role: 'phone',
      token: response.json<{ deviceToken: string }>().deviceToken,
      appVersion: '1',
    },
  });
  await phone.receive('welcome');
  expect((await phone.receive('peer.status')).payload.phone).toBe('online');
  expect((await desktop.receive('peer.status')).payload.phone).toBe('online');

  const action = { type: 'wait', minutes: 15 } as const;
  phone.send({ type: 'action.request', payload: { action } });
  expect((await phone.receive('action.result')).payload.error).toBe('ACTION_INVALID');
  desktop.send({ type: 'action.request', payload: { action } });
  expect((await desktop.receive('action.result')).payload).toMatchObject({
    ok: true,
    requestId: 'request',
  });
  expect(dispatch).toHaveBeenCalledTimes(1);

  const phoneClosed = once(phone.socket, 'close');
  pairing.revokeDevice(session);
  expect((await phone.receive('error')).payload.code).toBe('DEVICE_REVOKED');
  await phoneClosed;
  expect((await desktop.receive('peer.status')).payload.phone).toBe('unpaired');
});

test('the phone unpairs itself over REST: socket closed, desktop sees unpaired, token dead', async () => {
  const { app, address, session, desktopToken } = await setup();
  await session.activate();
  const token = issueToken(session, 'phone');
  const desktop = await client(address);
  desktop.send({ type: 'hello', payload: { role: 'desktop', token: desktopToken, appVersion: '1' } });
  await desktop.until('welcome');
  const phone = await client(address);
  phone.send({ type: 'hello', payload: { role: 'phone', token, appVersion: '1' } });
  await phone.receive('welcome');
  await vi.waitFor(async () => {
    expect((await desktop.until('peer.status')).payload.phone).toBe('online');
  });

  const phoneClosed = once(phone.socket, 'close');
  const url = '/api/v1/sessions/' + session.id + '/device';
  const reply = await app.inject({ method: 'DELETE', url, headers: { authorization: 'Bearer ' + token } });
  expect(reply.statusCode).toBe(204);
  await phoneClosed;
  expect((await desktop.until('peer.status')).payload.phone).toBe('unpaired');
  const again = await app.inject({ method: 'DELETE', url, headers: { authorization: 'Bearer ' + token } });
  expect(again.statusCode).toBe(401);
});

test('routes a phone scan through the configured QR service', async () => {
  const { address, session, store, dispatch } = await setup();
  await session.activate();
  const token = issueToken(session, 'phone');
  const phone = await client(address);
  phone.send({ type: 'hello', payload: { role: 'phone', token, appVersion: '1' } });
  await phone.receive('welcome');
  await phone.receive('peer.status');
  const tokenId = store.issue('clue', 120);
  phone.send({ type: 'qr.scan', payload: { raw: store.payload(tokenId) } });
  expect((await phone.receive('qr.result')).payload).toEqual({ ok: true, clueRef: 'clue' });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('phone', { type: 'captureEvidence', tokenId });
});

test('resume replays only role messages, a truncated buffer triggers resync and a fresh view', async () => {
  const { address, gateway, session, desktopToken } = await setup({
    replayLimit: 2,
    snapshot: () => view,
  });
  const hello = { role: 'desktop', token: desktopToken, appVersion: '1' } as const;
  const first = await client(address);
  first.send({ type: 'hello', payload: hello });
  await first.receive('welcome');
  const initial = await first.receive('view.update');
  await first.receive('peer.status');
  await first.close();
  gateway.publishEvent(session, 'phone', { type: 'incomingCall', callId: 'phone-only' });
  gateway.publishEvent(session, 'desktop', { type: 'gameOver' });

  const second = await client(address);
  second.send({
    type: 'hello',
    payload: { ...hello, resume: { lastSeq: initial.seq!, stateVersion: 0 } },
  });
  await second.receive('welcome');
  const replayed = await second.receive('event');
  expect(replayed.payload.event).toEqual({ type: 'gameOver' });
  await second.receive('peer.status');
  second.send({ type: 'ping', ack: replayed.seq!, payload: {} });
  await second.receive('pong');
  await second.close();

  gateway.publishEvent(session, 'desktop', { type: 'gameOver' });
  gateway.publishEvent(session, 'desktop', { type: 'gameOver' });
  const third = await client(address);
  third.send({
    type: 'hello',
    payload: { ...hello, resume: { lastSeq: initial.seq!, stateVersion: 0 } },
  });
  await third.receive('welcome');
  await third.receive('resync');
  expect((await third.receive('view.update')).payload.view).toEqual(view);
});

test('rejects pre-hello messages, role mismatches, invalid frames and URL credentials', async () => {
  const { address, desktopToken } = await setup();
  const preHello = await client(address);
  preHello.send({ type: 'ping', payload: {} });
  expect((await preHello.receive('error')).payload.code).toBe('UNAUTHORIZED');

  const invalid = await client(address);
  invalid.socket.send('{');
  expect((await invalid.receive('error')).payload.code).toBe('INVALID_MESSAGE');
  invalid.send({ type: 'hello', payload: { role: 'phone', token: desktopToken, appVersion: '1' } });
  expect((await invalid.receive('error')).payload.code).toBe('UNAUTHORIZED');

  const mismatch = await client(address);
  mismatch.socket.send(JSON.stringify({ v: 99, id: 'other', type: 'hello', payload: {} }));
  expect((await mismatch.receive('error')).payload.code).toBe('PROTOCOL_MISMATCH');

  const wrongUrl = new WebSocket(address + '/ws?token=' + desktopToken);
  sockets.add(wrongUrl);
  const error = await new Promise<Error>((resolve) => wrongUrl.once('error', resolve));
  expect(error.message).toContain('400');
});

test('closes silent sockets at the handshake and heartbeat deadlines', async () => {
  const { address, desktopToken } = await setup({ helloMs: 150, heartbeatMs: 150 });
  const silent = await client(address);
  const helloReason = await new Promise<Buffer>((resolve) =>
    silent.socket.once('close', (_code, reason) => resolve(reason)),
  );
  expect(helloReason.toString()).toBe('HELLO_TIMEOUT');

  const connected = await client(address);
  const closed = new Promise<Buffer>((resolve) =>
    connected.socket.once('close', (_code, reason) => resolve(reason)),
  );
  connected.send({
    type: 'hello',
    payload: { role: 'desktop', token: desktopToken, appVersion: '1' },
  });
  await connected.receive('welcome');
  const idleReason = await closed;
  expect(idleReason.toString()).toBe('HEARTBEAT_TIMEOUT');
});

type Accuse = Extract<PlayerAction, { type: 'accuse' }>;
const accuse = (operationId: string, accusedId = 'ch_a'): Accuse => ({
  type: 'accuse',
  caseFile: { accusedIds: [accusedId], evidence: [] },
  confirm: true,
  operationId,
});

async function login(address: string, token: string, resume?: { lastSeq: number }) {
  const desktop = await client(address);
  desktop.send({
    type: 'hello',
    payload: {
      role: 'desktop',
      token,
      appVersion: '1',
      ...(resume && { resume: { ...resume, stateVersion: 0 } }),
    },
  });
  await desktop.receive('welcome');
  return desktop;
}

test('a lost accusation result is recovered by a retry with the same operation ID, run once', async () => {
  const { address, dispatch, desktopToken, session } = await setup({ snapshot: () => view });
  await session.activate();
  const first = await login(address, desktopToken);
  first.send({ type: 'action.request', id: 'try-1', payload: { action: accuse('op-1') } });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  first.socket.terminate();

  // The history is gone (resume_unavailable): the outcome still comes from the stored operation.
  const second = await login(address, desktopToken, { lastSeq: 9999 });
  second.send({ type: 'action.request', id: 'try-2', payload: { action: accuse('op-1') } });
  const result = await second.until('action.result');
  expect(result.payload).toMatchObject({
    requestId: 'try-2',
    ok: true,
    operationId: 'op-1',
  });
  expect(result.payload.stateVersion).toBeGreaterThan(0);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('a retry of an accusation in flight waits for it and does not execute it again', async () => {
  const { address, dispatch, desktopToken, session } = await setup();
  await session.activate();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  dispatch.mockImplementationOnce((async () => {
    await gate;
    return { ok: true, minutesSpent: 0, events: [] };
  }) as never);
  const first = await login(address, desktopToken);
  first.send({ type: 'action.request', id: 'try-1', payload: { action: accuse('op-2') } });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  // The replacing connection starts while the first request still runs (its hello waits for it).
  const joining = login(address, desktopToken);
  setTimeout(release, 50);
  const second = await joining;
  second.send({ type: 'action.request', id: 'try-2', payload: { action: accuse('op-2') } });
  const result = await second.until('action.result');
  expect(result.payload).toMatchObject({ requestId: 'try-2', ok: true, operationId: 'op-2' });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('the same operation ID with another case file is refused and nothing runs', async () => {
  const { address, dispatch, desktopToken, session } = await setup();
  await session.activate();
  const desktop = await login(address, desktopToken);
  desktop.send({ type: 'action.request', id: 'a', payload: { action: accuse('op-3') } });
  desktop.send({ type: 'action.request', id: 'b', payload: { action: accuse('op-3', 'ch_b') } });
  desktop.send({
    type: 'action.request',
    id: 'c',
    payload: { action: { ...accuse('op-3'), caseFile: { evidence: [], accusedIds: ['ch_a'] } } },
  });
  const results = new Map<string, unknown>();
  while (results.size < 3) {
    const message = await desktop.until('action.result');
    results.set(message.payload.requestId, message.payload);
  }
  expect(results.get('a')).toMatchObject({ ok: true });
  expect(results.get('b')).toMatchObject({ ok: false, error: 'ACTION_INVALID' });
  expect(results.get('c')).toMatchObject({ ok: true, operationId: 'op-3' });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('a confirmed accusation without an operation ID is refused and nothing runs', async () => {
  const { address, dispatch, desktopToken, session } = await setup();
  await session.activate();
  const desktop = await login(address, desktopToken);
  const bare = { ...accuse('op-4'), operationId: undefined };
  desktop.send({ type: 'action.request', payload: { action: bare } });
  const message = await desktop.until('action.result');
  expect(message.payload).toMatchObject({ ok: false, error: 'ACTION_INVALID' });
  expect(dispatch).not.toHaveBeenCalled();
});
