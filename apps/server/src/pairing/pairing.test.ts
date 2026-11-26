import { PairResponse, PairingCodeResponse, PROTOCOL_VERSION } from '@hs/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { Session } from '../sessions/index.ts';
import { issueToken, PairingService, verifyToken } from './index.ts';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  let now = 1_000_000;
  const clock = () => now;
  const session = new Session('test-session', {
    dispatch: () => ({ ok: false, error: 'INTERNAL', minutesSpent: 0, events: [] }),
  }, clock);
  const revoked = vi.fn();
  const service = new PairingService({ get: (id) => id === session.id ? session : undefined }, {
    host: () => 'game-pc.local', port: 7420, now: clock, onDeviceRevoked: revoked,
  });
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), { pairing: service });
  apps.push(app);
  const headers = { authorization: 'Bearer ' + issueToken(session, 'desktop') };
  const url = '/api/v1/sessions/' + session.id;
  const createCode = () => app.inject({ method: 'POST', url: url + '/pairing-code', headers });
  const pair = (code: string, protocolVersion = PROTOCOL_VERSION, remoteAddress = '192.0.2.1') =>
    app.inject({
      method: 'POST', url: '/api/v1/pair', remoteAddress,
      payload: { code, deviceName: 'Phone', appVersion: '0.0.0', protocolVersion },
    });
  return { app, session, revoked, pair, createCode, url, headers, advance: (ms: number) => { now += ms; } };
}

test('pairs once, activates the session and revokes old device credentials', async () => {
  const { app, session, revoked, pair, createCode, url, headers } = setup();
  const issued = await createCode();
  expect(issued.statusCode).toBe(200);
  const { code, expiresAt, qrPayload } = PairingCodeResponse.parse(issued.json());
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  expect(expiresAt).toBe(1_300_000);
  expect(qrPayload).toBe(['hs1', 'pair', 'game-pc.local', 7420, code].join(':'));
  const replies = await Promise.all([pair(code), pair(code)]);
  expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 400]);
  const first = replies.find((reply) => reply.statusCode === 200)?.json<{ deviceToken: string }>();
  expect(PairResponse.safeParse(first).success).toBe(true);
  expect(first).toMatchObject({ sessionId: session.id, wsPath: '/ws' });
  expect(first?.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(session.status).toBe('active');
  expect(session.tokenHash('phone')).toMatch(/^[0-9a-f]{64}$/);
  expect(verifyToken(session, 'phone', first?.deviceToken ?? '')).toBe(true);
  expect(verifyToken(session, 'desktop', first?.deviceToken ?? '')).toBe(false);

  const second = (await pair((await createCode()).json<{ code: string }>().code)).json<{ deviceToken: string }>();
  expect(verifyToken(session, 'phone', first?.deviceToken ?? '')).toBe(false);
  expect(verifyToken(session, 'phone', second.deviceToken)).toBe(true);
  expect(revoked).toHaveBeenCalledExactlyOnceWith(session, 'DEVICE_REVOKED');
  expect((await app.inject({ method: 'DELETE', url: url + '/device', headers })).statusCode).toBe(204);
  expect(verifyToken(session, 'phone', second.deviceToken)).toBe(false);
  expect(revoked).toHaveBeenCalledTimes(2);
});

test('authorizes desktop routes and rejects replaced, expired and malformed codes', async () => {
  const { app, pair, createCode, url, advance } = setup();
  const unauthorized = await app.inject({ method: 'POST', url: url + '/pairing-code' });
  expect(unauthorized.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  const missing = await app.inject({ method: 'DELETE', url: '/api/v1/sessions/unknown/device' });
  expect(missing.json<{ error: { code: string } }>().error.code).toBe('SESSION_NOT_FOUND');
  const first = (await createCode()).json<{ code: string }>().code;
  const second = (await createCode()).json<{ code: string }>().code;
  expect((await pair(first)).json<{ error: { code: string } }>().error.code).toBe('PAIRING_CODE_INVALID');
  expect((await pair('bad')).json<{ error: { code: string } }>().error.code).toBe('PAIRING_CODE_INVALID');
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/pair', payload: { code: second } });
  expect(invalid.json<{ error: { code: string } }>().error.code).toBe('INVALID_MESSAGE');
  advance(300_000);
  expect((await pair(second)).json<{ error: { code: string } }>().error.code).toBe('PAIRING_CODE_EXPIRED');
});

test('limits IPs in a sliding window and invalidates a code after 20 attributable failures', async () => {
  const { pair, createCode, advance } = setup();
  const { code } = (await createCode()).json<{ code: string }>();
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await pair(code, 999)).json<{ error: { code: string } }>().error.code).toBe('PROTOCOL_MISMATCH');
  }
  const limited = await pair(code);
  expect(limited.statusCode).toBe(429);
  expect(limited.json<{ error: { code: string } }>().error.code).toBe('PAIRING_RATE_LIMITED');
  advance(60_000);
  for (let attempt = 5; attempt < 20; attempt++) {
    const ip = '192.0.2.' + (1 + Math.floor((attempt - 5) / 5));
    expect((await pair(code, 999, ip)).json<{ error: { code: string } }>().error.code).toBe('PROTOCOL_MISMATCH');
  }
  expect((await pair(code, PROTOCOL_VERSION, '192.0.2.4')).json<{ error: { code: string } }>().error.code)
    .toBe('PAIRING_CODE_INVALID');
});

test('discardCode from an old session leaves both indexes of its replacement intact', async () => {
  const { session: oldSession } = setup();
  const current = new Session(oldSession.id, oldSession.engine, () => 0);
  const service = new PairingService({ get: () => current }, {
    host: () => 'game-pc.local', port: 7420,
  });
  const oldCode = service.createCode(oldSession);
  const newCode = service.createCode(current);

  service.discardCode(oldSession);
  expect(service.activeCode(current)).toEqual(newCode);
  const body = { deviceName: 'Phone', appVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION };
  await expect(service.pair({ ...body, code: oldCode.code }, '127.0.0.1')).rejects.toMatchObject({
    code: 'PAIRING_CODE_INVALID',
  });
  await expect(service.pair({ ...body, code: newCode.code }, '127.0.0.1')).resolves.toMatchObject({
    sessionId: current.id,
  });
  expect(current.status).toBe('active');
  expect(oldSession.tokenHash('phone')).toBeUndefined();
});

test('createCode changes nothing when the host lookup throws; discardCode forgets the code', async () => {
  const session = new Session('atomic-session', {
    dispatch: () => ({ ok: false, error: 'INTERNAL', minutesSpent: 0, events: [] }),
  }, () => 0);
  let hostFails = false;
  const service = new PairingService({ get: () => session }, {
    host: () => {
      if (hostFails) throw new Error('no interface');
      return 'game-pc.local';
    },
    port: 7420,
  });
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), { pairing: service });
  apps.push(app);
  const pair = (code: string) => app.inject({
    method: 'POST', url: '/api/v1/pair',
    payload: { code, deviceName: 'Phone', appVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION },
  });

  const first = service.createCode(session);
  hostFails = true;
  expect(() => service.createCode(session)).toThrow('no interface');
  hostFails = false;
  // The failed call neither replaced nor removed the code the session already had.
  expect(service.activeCode(session)?.code).toBe(first.code);

  service.discardCode(session);
  expect(service.activeCode(session)).toBeUndefined();
  expect((await pair(first.code)).json()).toMatchObject({ error: { code: 'PAIRING_CODE_INVALID' } });
});
