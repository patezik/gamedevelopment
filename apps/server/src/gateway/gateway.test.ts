import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { PlayerView, PROTOCOL_VERSION, ServerMessage, type ClientMessage } from '@hs/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { issueToken, PairingService } from '../pairing/index.ts';
import { SessionManager } from '../sessions/index.ts';
import { SessionGateway, type GatewayOptions } from './index.ts';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';

const view = PlayerView.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../../packages/protocol/fixtures/views/player-view.start.json', import.meta.url),
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
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), { pairing, gateway });
  apps.push(app);
  const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(/^http:/, 'ws:');
  return { app, address, dispatch, gateway, session, desktopToken, pairing };
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
