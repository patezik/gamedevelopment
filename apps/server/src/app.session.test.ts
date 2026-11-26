import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  FORBIDDEN_VIEW_KEYS,
  PhoneView,
  PlayerView,
  ServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PlayerAction,
} from '@hs/protocol';
import QRCode from 'qrcode';
import WebSocket from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { buildApp } from './app.ts';
import { readConfig } from './config/index.ts';
import { createSessionServices } from './routes/generation.ts';
import { CreateSessionResponse } from './routes/sessions.ts';
import { renderMatrix } from './qr/index.ts';

const apps: ReturnType<typeof buildApp>[] = [];
const sockets = new Set<WebSocket>();
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function publicOnly(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of [
    ...FORBIDDEN_VIEW_KEYS,
    'liePolicies',
    'requiredClueIds',
    'sourceEventId',
    'server',
    'knowledge',
  ]) {
    expect(json).not.toContain(`"${key}":`);
  }
}

async function client(base: string, role: 'desktop' | 'phone', token: string) {
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  sockets.add(socket);
  const inbox: ServerMessage[] = [];
  const history: ServerMessage[] = [];
  socket.on('message', (raw) => {
    if (!Buffer.isBuffer(raw)) throw new Error('Expected a text frame');
    const message = ServerMessage.parse(JSON.parse(raw.toString('utf8')));
    inbox.push(message);
    history.push(message);
  });
  await once(socket, 'open');
  const send = (message: Omit<ClientMessage, 'v' | 'id'>) =>
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...message }));
  const next = async <T extends ServerMessage['type']>(type: T) => {
    await vi.waitFor(() => expect(inbox.some((m) => m.type === type)).toBe(true), { interval: 5 });
    const index = inbox.findIndex((m) => m.type === type);
    return inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
  };
  send({ type: 'hello', payload: { role, token, appVersion: '0.0.0' } });
  const welcome = await next('welcome');
  return { send, next, history, welcome };
}

test('production factory: create, pair, inspect and scan a real generated clue updates both roles once', async () => {
  const config = readConfig({ HS_LOG_LEVEL: 'silent', HS_HOST: '127.0.0.1' });
  const services = createSessionServices(config);
  const app = buildApp(config, services);
  apps.push(app);
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const create = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { scenarioId: 'sanatorium_winter', seed: '2' },
    });
    expect(response.statusCode).toBe(201);
    publicOnly(response.json());
    return CreateSessionResponse.parse(response.json());
  };
  const pair = async (code: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: {
        code,
        deviceName: 'Integration phone',
        appVersion: '0.0.0',
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ sessionId: string; deviceToken: string }>();
  };
  const a = await create();
  const initialPairingMatrix = await app.inject({
    url: `/api/v1/sessions/${a.sessionId}/pairing-qr`,
    headers: { authorization: `Bearer ${a.desktopToken}` },
  });
  expect(initialPairingMatrix.statusCode).toBe(200);
  expect(initialPairingMatrix.json()).toEqual(renderMatrix(a.pairing.qrPayload));
  const pairA = await pair(a.pairing.code);
  const desktop = await client(base, 'desktop', a.desktopToken);
  const phone = await client(base, 'phone', pairA.deviceToken);
  expect(desktop.welcome.payload).toMatchObject({ sessionId: a.sessionId, role: 'desktop' });
  expect(phone.welcome.payload).toMatchObject({ sessionId: a.sessionId, role: 'phone' });
  let view = PlayerView.parse((await desktop.next('view.update')).payload.view);
  const initialPhone = PhoneView.parse((await phone.next('view.update')).payload.view);
  expect(view.location.id).toBe('loc_hall');
  expect(initialPhone.files.length).toBeGreaterThan(0);
  const action = async (input: PlayerAction) => {
    desktop.send({ type: 'action.request', payload: { action: input } });
    expect((await desktop.next('action.result')).payload.ok).toBe(true);
    const own = await desktop.next('view.update');
    const other = await phone.next('view.update');
    expect(own.payload.stateVersion).toBe(other.payload.stateVersion);
    view = PlayerView.parse(own.payload.view);
  };
  const matrixSpy = vi.spyOn(QRCode, 'create');
  const authorization = { authorization: `Bearer ${a.desktopToken}` };
  const pairingMatrix = await app.inject({
    url: `/api/v1/sessions/${a.sessionId}/pairing-qr`,
    headers: authorization,
  });
  // The consumed pairing code is no longer available after pairing.
  expect(pairingMatrix.statusCode).toBe(404);
  await action({ type: 'move', locationId: 'loc_doctor_office' });
  await action({ type: 'examineLocation' });
  expect(view.location.hotspots.some(({ id }) => id === 'missing_substance')).toBe(true);
  await action({ type: 'examineHotspot', hotspotId: 'missing_substance' });
  const pending = view.pendingCapture!;
  expect(pending).toBeDefined();
  const url = `/api/v1/sessions/${a.sessionId}/evidence-qr/${pending.tokenId}`;
  const matrix = await app.inject({ url, headers: authorization });
  expect(matrix.statusCode).toBe(200);
  expect(matrix.headers['cache-control']).toBe('no-store');
  const raw = matrixSpy.mock.calls.at(-1)![0];
  if (typeof raw !== 'string') throw new Error('Expected QR text');
  expect(raw).toMatch(/^hs1:ev:/);
  expect(matrix.json()).toEqual(renderMatrix(raw));
  expect(
    (await app.inject({ url, headers: { authorization: `Bearer ${pairA.deviceToken}` } }))
      .statusCode,
  ).toBe(401);
  // A second real case has a different token store, even for the same seed.
  const b = await create();
  const pairB = await pair(b.pairing.code);
  const otherPhone = await client(base, 'phone', pairB.deviceToken);
  await otherPhone.next('view.update');
  otherPhone.send({ type: 'qr.scan', payload: { raw } });
  expect((await otherPhone.next('qr.result')).payload).toEqual({
    ok: false,
    error: 'QR_WRONG_SESSION',
  });
  const otherSession = services.sessions.sessions.get(b.sessionId)!;
  expect(otherSession.stateVersion).toBe(0);
  const versionBefore = services.sessions.sessions.get(a.sessionId)!.stateVersion;
  for (const c of [desktop, phone]) {
    c.send({
      type: 'action.request',
      payload: { action: { type: 'captureEvidence', tokenId: pending.tokenId } },
    });
    expect((await c.next('action.result')).payload).toMatchObject({
      ok: false,
      error: 'ACTION_INVALID',
    });
  }
  desktop.send({ type: 'qr.scan', payload: { raw } });
  expect((await desktop.next('error')).payload.code).toBe('ACTION_INVALID');
  expect(services.sessions.sessions.get(a.sessionId)!.stateVersion).toBe(versionBefore);
  const beforeMinute = view.clock.t;
  phone.send({ type: 'qr.scan', payload: { raw } });
  expect((await phone.next('qr.result')).payload.ok).toBe(true);
  const capturedDesktop = await desktop.next('view.update');
  const capturedPhone = await phone.next('view.update');
  expect(capturedDesktop.payload.stateVersion).toBe(versionBefore + 1);
  expect(capturedPhone.payload.stateVersion).toBe(versionBefore + 1);
  const player = PlayerView.parse(capturedDesktop.payload.view);
  const device = PhoneView.parse(capturedPhone.payload.view);
  expect(player.pendingCapture).toBeUndefined();
  expect(player.clock.t - beforeMinute).toBe(2);
  expect(device.gallery.length).toBe(initialPhone.gallery.length + 1);
  const scanEvent = (await phone.next('event')).payload.event;
  expect(scanEvent).toMatchObject({ type: 'scanResult', ok: true });
  if (scanEvent.type !== 'scanResult' || !scanEvent.clueRef)
    throw new Error('No captured clue reference');
  expect(player.caseBoard.clues).toContainEqual(
    expect.objectContaining({ id: scanEvent.clueRef, captured: true }),
  );
  expect(device.gallery.some(({ imageRef }) => imageRef === `capture_${scanEvent.clueRef}`)).toBe(
    true,
  );
  expect(desktop.history.filter((m) => m.type === 'event')).toEqual([]);
  const count = desktop.history.filter((m) => m.type === 'view.update').length;
  const phoneCount = phone.history.filter((m) => m.type === 'view.update').length;
  phone.send({ type: 'qr.scan', payload: { raw } });
  expect((await phone.next('qr.result')).payload).toMatchObject({
    ok: false,
    error: 'QR_ALREADY_USED',
  });
  for (const c of [desktop, phone]) {
    c.send({ type: 'ping', payload: {} });
    await c.next('pong');
    for (const message of c.history) publicOnly(message);
  }
  expect(desktop.history.filter((m) => m.type === 'view.update')).toHaveLength(count);
  expect(phone.history.filter((m) => m.type === 'view.update')).toHaveLength(phoneCount);
  expect(services.sessions.sessions.get(a.sessionId)!.stateVersion).toBe(versionBefore + 1);
  expect((await app.inject({ url, headers: authorization })).statusCode).toBe(409);
  expect(otherSession.stateVersion).toBe(0);
}, 20_000);

test('native server process exposes generated sessions and authenticates their desktop token', async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HS_HOST: '127.0.0.1',
    HS_PORT: String(address.port),
    HS_LOG_LEVEL: 'silent',
  };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    logs += String(chunk);
  });
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await vi.waitFor(
      async () => {
        expect(child.exitCode, logs).toBeNull();
        expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
      },
      { timeout: 10_000, interval: 50 },
    );
    const response = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'sanatorium_winter', seed: '2' }),
    });
    expect(response.status).toBe(201);
    const created = CreateSessionResponse.parse(await response.json());
    const desktop = await client(base, 'desktop', created.desktopToken);
    expect(desktop.welcome.payload.sessionId).toBe(created.sessionId);
    const view = await desktop.next('view.update');
    expect(PlayerView.parse(view.payload.view).location.id).toBe('loc_hall');
    publicOnly(view);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
}, 20_000);
