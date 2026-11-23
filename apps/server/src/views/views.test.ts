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
import { SessionManager } from '../sessions/index.ts';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';

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
  // One projection per role and version: the cache serves repeated reads of the same version.
  expect(new Set(projected).size).toBe(projected.length);
});
