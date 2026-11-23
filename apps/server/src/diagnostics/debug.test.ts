import { GameEngine, snapshotInvestigation } from '@hs/core/game';
import { afterEach, describe, expect, it } from 'vitest';
import serverPackage from '../../package.json' with { type: 'json' };
import { REPRO_FORMAT, type ReproBundle } from './repro.ts';
import { EXPORTED_AT, createHarness } from './harness.ts';

type Harness = Awaited<ReturnType<typeof createHarness>>;
const open: Harness[] = [];
const harness = async (...args: Parameters<typeof createHarness>): Promise<Harness> => {
  const h = await createHarness(...args);
  open.push(h);
  return h;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map(({ app }) => app.close()));
});

const ENDPOINTS = ['/debug/truth', '/debug/export'] as const;

describe('with the flag off (the default)', () => {
  it.each(ENDPOINTS)('%s is a plain 404, even for the right token', async (path) => {
    const h = await harness();
    const reply = await h.app.inject({ method: 'GET', url: h.url(path), headers: h.desktop });
    expect(reply.statusCode).toBe(404);
    expect(reply.body).not.toContain('culprit');
    expect(reply.body).not.toContain('ch_bursar');
  });

  it.each(ENDPOINTS)('%s looks exactly like any other unknown route', async (path) => {
    const h = await harness();
    const real = await h.app.inject({ method: 'GET', url: h.url(path), headers: h.desktop });
    const nonsense = await h.app.inject({
      method: 'GET',
      url: h.url('/debug/nothing-here'),
      headers: h.desktop,
    });
    const shape = (body: string) => Object.keys(JSON.parse(body) as object).sort();
    expect(real.statusCode).toBe(nonsense.statusCode);
    expect(shape(real.body)).toEqual(shape(nonsense.body));
    expect(real.headers['content-type']).toBe(nonsense.headers['content-type']);
  });

  it.each(ENDPOINTS)(
    '%s is 404 with no token and with a phone token too, not 401',
    async (path) => {
      const h = await harness();
      expect((await h.app.inject({ method: 'GET', url: h.url(path) })).statusCode).toBe(404);
      expect(
        (await h.app.inject({ method: 'GET', url: h.url(path), headers: h.phone })).statusCode,
      ).toBe(404);
    },
  );

  it('is off when HS_DEBUG_TRUTH is anything but 1', async () => {
    for (const value of ['0', '']) {
      const { readConfig } = await import('../config/index.ts');
      expect(readConfig({ HS_DEBUG_TRUTH: value === '' ? '0' : value }).debugTruth).toBe(false);
    }
  });

  it('the flag alone is not enough: without the debug dependencies nothing is registered', async () => {
    const h = await harness({ debugTruth: true, withDiagnostics: false });
    const reply = await h.app.inject({
      method: 'GET',
      url: h.url('/debug/truth'),
      headers: h.desktop,
    });
    expect(reply.statusCode).toBe(404);
  });
});

describe('with HS_DEBUG_TRUTH=1', () => {
  it.each(ENDPOINTS)('%s asks for a desktop token', async (path) => {
    const h = await harness({ debugTruth: true });
    for (const headers of [
      {},
      h.phone,
      { authorization: 'Basic abc' },
      { authorization: `Bearer ${'A'.repeat(43)}` },
    ]) {
      const reply = await h.app.inject({ method: 'GET', url: h.url(path), headers });
      expect(reply.statusCode, JSON.stringify(headers)).toBe(401);
      expect(reply.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });

  it.each(ENDPOINTS)('%s is 404 SESSION_NOT_FOUND for another session', async (path) => {
    const h = await harness({ debugTruth: true });
    const reply = await h.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/nope${path}`,
      headers: h.desktop,
    });
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } });
  });

  it('GET debug/truth shows the real truth log, and tells caches to forget it', async () => {
    const h = await harness({ debugTruth: true });
    const reply = await h.app.inject({
      method: 'GET',
      url: h.url('/debug/truth'),
      headers: h.desktop,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');

    const body = reply.json<{
      sessionId: string;
      scenarioId: string;
      seed: string;
      generatorVersion: string;
      minute: number;
      truth: { incident: { culpritIds: string[]; type: string }; events: { verb: string }[] };
    }>();
    expect(body).toMatchObject({
      sessionId: 'session-a',
      scenarioId: 'tiny-manor',
      seed: 'harness-seed',
      generatorVersion: '0.1.0',
      minute: 0,
    });
    const expected = snapshotInvestigation(h.investigation).truth as { events: unknown[] };
    expect(body.truth.incident).toMatchObject({ type: 'theft', culpritIds: ['ch_bursar'] });
    expect(body.truth.events).toHaveLength(expected.events.length);
  });

  it('GET debug/export returns a bundle that reproduces the session', async () => {
    const h = await harness({ debugTruth: true });
    await h.session.dispatch('desktop', { type: 'move', locationId: 'loc_pantry' });
    const reply = await h.app.inject({
      method: 'GET',
      url: h.url('/debug/export'),
      headers: h.desktop,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');

    const bundle = reply.json<ReproBundle>();
    expect(bundle).toMatchObject({
      format: REPRO_FORMAT,
      version: 1,
      exportedAt: EXPORTED_AT.toISOString(),
      server: { version: serverPackage.version },
      session: { id: 'session-a', status: 'active' },
      scenarioId: 'tiny-manor',
      seed: 'harness-seed',
      generatorVersion: '0.1.0',
    });
    expect(bundle.snapshot.minute).toBeGreaterThan(0); // the move cost time
    expect(bundle.snapshot.locationId).toBe('loc_pantry');
    expect(bundle.stateHash).toBe(h.engine.stateHash());

    // The point of the bundle: restore it elsewhere and land in the same state.
    const restored = GameEngine.restore(bundle.snapshot, h.investigation, h.ports);
    expect(restored.stateHash()).toBe(bundle.stateHash);
  });

  it('export changes with the game: a later state has a different hash', async () => {
    const h = await harness({ debugTruth: true });
    const before = (
      await h.app.inject({ method: 'GET', url: h.url('/debug/export'), headers: h.desktop })
    ).json<ReproBundle>();
    await h.session.dispatch('desktop', { type: 'wait', minutes: 15 });
    const after = (
      await h.app.inject({ method: 'GET', url: h.url('/debug/export'), headers: h.desktop })
    ).json<ReproBundle>();
    expect(after.stateHash).not.toBe(before.stateHash);
    expect(after.session.stateVersion).toBeGreaterThan(before.session.stateVersion);
  });

  it.each(ENDPOINTS)('%s says 501 for a session whose engine cannot be inspected', async (path) => {
    const h = await harness({ debugTruth: true, opaqueEngine: true });
    const reply = await h.app.inject({ method: 'GET', url: h.url(path), headers: h.desktop });
    expect(reply.statusCode).toBe(501);
    expect(reply.json()).toMatchObject({ error: { code: 'INTERNAL' } });
  });
});
