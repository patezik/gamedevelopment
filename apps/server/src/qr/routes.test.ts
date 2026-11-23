import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { issueToken, PairingService } from '../pairing/index.ts';
import { Session } from '../sessions/index.ts';
import { renderMatrix } from './matrix.ts';
import { QrService } from './service.ts';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  let wall = 1_000_000;
  let minute = 10;
  const session = new Session(
    'session-a',
    { dispatch: () => ({ ok: true, minutesSpent: 2, events: [] }) },
    () => wall,
  );
  await session.activate();
  const sessions = { get: (id: string) => (id === session.id ? session : undefined) };
  const pairing = new PairingService(sessions, {
    host: () => 'game-pc.local',
    port: 7420,
    now: () => wall,
  });
  const qr = new QrService({ gameMinute: () => minute });
  const store = qr.createStore({ secret: Buffer.alloc(32, 5) });
  qr.attach(session, store);
  const tokenId = store.issue('clue_ledger', 100);

  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
    pairing,
    qr: {
      qr,
      authorizeDesktop: (id, authorization) => pairing.authorizeDesktop(id, authorization),
      activePairingCode: (s) => pairing.activeCode(s),
      now: () => wall,
    },
  });
  apps.push(app);
  const desktop = { authorization: `Bearer ${issueToken(session, 'desktop')}` };
  const phone = { authorization: `Bearer ${issueToken(session, 'phone')}` };
  const base = `/api/v1/sessions/${session.id}`;
  return {
    app,
    session,
    qr,
    store,
    tokenId,
    desktop,
    phone,
    base,
    advanceWall: (ms: number) => {
      wall += ms;
    },
    setMinute: (m: number) => {
      minute = m;
    },
    get: (path: string, headers: Record<string, string> = desktop) =>
      app.inject({ method: 'GET', url: `${base}${path}`, headers }),
    newPairingCode: () =>
      app.inject({ method: 'POST', url: `${base}/pairing-code`, headers: desktop }),
  };
}

describe('GET evidence-qr/:tokenId', () => {
  it('returns the matrix of the signed payload, and tells caches to forget it', async () => {
    const { get, tokenId, store } = await setup();
    const reply = await get(`/evidence-qr/${tokenId}`);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json()).toEqual(renderMatrix(store.payload(tokenId)));
    expect(Object.keys(reply.json<object>()).sort()).toEqual(['modules', 'size']);
  });

  it('never puts the token, signature or secret in the response', async () => {
    const { get, tokenId, store } = await setup();
    const body = (await get(`/evidence-qr/${tokenId}`)).body;
    expect(body).not.toContain(tokenId);
    expect(body).not.toContain(store.payload(tokenId).split(':')[4] ?? 'x');
    expect(body).toMatch(/^\{"size":\d+,"modules":"[01]+"\}$/);
  });

  it.each<[string, string, number, string]>([
    ['an unknown token', 'ZZZZZZZZZZZZZZZZ', 404, 'QR_INVALID'],
    ['a malformed token id', 'nope', 404, 'QR_INVALID'],
  ])('answers %s with %i %s', async (_name, id, status, code) => {
    const { get } = await setup();
    const reply = await get(`/evidence-qr/${id}`);
    expect(reply.statusCode).toBe(status);
    const { error } = reply.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(0);
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('answers an expired token with 410 QR_EXPIRED', async () => {
    const { get, tokenId, setMinute } = await setup();
    setMinute(100);
    const reply = await get(`/evidence-qr/${tokenId}`);
    expect(reply.statusCode).toBe(410);
    expect(reply.json()).toMatchObject({ error: { code: 'QR_EXPIRED' } });
  });

  it('answers a captured clue with 409 QR_ALREADY_USED', async () => {
    const { get, tokenId, qr, session, store } = await setup();
    expect(await qr.scan(session, store.payload(tokenId))).toMatchObject({ ok: true });
    const reply = await get(`/evidence-qr/${tokenId}`);
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toMatchObject({ error: { code: 'QR_ALREADY_USED' } });
  });
});

describe('GET pairing-qr', () => {
  it('draws the current pairing code, without issuing a new one', async () => {
    const { get, newPairingCode } = await setup();
    const issued = (await newPairingCode()).json<{ code: string; qrPayload: string }>();
    const first = await get('/pairing-qr');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(renderMatrix(issued.qrPayload));
    expect(first.headers['cache-control']).toBe('no-store');
    expect((await get('/pairing-qr')).json()).toEqual(first.json()); // still the same code
  });

  it('shows the newest code after a refresh', async () => {
    const { get, newPairingCode } = await setup();
    await newPairingCode();
    const second = (await newPairingCode()).json<{ qrPayload: string }>();
    expect((await get('/pairing-qr')).json()).toEqual(renderMatrix(second.qrPayload));
  });

  it('is 404 PAIRING_CODE_INVALID before any code exists', async () => {
    const { get } = await setup();
    const reply = await get('/pairing-qr');
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toMatchObject({ error: { code: 'PAIRING_CODE_INVALID' } });
  });

  it('is 410 PAIRING_CODE_EXPIRED once the code has run out', async () => {
    const { get, newPairingCode, advanceWall } = await setup();
    await newPairingCode();
    advanceWall(299_999);
    expect((await get('/pairing-qr')).statusCode).toBe(200);
    advanceWall(1);
    const reply = await get('/pairing-qr');
    expect(reply.statusCode).toBe(410);
    expect(reply.json()).toMatchObject({ error: { code: 'PAIRING_CODE_EXPIRED' } });
  });
});

describe('who may ask', () => {
  it.each(['/pairing-qr', '/evidence-qr/AAAAAAAAAAAAAAAA'])(
    '%s refuses a request without a token',
    async (path) => {
      const { app, base } = await setup();
      const reply = await app.inject({ method: 'GET', url: `${base}${path}` });
      expect(reply.statusCode).toBe(401);
      expect(reply.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    },
  );

  it.each(['/pairing-qr', '/evidence-qr/AAAAAAAAAAAAAAAA'])(
    "%s refuses the phone's token",
    async (path) => {
      const { get, phone } = await setup();
      const reply = await get(path, phone);
      expect(reply.statusCode).toBe(401);
    },
  );

  it('refuses a made-up token and one with the wrong scheme', async () => {
    const { get } = await setup();
    expect(
      (await get('/pairing-qr', { authorization: `Bearer ${'A'.repeat(43)}` })).statusCode,
    ).toBe(401);
    expect((await get('/pairing-qr', { authorization: 'Basic abc' })).statusCode).toBe(401);
  });

  it('is 404 SESSION_NOT_FOUND for another session', async () => {
    const { app, desktop } = await setup();
    const reply = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/nope/pairing-qr',
      headers: desktop,
    });
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } });
  });
});
