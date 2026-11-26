import { createPhoneState } from '@hs/core/phone';
import { PROTOCOL_VERSION } from '@hs/protocol';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { hashSessionToken, issueToken, PairingService, verifyToken } from '../pairing/index.ts';
import { type InvestigationProvider, Session, SessionManager } from '../sessions/index.ts';
import { SaveService, SaveStore, isSaveId, type StoreIo } from './index.ts';

const wait = { type: 'wait', minutes: 15 } as const;
const provider = {
  create: (_scenarioId: string, seed: string) => ({
    investigation: tinyManor(seed),
    ports: { startLocationId: 'loc_hall' },
  }),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hs-saves-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** One "server process": a store, a service, a manager and an app on the same data directory. */
function boot(
  io: Partial<StoreIo> = {},
  options: {
    provider?: InvestigationProvider;
    createId?: () => string;
    now?: () => number;
    host?: () => string;
    logs?: string[];
  } = {},
) {
  const { logs } = options;
  const store = new SaveStore(join(dir, 'saves'), io);
  const saves = new SaveService({
    store,
    provider: options.provider ?? provider,
    now: () => Date.UTC(2026, 10, 23),
  });
  const sessions = new SessionManager(options.provider ?? provider, {
    createEngine: saves.createEngine,
    createId: options.createId ?? randomUUID,
    ...(options.now && { now: options.now }),
  });
  const pairing = new PairingService(sessions, {
    host: options.host ?? (() => 'pc.local'),
    port: 7420,
    ...(options.now && { now: options.now }),
  });
  const app = buildApp(readConfig({ HS_LOG_LEVEL: logs ? 'info' : 'silent' }), {
    pairing,
    saves: { saves, sessions, pairing, cleanup: () => store.removeStaleTemp() },
    ...(logs && { logStream: { write: (line) => logs.push(line) } }),
  });
  return { store, saves, sessions, pairing, app };
}

async function play(session: Session, count: number) {
  await session.activate();
  for (let index = 0; index < count; index++) {
    const result = await session.dispatch('desktop', wait);
    expect(result.ok).toBe(true);
  }
}

const hashOf = (session: Session) =>
  (session.engine as unknown as { stateHash(): string }).stateHash();
interface SaveJson {
  actions: unknown[];
  checkpoint?: { atAction: number };
  finalStateHash: string;
}
interface LoadBody {
  sessionId: string;
  desktopToken: string;
  pairing: { code: string; qrPayload: string };
}
interface SummaryBody {
  saveId: string;
  seed: string;
  gameTime: number | null;
}
interface ErrorBody {
  error: { code: string; message: string; atAction?: number };
}
const readSave = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as SaveJson;
const saveDir = () => join(dir, 'saves');
const internal = { error: { code: 'INTERNAL', message: 'Internal error' } };
const pairRequest = (code: string) => ({
  code,
  deviceName: 'Phone',
  appVersion: '0.0.0',
  protocolVersion: PROTOCOL_VERSION,
});

describe('autosave', () => {
  test('journals every action and checkpoints at 50', async () => {
    const { sessions } = boot();
    const session = await sessions.create('tiny-manor', 'winter');
    await play(session, 49);
    const before = await readSave(join(saveDir(), `${session.id}.json`));
    expect(before.actions).toHaveLength(49);
    expect(before.checkpoint).toBeUndefined();

    await play(session, 1);
    const after = await readSave(join(saveDir(), `${session.id}.json`));
    expect(after.actions).toHaveLength(50);
    expect(after.checkpoint?.atAction).toBe(50);
    expect(after.finalStateHash).toBe(hashOf(session));
  });

  test('writes nothing before the first action and leaves no temporary files', async () => {
    const { sessions } = boot();
    const session = await sessions.create('tiny-manor', 'winter');
    await expect(readdir(saveDir())).rejects.toMatchObject({ code: 'ENOENT' });
    await play(session, 2);
    expect((await readdir(saveDir())).sort()).toEqual([
      `${session.id}.json`,
      `${session.id}.meta.json`,
    ]);
  });

  if (process.platform !== 'win32') {
    test('the save file is private to the owner', async () => {
      const { sessions } = boot();
      const session = await sessions.create('tiny-manor', 'winter');
      await play(session, 1);
      const info = await stat(join(saveDir(), `${session.id}.json`));
      expect(info.mode & 0o777).toBe(0o600);
    });
  }

  test('a failed write faults the session instead of losing the action silently', async () => {
    const { sessions } = boot({
      writeFile: () => Promise.reject(new Error('disk full')),
    });
    const session = await sessions.create('tiny-manor', 'winter');
    await session.activate();
    const result = await session.dispatch('desktop', wait);
    expect(result).toMatchObject({ ok: false, error: 'INTERNAL' });
    expect(session.status).toBe('faulted');
  });
});

describe('interrupted writes', () => {
  test('a crash in the middle of a write leaves the previous save intact and loadable', async () => {
    let crash = false;
    const { sessions, saves } = boot({
      // Half of the new file reaches the disk, then the process "dies" before the rename.
      async writeFile(path, data) {
        await writeFile(path, crash ? data.slice(0, data.length / 2) : data);
        if (crash) throw new Error('killed');
      },
    });
    const session = await sessions.create('tiny-manor', 'winter');
    await play(session, 3);
    const good = await readFile(join(saveDir(), `${session.id}.json`), 'utf8');
    const goodHash = (JSON.parse(good) as SaveJson).finalStateHash;

    crash = true;
    await session.dispatch('desktop', wait);
    expect(await readFile(join(saveDir(), `${session.id}.json`), 'utf8')).toBe(good);

    const restored = await saves.restore(session.id);
    expect(restored.stateHash()).toBe(goodHash);
    expect(await saves.list()).toHaveLength(1);
  });

  test('a crash between writing and renaming leaves a stray temp file that is ignored and cleaned', async () => {
    const { sessions, saves, store } = boot({
      rename: () => Promise.reject(new Error('killed')),
    });
    const session = await sessions.create('tiny-manor', 'winter');
    await session.activate();
    await session.dispatch('desktop', wait);
    expect(await saves.list()).toEqual([]);

    // Simulate a process that really died: its temp file stays behind.
    await writeFile(join(saveDir(), `${session.id}.json.abc123.tmp`), '{"half');
    await writeFile(join(saveDir(), 'other.json.def456.tmp'), '');
    expect(await saves.list()).toEqual([]);
    expect(await store.removeStaleTemp()).toBe(2);
    expect(await readdir(saveDir())).toEqual([]);
  });

  test('a failed rename removes its own temp file', async () => {
    const { sessions } = boot({ rename: () => Promise.reject(new Error('EXDEV')) });
    const session = await sessions.create('tiny-manor', 'winter');
    await session.activate();
    await session.dispatch('desktop', wait);
    expect(await readdir(saveDir())).toEqual([]);
  });
});

describe('restart and load', () => {
  test('resumes a file from main over HTTP and persists a replayable desktop action', async () => {
    const { app, sessions, store } = boot();
    const id = randomUUID();
    const original = await readFile(
      new URL('../../../../packages/core/test/fixtures/save-before-desktop.json', import.meta.url),
      'utf8',
    );
    await store.write(id, original);
    const response = await app.inject({ method: 'POST', url: `/api/v1/saves/${id}/load` });
    expect(response.statusCode).toBe(200);
    expect(await store.read(id)).toBe(original);

    const session = sessions.get(id)!;
    await session.activate();
    expect((await session.dispatch('desktop', { type: 'examineLocation' })).ok).toBe(true);
    const restored = await boot().saves.restore(id);
    expect(restored.stateHash()).toBe(hashOf(session));
    expect(restored.snapshot().desktop?.examinedLocations).toEqual(['loc_hall']);
  });

  test('a supported save without a checkpoint loads its full journal without rewriting the file', async () => {
    const first = boot();
    const session = await first.sessions.create('tiny-manor', 'winter');
    await play(session, 2);
    const before = await first.store.read(session.id);
    const expectedHash = hashOf(session);
    await first.app.close();

    const { app, sessions, store } = boot();
    const response = await app.inject({ method: 'POST', url: `/api/v1/saves/${session.id}/load` });
    expect(response.statusCode).toBe(200);
    expect(hashOf(sessions.get(session.id)!)).toBe(expectedHash);
    expect(await store.read(session.id)).toBe(before);
  });

  test('a new server process loads the save to the same stateHash and keeps journaling', async () => {
    const first = boot();
    const session = await first.sessions.create('tiny-manor', 'winter');
    await play(session, 60); // past the checkpoint at 50
    const expected = hashOf(session);
    const minute = (session.engine as unknown as { snapshot(): { minute: number } }).snapshot()
      .minute;
    await first.app.close();

    const second = boot();
    const response = await second.app.inject({
      method: 'POST',
      url: `/api/v1/saves/${session.id}/load`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<LoadBody>();
    expect(Object.keys(body).sort()).toEqual(['desktopToken', 'pairing', 'sessionId']);
    expect(body.sessionId).toBe(session.id);
    expect(body.pairing.qrPayload).toContain(body.pairing.code);

    const loaded = second.sessions.get(body.sessionId)!;
    expect(hashOf(loaded)).toBe(expected);
    expect(verifyToken(loaded, 'desktop', body.desktopToken)).toBe(true);

    // Playing on appends to the same journal; a third process sees all 61 actions.
    await play(loaded, 1);
    const third = boot();
    const again = await third.saves.restore(session.id);
    expect(again.stateHash()).toBe(hashOf(loaded));
    const file = await readSave(join(saveDir(), `${session.id}.json`));
    expect(file.actions).toHaveLength(61);
    expect(file.checkpoint?.atAction).toBe(50);

    const list = (await third.app.inject({ method: 'GET', url: '/api/v1/saves' })).json<
      SummaryBody[]
    >();
    expect(list).toEqual([
      {
        saveId: session.id,
        scenarioId: 'tiny-manor',
        seed: 'winter',
        updatedAt: expect.any(String) as string,
        gameTime: minute + 15,
      },
    ]);
  });

  test('loading an unknown or malformed id is SAVE_NOT_FOUND', async () => {
    const { app } = boot();
    for (const id of ['missing', '..%2F..%2Fetc%2Fpasswd', 'a.b', 'x'.repeat(65)]) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/saves/${id}/load` });
      expect(response.statusCode, id).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('SAVE_NOT_FOUND');
    }
  });

  test('a tampered journal is SAVE_DESYNC and reports the first bad action', async () => {
    const first = boot();
    const session = await first.sessions.create('tiny-manor', 'winter');
    await play(session, 51); // the damaged entry precedes a valid checkpoint
    const path = join(saveDir(), `${session.id}.json`);
    const file = await readSave(path);
    file.actions[2] = { ...(file.actions[2] as object), action: { type: 'wait', minutes: 60 } };
    await writeFile(path, JSON.stringify(file));

    const { app, sessions } = boot();
    const response = await app.inject({ method: 'POST', url: `/api/v1/saves/${session.id}/load` });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: 'SAVE_DESYNC', message: expect.any(String) as string, atAction: 3 },
    });
    expect(sessions.get(session.id)).toBeUndefined();
  });

  test('garbage in the save file is SAVE_DESYNC at the start, not a server error', async () => {
    const { app } = boot();
    const store = new SaveStore(saveDir());
    await store.write('broken', '{"scenarioId": "tiny-ma');
    await store.write('empty', '{}');
    for (const id of ['broken', 'empty']) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/saves/${id}/load` });
      expect(response.statusCode, id).toBe(422);
      expect(response.json<ErrorBody>().error).toMatchObject({ code: 'SAVE_DESYNC', atAction: 0 });
    }
  });

  test.each(['0.0.9', '9.9.9', 'preview'])(
    'loading a save written by generator %s explains the refusal',
    async (version) => {
      const first = boot(
        {},
        {
          provider: {
            create(scenarioId, seed) {
              const { investigation, ports } = provider.create(scenarioId, seed);
              return { investigation: { ...investigation, generatorVersion: version }, ports };
            },
          },
        },
      );
      const session = await first.sessions.create('tiny-manor', 'winter');
      await play(session, 1);
      const before = await first.store.read(session.id);
      await first.app.close();
      const { app, sessions, store } = boot();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/saves/${session.id}/load`,
      });
      expect(response.statusCode).toBe(422);
      const { error } = response.json<ErrorBody>();
      expect(error).toMatchObject({ code: 'SAVE_DESYNC', atAction: 0 });
      expect(error.message).toContain(`Unsupported generator version "${version}"`);
      expect(error.message).toContain('0.1.0');
      expect(sessions.get(session.id)).toBeUndefined();
      expect(await store.read(session.id)).toBe(before);
    },
  );

  test('a running session blocks a load; a suspended one is replaced and its engine can no longer write', async () => {
    let now = 0;
    const store = new SaveStore(saveDir());
    const saves = new SaveService({ store, provider });
    const sessions = new SessionManager(provider, {
      createEngine: saves.createEngine,
      now: () => now,
    });
    const pairing = new PairingService(sessions, { host: () => 'pc.local', port: 7420 });
    const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
      pairing,
      saves: { saves, sessions, pairing },
    });
    const old = await sessions.create('tiny-manor', 'winter');
    await play(old, 2);

    const url = `/api/v1/saves/${old.id}/load`;
    const refused = await app.inject({ method: 'POST', url });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<ErrorBody>().error.code).toBe('ACTION_NOT_AVAILABLE');
    expect(sessions.get(old.id)).toBe(old);

    now = 61_000; // the desktop never connected: suspended after the grace period
    const accepted = await app.inject({ method: 'POST', url });
    expect(accepted.statusCode).toBe(200);
    const replacement = sessions.get(old.id)!;
    expect(replacement).not.toBe(old);

    // The old engine, called behind the session's back, is fenced off the file.
    await expect(old.engine.dispatch('desktop', wait)).rejects.toThrow('belongs to another');
    await replacement.activate();
    expect((await replacement.dispatch('desktop', wait)).ok).toBe(true);
    const file = await readSave(join(saveDir(), `${old.id}.json`));
    expect(file.actions).toHaveLength(3); // 2 + the replacement's one; the old engine wrote nothing
  });

  test('an invalid load DTO leaves no session, pairing code or writer in a fresh process', async () => {
    const first = boot({}, { createId: () => 'winter-1' });
    const old = await first.sessions.create('tiny-manor', 'winter');
    await play(old, 1);
    const before = await first.store.read(old.id);
    await first.app.close();

    let host = 'invalid:host';
    const { app, pairing, sessions, store } = boot({}, { host: () => host });
    const tokens = vi.spyOn(Session.prototype, 'setTokenHash');
    const prepareCode = pairing.prepareCode.bind(pairing);
    let stagedCode: string | undefined;
    let duringPreparation: Session | undefined;
    vi.spyOn(pairing, 'prepareCode').mockImplementation((session) => {
      const staged = prepareCode(session);
      stagedCode = staged.pairing.code;
      duringPreparation = sessions.get(old.id);
      return staged;
    });
    try {
      const url = `/api/v1/saves/${old.id}/load`;
      const failed = await app.inject({ method: 'POST', url });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual(internal);
      expect(failed.headers['cache-control']).toBe('no-store');
      expect(duringPreparation).toBeUndefined();
      expect(sessions.get(old.id)).toBeUndefined();

      host = 'pc.local';
      const candidate = tokens.mock.contexts[0] as Session;
      expect(candidate.tokenHash('desktop')).toBeUndefined();
      expect(pairing.activeCode(candidate)).toBeUndefined();
      expect(stagedCode).toBeDefined();
      await expect(pairing.pair(pairRequest(stagedCode!), '192.0.2.1')).rejects.toMatchObject({
        code: 'PAIRING_CODE_INVALID',
      });
      await expect(candidate.engine.dispatch('desktop', wait)).rejects.toThrow('belongs to another');
      expect(await store.read(old.id)).toBe(before);

      const retried = await app.inject({ method: 'POST', url });
      expect(retried.statusCode).toBe(200);
      await play(sessions.get(old.id)!, 1);
      expect((await readSave(join(saveDir(), `${old.id}.json`))).actions).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  test.each(['host lookup throws', 'DTO is invalid'])(
    'failed replacement preserves the old credentials and writer when %s',
    async (failure) => {
      let now = 0;
      let broken = false;
      let privateMessage = '';
      let duringPreparation: Session | undefined;
      let id: string;
      const logs: string[] = [];
      const { app, pairing, sessions, store } = boot({}, {
        now: () => now,
        logs,
        host() {
          if (!broken) return 'pc.local';
          duringPreparation = sessions.get(id);
          if (failure === 'host lookup throws') {
            throw Object.assign(new Error(privateMessage), { statusCode: 418 });
          }
          return 'invalid:host';
        },
      });
      try {
        const old = await sessions.create('tiny-manor', 'winter');
        id = old.id;
        const desktopToken = issueToken(old, 'desktop');
        const phoneToken = issueToken(old, 'phone');
        const oldPairing = pairing.createCode(old);
        privateMessage = `private network error ${desktopToken} ${phoneToken} ${oldPairing.code}`;
        await play(old, 1);
        const before = await store.read(old.id);
        const metaBefore = await store.readMeta(old.id);
        now = 61_000;

        broken = true;
        const url = `/api/v1/saves/${old.id}/load`;
        const response = await app.inject({ method: 'POST', url });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual(internal);
        expect(logs.filter((line) => line.includes('request failed'))).toHaveLength(1);
        for (const secret of ['private network error', desktopToken, phoneToken, oldPairing.code]) {
          expect(response.body).not.toContain(secret);
          expect(logs.join('')).not.toContain(secret);
        }
        broken = false;
        expect(duringPreparation).toBe(old);
        expect(sessions.get(old.id)).toBe(old);
        expect(old.status).toBe('suspended');
        expect(pairing.activeCode(old)).toEqual(oldPairing);
        expect(pairing.authorizeDesktop(old.id, `Bearer ${desktopToken}`)).toBe(old);
        expect(verifyToken(old, 'phone', phoneToken)).toBe(true);
        expect(await store.read(old.id)).toBe(before);
        expect(await store.readMeta(old.id)).toEqual(metaBefore);

        await old.setConnected('desktop', true);
        expect((await old.dispatch('desktop', wait)).ok).toBe(true);
        expect((await readSave(join(saveDir(), `${old.id}.json`))).actions).toHaveLength(2);
        await expect(pairing.pair(pairRequest(oldPairing.code), '192.0.2.1')).resolves.toMatchObject({
          sessionId: old.id,
        });
        await old.setConnected('desktop', false);
        now = 122_000;
        const retried = await app.inject({ method: 'POST', url });
        expect(retried.statusCode).toBe(200);
        expect(hashOf(sessions.get(old.id)!)).toBe(hashOf(old));
      } finally {
        await app.close();
      }
    },
  );

  test('only the first concurrent load replaces the old session and revokes its credentials', async () => {
    let now = 0;
    let pauseNextRestore = false;
    const restoring = Promise.withResolvers<void>();
    const resumeRestore = Promise.withResolvers<void>();
    const logs: string[] = [];
    const { app, pairing, sessions, store } = boot({}, {
      now: () => now,
      logs,
      provider: {
        async create(scenarioId, seed) {
          if (pauseNextRestore) {
            pauseNextRestore = false;
            restoring.resolve();
            await resumeRestore.promise;
          }
          return provider.create(scenarioId, seed);
        },
      },
    });
    const old = await sessions.create('tiny-manor', 'winter');
    await play(old, 1);
    const desktopToken = issueToken(old, 'desktop');
    const phoneToken = issueToken(old, 'phone');
    const oldPairing = pairing.createCode(old);
    now = 61_000;

    const url = `/api/v1/saves/${old.id}/load`;
    pauseNextRestore = true;
    const first = app.inject({ method: 'POST', url }).then((response) => response);
    try {
      await restoring.promise;
      expect(sessions.get(old.id)).toBe(old);
      expect(pairing.activeCode(old)).toEqual(oldPairing);
      expect(verifyToken(old, 'desktop', desktopToken)).toBe(true);
      expect(verifyToken(old, 'phone', phoneToken)).toBe(true);
      const second = await app.inject({ method: 'POST', url });
      expect(second.statusCode).toBe(409);
      expect(second.json<ErrorBody>().error.code).toBe('ACTION_NOT_AVAILABLE');

      resumeRestore.resolve();
      const response = await first;
      expect(response.statusCode).toBe(200);
      const body = response.json<LoadBody>();
      const winner = sessions.get(old.id)!;
      expect(winner).not.toBe(old);
      expect(winner.status).toBe('created');
      expect(pairing.authorizeDesktop(old.id, `Bearer ${body.desktopToken}`)).toBe(winner);
      expect(pairing.activeCode(winner)?.code).toBe(body.pairing.code);
      expect(pairing.activeCode(old)).toBeUndefined();
      for (const [role, token] of [['desktop', desktopToken], ['phone', phoneToken]] as const) {
        expect(verifyToken(old, role, token)).toBe(false);
        expect(sessions.findByTokenHash(hashSessionToken(token))).toBeUndefined();
      }
      await expect(pairing.pair(pairRequest(oldPairing.code), '192.0.2.1')).rejects.toMatchObject({
        code: 'PAIRING_CODE_INVALID',
      });
      await expect(pairing.pair(pairRequest(body.pairing.code), '192.0.2.1')).resolves.toMatchObject({
        sessionId: winner.id,
      });
      for (const secret of [desktopToken, phoneToken, oldPairing.code, body.desktopToken, body.pairing.code]) {
        expect(logs.join('')).not.toContain(secret);
      }

      const before = await store.read(old.id);
      await expect(old.engine.dispatch('desktop', wait)).rejects.toThrow('belongs to another');
      expect(await store.read(old.id)).toBe(before);
      await play(winner, 1);
      expect((await readSave(join(saveDir(), `${old.id}.json`))).actions).toHaveLength(2);
    } finally {
      resumeRestore.resolve();
      await first;
      await app.close();
    }
  });

  test('load reads the journal after an in-flight session write finishes', async () => {
    let now = 0;
    let pauseRename = false;
    const writing = Promise.withResolvers<void>();
    const finishWrite = Promise.withResolvers<void>();
    const loading = Promise.withResolvers<void>();
    const { app, saves, sessions, store } = boot({
      async rename(from, to) {
        if (pauseRename) {
          pauseRename = false;
          writing.resolve();
          await finishWrite.promise;
        }
        await rename(from, to);
      },
    }, { now: () => now });
    app.addHook('preHandler', (_request, _reply, done) => {
      done();
      loading.resolve();
    });
    await app.ready();
    const restore = vi.spyOn(saves, 'restore');
    const old = await sessions.create('tiny-manor', 'winter');
    await play(old, 1);
    const before = await store.read(old.id);
    pauseRename = true;
    const action = old.dispatch('desktop', wait);
    await writing.promise;
    now = 61_000;
    const load = app.inject({ method: 'POST', url: `/api/v1/saves/${old.id}/load` }).then((res) => res);

    try {
      await loading.promise;
      expect(restore).not.toHaveBeenCalled();
      expect(await store.read(old.id)).toBe(before);
      finishWrite.resolve();
      expect(await action).toMatchObject({ ok: true });
      expect((await load).statusCode).toBe(200);
      const winner = sessions.get(old.id)!;
      expect(hashOf(winner)).toBe(hashOf(old));
      await play(winner, 1);
      expect((await readSave(join(saveDir(), `${old.id}.json`))).actions).toHaveLength(3);
    } finally {
      finishWrite.resolve();
      await Promise.all([action, load]);
      await app.close();
    }
  });

  test('a response hook failure is private even after the load commits', async () => {
    const first = boot();
    const old = await first.sessions.create('tiny-manor', 'winter');
    await play(old, 1);
    await first.app.close();

    const logs: string[] = [];
    const { app, sessions } = boot({}, { logs });
    const privateMessage = 'private response hook failure';
    app.addHook('preSerialization', (_request, reply, _payload, next) => {
      if (reply.statusCode === 200) next(new Error(privateMessage));
      else next();
    });
    try {
      const failed = await app.inject({ method: 'POST', url: `/api/v1/saves/${old.id}/load` });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual(internal);
      expect(failed.headers['cache-control']).toBe('no-store');
      expect(logs.filter((line) => line.includes('request failed'))).toHaveLength(1);
      expect(logs.join('')).not.toContain(privateMessage);
      expect(sessions.get(old.id)?.status).toBe('created');
    } finally {
      await app.close();
    }
  });

  test('two simultaneous loads of one save: one wins, the other gets a conflict', async () => {
    const first = boot();
    const session = await first.sessions.create('tiny-manor', 'winter');
    await play(session, 2);

    const { app, sessions } = boot();
    const url = `/api/v1/saves/${session.id}/load`;
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url }),
      app.inject({ method: 'POST', url }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const winner = sessions.get(session.id)!;
    await winner.activate();
    expect((await winner.dispatch('desktop', wait)).ok).toBe(true);
  });
});

describe('GET /saves', () => {
  test('is empty without a saves directory and ignores stray files, newest first', async () => {
    const { app, sessions } = boot();
    expect((await app.inject({ method: 'GET', url: '/api/v1/saves' })).json()).toEqual([]);

    const older = await sessions.create('tiny-manor', 'spring');
    await play(older, 1);
    const newer = await sessions.create('tiny-manor', 'autumn');
    await play(newer, 2);
    await writeFile(join(saveDir(), 'notes.txt'), 'x');
    await writeFile(join(saveDir(), 'junk.json'), 'not json');
    await writeFile(join(saveDir(), 'wrong shape.json'), '{}');
    // Make the order independent of the file system's timestamp resolution.
    const { utimes } = await import('node:fs/promises');
    await utimes(join(saveDir(), `${older.id}.json`), 1000, 1000);
    await utimes(join(saveDir(), `${newer.id}.json`), 2000, 2000);

    const list = (await app.inject({ method: 'GET', url: '/api/v1/saves' })).json<SummaryBody[]>();
    expect(list.map((entry) => entry.saveId)).toEqual([newer.id, older.id]);
    expect(list[0]).toMatchObject({ seed: 'autumn', gameTime: 30 });
    expect(list[1]).toMatchObject({ seed: 'spring', gameTime: 15 });
    expect(Object.keys(list[0]!).sort()).toEqual([
      'gameTime',
      'saveId',
      'scenarioId',
      'seed',
      'updatedAt',
    ]);
  });

  test('a lost metadata file only blanks gameTime', async () => {
    const { app, sessions } = boot();
    const session = await sessions.create('tiny-manor', 'winter');
    await play(session, 1);
    await rm(join(saveDir(), `${session.id}.meta.json`));
    const list = (await app.inject({ method: 'GET', url: '/api/v1/saves' })).json<SummaryBody[]>();
    expect(list[0]).toMatchObject({ saveId: session.id, gameTime: null });
  });

  test('never exposes the solution or any token', async () => {
    const { app, sessions } = boot();
    const session = await sessions.create('tiny-manor', 'winter');
    await play(session, 1);
    const text = (await app.inject({ method: 'GET', url: '/api/v1/saves' })).body;
    expect(text).not.toMatch(/truth|culprit|veracity|token/i);
  });
});

describe('save ids', () => {
  test('accepts file-name-safe ids only', () => {
    expect(isSaveId('3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a.json', 'x'.repeat(65), 'é', 7, undefined]) {
      expect(isSaveId(bad), String(bad)).toBe(false);
    }
  });

  test('the store refuses to write outside its directory', async () => {
    const store = new SaveStore(saveDir());
    expect(() => store.write('../escape', '{}')).toThrow(RangeError);
    expect(() => store.writeMeta('../escape', {})).toThrow(RangeError);
    expect(await store.read('../escape')).toBeUndefined();
  });
});

test('registerSaveRoutes only runs the cleanup hook once, when the app is ready', async () => {
  let calls = 0;
  const { saves, sessions, pairing } = boot();
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
    pairing,
    saves: {
      saves,
      sessions,
      pairing,
      cleanup: () => {
        calls++;
        return Promise.resolve();
      },
    },
  });
  await app.ready();
  await app.ready();
  expect(calls).toBe(1);
  await app.close();
});

test('recording and restored engines expose real role projections', async () => {
  const projectedProvider = {
    create: (_scenarioId: string, seed: string) => ({
      investigation: tinyManor(seed),
      ports: { startLocationId: 'loc_hall', phone: { initial: createPhoneState() } },
    }),
  };
  const { sessions, saves } = boot({}, { provider: projectedProvider });
  const session = await sessions.create('tiny-manor', 'projections');
  await play(session, 1);
  const player = session.engine.playerView!();
  const phone = session.engine.phoneView!();
  expect(player.clock.t).toBe(15);
  expect(phone?.status.time).toBe(player.clock.time);
  const loaded = await saves.restore(session.id);
  expect(loaded.playerView()).toEqual(player);
  expect(loaded.phoneView()).toEqual(phone);
});
