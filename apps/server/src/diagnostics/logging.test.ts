import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED_FIELDS } from './logging.ts';
import { captureLogs, createHarness } from './harness.ts';

type Harness = Awaited<ReturnType<typeof createHarness>>;
const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(({ app }) => app.close()));
});

const PATH_SECRET = 'SECRETPATHTOKEN12345';
const QUERY_SECRET = 'querysecretvalue';
const COOKIE_SECRET = 'COOKIESECRETVALUE';
const RAW_SECRET = 'hs1:ev:deadbeef:RAWQRTOKENID12345:RAWQRSIGNATURE1234567';
const BODY_CODE = 'BODYCODE-IN-A-CRASHING-POST';
const BODY_PASSWORD = 'BODY-PASSWORD-VALUE';

/** Walks every key of every logged object. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

/** A session, an app that logs everything it can, and a route that crashes with secrets around. */
async function run(options: { debugTruth?: boolean } = {}) {
  const logs = captureLogs();
  const h = await createHarness({ ...options, logStream: logs.stream, logLevel: 'trace' });
  open.push(h);
  h.app.get('/api/v1/sessions/:id/evidence-qr/:tokenId', () => {
    throw new Error('boom');
  });
  h.app.post('/api/v1/sessions/:id/crashing-post', () => {
    throw new Error('boom from a post');
  });

  const issued = (
    await h.app.inject({ method: 'POST', url: h.url('/pairing-code'), headers: h.desktop })
  ).json<{
    code: string;
    qrPayload: string;
  }>();
  const body = (code: string) => ({
    code,
    deviceName: 'Phone',
    appVersion: '0.0.0',
    protocolVersion: 1,
    raw: RAW_SECRET,
  });
  const paired = (
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      remoteAddress: '192.0.2.1',
      payload: body(issued.code),
    })
  ).json<{
    deviceToken: string;
  }>();
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    remoteAddress: '192.0.2.2',
    payload: body('WRONG1'),
  });
  await h.app.inject({
    method: 'GET',
    url: `${h.url('/evidence-qr/')}${PATH_SECRET}?x=${QUERY_SECRET}`,
    headers: { ...h.desktop, cookie: `session=${COOKIE_SECRET}` },
  });
  await h.app.inject({
    method: 'POST',
    url: h.url('/crashing-post'),
    headers: h.desktop,
    payload: { code: BODY_CODE, password: BODY_PASSWORD, raw: RAW_SECRET },
  });
  await h.app.inject({ method: 'GET', url: h.url('/debug/truth'), headers: h.desktop });
  await h.app.inject({ method: 'GET', url: h.url('/debug/export'), headers: h.phone });
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/sessions/bad%20id/pairing-code',
    headers: h.desktop,
  });
  await h.app.inject({ method: 'GET', url: '/api/v1/health' });

  return {
    h,
    logs,
    secrets: {
      desktopToken: h.desktopToken,
      phoneToken: h.phoneToken,
      deviceToken: paired.deviceToken,
      pairingCode: issued.code,
      qrPayload: issued.qrPayload,
      pathSecret: PATH_SECRET,
      querySecret: QUERY_SECRET,
      cookieSecret: COOKIE_SECRET,
      rawSecret: RAW_SECRET,
      rawTokenId: 'RAWQRTOKENID12345',
      bodyCode: BODY_CODE,
      bodyPassword: BODY_PASSWORD,
    },
  };
}

describe('no secrets in the logs, even at trace level', () => {
  it.each(['off', 'on'] as const)('with the debug flag %s', async (flag) => {
    const { logs, secrets } = await run({ debugTruth: flag === 'on' });
    const text = logs.text();
    expect(text.length).toBeGreaterThan(500); // the app did log; this is not an empty-log pass
    for (const [name, secret] of Object.entries(secrets)) {
      expect(text, name).not.toContain(secret);
    }
    expect(text).not.toMatch(/Bearer/i);
    expect(text).not.toContain('cookie');
  });

  it('writes no URL, header, body, query or parameter object at all', async () => {
    const { logs } = await run({ debugTruth: true });
    const keys = new Set(logs.entries().flatMap(allKeys));
    for (const forbidden of [
      'req',
      'res',
      'url',
      'headers',
      'body',
      'query',
      'params',
      'authorization',
      'cookie',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it('keeps the truth out of the logs even when it is being served', async () => {
    const { logs } = await run({ debugTruth: true });
    const text = logs.text();
    for (const solution of ['ch_bursar', 'culpritIds', 'conceal_debt', 'it_study_key', 'theft']) {
      expect(text, solution).not.toContain(solution);
    }
  });
});

describe('what is logged', () => {
  it('has one line per response with method, route template, status and duration', async () => {
    const { logs } = await run({ debugTruth: true });
    const done = logs.entries().filter((entry) => entry.msg === 'request completed');
    expect(done.length).toBeGreaterThanOrEqual(8);
    for (const entry of done) {
      expect(typeof entry.method).toBe('string');
      expect(String(entry.route)).toMatch(/^\/api\/v1\//);
      expect(typeof entry.statusCode).toBe('number');
      expect(typeof entry.durationMs).toBe('number');
    }
    expect(
      done.some((e) => e.route === '/api/v1/sessions/:id/pairing-code' && e.statusCode === 200),
    ).toBe(true);
    expect(done.some((e) => e.route === '/api/v1/pair' && e.statusCode === 400)).toBe(true);
  });

  it('carries the session id on routes that belong to a session, and only there', async () => {
    const { logs } = await run({ debugTruth: true });
    const done = logs.entries().filter((entry) => entry.msg === 'request completed');
    const session = done.filter(
      (e) => String(e.route).includes(':id') && e.sessionId !== undefined,
    );
    expect(session.length).toBeGreaterThanOrEqual(4);
    expect(session.every((e) => e.sessionId === 'session-a')).toBe(true);
    const health = done.find((e) => e.route === '/api/v1/health');
    expect(health).toBeDefined();
    expect(health?.sessionId).toBeUndefined();
    const pair = done.find((e) => e.route === '/api/v1/pair');
    expect(pair?.sessionId).toBeUndefined();
  });

  it('does not log a session id that is not shaped like one', async () => {
    const { logs } = await run();
    const weird = logs
      .entries()
      .filter(
        (e) =>
          e.msg === 'request completed' &&
          e.statusCode === 404 &&
          e.route === '/api/v1/sessions/:id/pairing-code',
      );
    expect(weird.length).toBeGreaterThan(0);
    expect(weird.every((e) => e.sessionId === undefined)).toBe(true);
    expect(logs.text()).not.toContain('bad id');
  });

  it('logs a crash of the server with its error, and nothing from the request', async () => {
    const { logs } = await run();
    const failed = logs.entries().filter((entry) => entry.msg === 'request failed');
    expect(failed).toHaveLength(2); // the GET and the POST that crash
    expect(failed.map((entry) => (entry.err as { message: string }).message)).toEqual([
      'boom',
      'boom from a post',
    ]);
    expect(failed[0]).toMatchObject({
      level: 50,
      method: 'GET',
      route: '/api/v1/sessions/:id/evidence-qr/:tokenId',
      sessionId: 'session-a',
      err: { message: 'boom' },
    });
  });

  it('does not make noise about refusals the client caused (401, 404)', async () => {
    const { logs } = await run({ debugTruth: true });
    const completed = logs.entries().filter((e) => e.msg === 'request completed');
    expect(completed.some((e) => e.statusCode === 401)).toBe(true);
    expect(completed.some((e) => e.statusCode === 404)).toBe(true);
    expect(logs.entries().filter((e) => e.msg === 'request failed')).toHaveLength(2); // only the two crashes
  });

  it('records that the debug endpoints were used, by session and without content', async () => {
    const { logs } = await run({ debugTruth: true });
    const warned = logs.entries().filter((e) => e.level === 40);
    expect(warned.map((e) => e.msg)).toEqual(['debug truth requested']);
    expect(warned[0]).toMatchObject({ sessionId: 'session-a' });
  });

  it('logs nothing at all when the level is silent', async () => {
    const logs = captureLogs();
    const h = await createHarness({ logStream: logs.stream, logLevel: 'silent' });
    open.push(h);
    await h.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(logs.text()).toBe('');
  });
});

describe('redaction of anything that slips through', () => {
  it('censors secret-looking fields at any depth in whatever is logged', async () => {
    const logs = captureLogs();
    const h = await createHarness({ logStream: logs.stream, logLevel: 'info' });
    open.push(h);
    const sample = {
      authorization: 'LEAK-1',
      token: 'LEAK-2',
      nested: { deviceToken: 'LEAK-3', deeper: { desktopToken: 'LEAK-4' } },
      headers: { authorization: 'LEAK-5', cookie: 'LEAK-6' },
      pairingCode: 'LEAK-7',
      tokenId: 'LEAK-8',
      qrPayload: 'LEAK-9',
      sig: 'LEAK-10',
      sessionSecret: 'LEAK-11',
      raw: 'LEAK-12',
    };
    h.app.log.info(sample, 'a careless log call');
    const text = logs.text();
    for (let i = 1; i <= 12; i++) expect(text).not.toContain(`LEAK-${i}`);
    expect(text).toContain('[redacted]');
  });

  it('leaves ordinary fields readable, error codes included', async () => {
    const logs = captureLogs();
    const h = await createHarness({ logStream: logs.stream, logLevel: 'info' });
    open.push(h);
    h.app.log.info({ code: 'QR_EXPIRED', sessionId: 'session-a', minute: 12 }, 'scan refused');
    expect(logs.entries()[0]).toMatchObject({
      code: 'QR_EXPIRED',
      sessionId: 'session-a',
      minute: 12,
    });
  });

  it('covers every field name it promises to', () => {
    expect([...REDACTED_FIELDS].sort()).toEqual(
      [
        'authorization',
        'cookie',
        'password',
        'pairingCode',
        'qrPayload',
        'raw',
        'secret',
        'sessionSecret',
        'sig',
        'signature',
        'token',
        'tokenId',
        'deviceToken',
        'desktopToken',
      ].sort(),
    );
  });
});
