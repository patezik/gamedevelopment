import { loadScenarioFromDir } from '@hs/core/content';
import { generateInvestigation } from '@hs/generator';
import { FakeDesktop, FakePhone } from '@hs/fake-client';
import { SaveFile } from '@hs/core/save';
import { ErrorResponse, PhoneView, PlayerView, SaveList } from '@hs/protocol';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildApp } from './app.ts';
import { readConfig } from './config/index.ts';
import type { EvidenceTokenStore } from './qr/index.ts';
import { defaultScenariosDir, createSessionServices } from './routes/generation.ts';
import { CreateSessionResponse } from './routes/sessions.ts';
import { RecordingEngine } from './saves/index.ts';

// SRV-015: the production factory journals every session under HS_DATA_DIR and a second "process"
// on the same directory continues the game, including the QR that was pending at the time.

vi.setConfig({ testTimeout: 60_000 });

const SCENARIO = 'sanatorium_winter';
const SEED = '2'; // a poisoning whose required clue is a QR trace on the hotspot `missing_substance`
const content = loadScenarioFromDir(`${defaultScenariosDir()}${SCENARIO}`);
const generated = generateInvestigation({ scenarioId: SCENARIO, seed: SEED }, content);
if (!generated.ok) throw new Error('the seed is expected to pass the gate');
const target = generated.server.clues.find(
  (clue) =>
    clue.captureMode === 'qr' &&
    generated.server.requiredClueIds.includes(clue.id) &&
    clue.discovery.action.type === 'examineHotspot',
);
if (!target || target.discovery.action.type !== 'examineHotspot') throw new Error('no QR clue');
const { hotspotId } = target.discovery.action;
const WAIT = { type: 'wait', minutes: 15 } as const;

let dir: string;
const running: { close(): Promise<void> }[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hs-srv015-'));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((item) => item.close()));
  await rm(dir, { recursive: true, force: true });
});

/** One server process on `dataDir`; closing it forgets every session (memory only). */
async function boot(dataDir = dir) {
  const config = readConfig({
    HS_DATA_DIR: dataDir,
    HS_LOG_LEVEL: 'silent',
    HS_HOST: '127.0.0.1',
  });
  const services = createSessionServices(config);
  // The text the desktop would draw as a QR is in the token store of the session.
  const stores = new Map<string, EvidenceTokenStore>();
  const { qr } = services.qr;
  const attach = qr.attach.bind(qr);
  qr.attach = (session, store) => {
    stores.set(session.id, store);
    attach(session, store);
  };
  const app = buildApp(config, services);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  running.push(app);
  const manager = services.sessions.sessions;
  return {
    app,
    baseUrl,
    manager,
    qr,
    engine: (id: string) => {
      const engine = manager.get(id)?.engine;
      if (!(engine instanceof RecordingEngine)) throw new Error('no recording engine');
      return engine;
    },
    /** The QR text of the session's pending token, as the current process signs it. */
    qrText: (id: string) => {
      const tokenId = (manager.get(id)?.engine as RecordingEngine).playerView().pendingCapture
        ?.tokenId;
      if (!tokenId) throw new Error('nothing pending');
      return stores.get(id)!.payload(tokenId);
    },
  };
}
type Server = Awaited<ReturnType<typeof boot>>;

async function connect(server: Server, creds: CreateSessionResponse) {
  const { sessionId, desktopToken, pairing } = creds;
  const desktop = new FakeDesktop({ baseUrl: server.baseUrl, token: desktopToken, sessionId });
  running.push(desktop);
  expect(await desktop.connect()).toMatchObject({ role: 'desktop', sessionId });
  PlayerView.parse(await desktop.waitForView());
  const phone = await FakePhone.pair({ baseUrl: server.baseUrl, code: pairing.code });
  running.push(phone);
  expect(await phone.connect()).toMatchObject({ role: 'phone', sessionId });
  PhoneView.parse(await phone.waitForView());
  return { desktop, phone };
}
type CreateSessionResponse = ReturnType<typeof CreateSessionResponse.parse>;

async function createGame(server: Server): Promise<CreateSessionResponse> {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { scenarioId: SCENARIO, seed: SEED },
  });
  expect(created.statusCode).toBe(201);
  return CreateSessionResponse.parse(created.json());
}

async function loadGame(server: Server, saveId: string): Promise<CreateSessionResponse> {
  const loaded = await server.app.inject({ method: 'POST', url: `/api/v1/saves/${saveId}/load` });
  expect(loaded.statusCode).toBe(200);
  return CreateSessionResponse.parse(loaded.json());
}

/** `padding` waits so that the hotspot examination is the `atAction`-th action of the journal. */
async function playToPending(desktop: FakeDesktop, atAction: number) {
  const send = async (action: Parameters<FakeDesktop['sendAction']>[0]) => {
    const r = await desktop.sendAction(action);
    expect(r, JSON.stringify([action, r])).toMatchObject({ ok: true });
  };
  await send({ type: 'move', locationId: target!.discovery.locationId });
  await send({ type: 'examineLocation' });
  for (let count = 2; count < atAction - 1; count++) await send(WAIT);
  await send({ type: 'examineHotspot', hotspotId });
}

const parseSave = (text: string) => SaveFile.parse(JSON.parse(text));
const savePath = (saveId: string, root = dir) => join(root, 'saves', `${saveId}.json`);

describe.each([
  ['a pending QR, no checkpoint', 6],
  ['a pending QR issued by the 49th action (the capture is the 50th, checkpoint after it)', 49],
  ['a pending QR issued by the 50th action (checkpoint holds it)', 50],
])('restart with %s', (_name, pendingAt) => {
  test('the game continues from the same state and the pending QR is signed anew', async () => {
    const first = await boot();
    const creds = await createGame(first);
    const { sessionId } = creds;
    const { desktop } = await connect(first, creds);
    await playToPending(desktop, pendingAt);

    const before = first.engine(sessionId);
    const pending = before.playerView().pendingCapture;
    expect(before.snapshot().pendingCapture?.clueId).toBe(target.id);
    expect(pending?.tokenId).toBeTruthy();
    const oldText = first.qrText(sessionId);
    const hashBefore = before.stateHash();
    const minuteBefore = before.playerView().clock.t;
    const file = await readFile(savePath(sessionId), 'utf8');
    expect(parseSave(file).actions).toHaveLength(pendingAt);
    expect(Boolean(parseSave(file).checkpoint)).toBe(pendingAt === 50);
    // Neither credentials nor the QR signature are written.
    expect(file).not.toContain(creds.desktopToken);
    expect(file).not.toContain(creds.pairing.code);
    expect(file).not.toContain(oldText.split(':')[4]!);
    expect(file).not.toContain('hs1:');
    await first.app.close();

    // The process is gone. A new one lists the save (without the seed) and loads it.
    const second = await boot();
    const list = await second.app.inject({ url: '/api/v1/saves' });
    const summaries = SaveList.parse(list.json());
    expect(summaries.map(({ saveId }) => saveId)).toEqual([sessionId]);
    expect(list.body).not.toContain('"seed"');
    expect(list.body).not.toMatch(/culprit|veracity|truth|seed/i);

    const resumed = await loadGame(second, sessionId);
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.desktopToken).not.toBe(creds.desktopToken);
    const after = second.engine(sessionId);
    expect(after.stateHash()).toBe(hashBefore);
    expect(after.playerView().clock.t).toBe(minuteBefore);
    expect(after.playerView().pendingCapture).toEqual(pending);

    // The old QR is dead; the same token with this process's secret is alive.
    const newText = second.qrText(sessionId);
    expect(newText).not.toBe(oldText);
    expect(newText.split(':').slice(0, 4)).toEqual(oldText.split(':').slice(0, 4));
    const session = second.manager.get(sessionId)!;
    expect(await second.qr.scan(session, oldText)).toEqual({ ok: false, error: 'QR_INVALID' });

    // Both roles reconnect; the phone scans over the real socket.
    const clients = await connect(second, resumed);
    expect(await clients.phone.scanQr(newText)).toEqual({ ok: true, clueRef: target.id });
    expect(await clients.phone.scanQr(newText)).toMatchObject({ error: 'QR_ALREADY_USED' });
    const captured = second.engine(sessionId);
    expect(captured.playerView().pendingCapture).toBeUndefined();
    const hashCaptured = captured.stateHash();
    const gallery = captured.phoneView()?.gallery;
    expect(JSON.stringify(gallery)).toContain(target.id);
    // A command after the load goes to the same journal.
    expect(await clients.desktop.sendAction(WAIT)).toMatchObject({ ok: true });
    const hashLater = captured.stateHash();
    expect(parseSave(await readFile(savePath(sessionId), 'utf8')).actions).toHaveLength(
      pendingAt + 2,
    );
    await second.app.close();

    // A third process: the captured clue is in the gallery once, nothing is pending, and no
    // earlier QR works.
    const third = await boot();
    const again = await loadGame(third, sessionId);
    const restored = third.engine(sessionId);
    expect(restored.stateHash()).toBe(hashLater);
    expect(restored.playerView().pendingCapture).toBeUndefined();
    const board = restored.playerView().caseBoard.clues.filter(({ id }) => id === target.id);
    expect(board).toHaveLength(1);
    expect(await third.qr.scan(third.manager.get(sessionId)!, newText)).toEqual({
      ok: false,
      error: 'QR_INVALID',
    });
    expect(again.sessionId).toBe(sessionId);
    expect(hashCaptured).not.toBe(hashLater);
  });

  test('a full replay and a checkpoint restore agree on the hash, before and after the capture', async () => {
    const first = await boot();
    const creds = await createGame(first);
    const { desktop, phone } = await connect(first, creds);
    await playToPending(desktop, pendingAt);
    const { sessionId } = creds;
    const pendingHash = first.engine(sessionId).stateHash();
    // Keep the journal as it is with the QR pending (no capture yet).
    await cp(join(dir, 'saves'), join(dir, 'pending-copy'), { recursive: true });
    expect(await phone.scanQr(first.qrText(sessionId))).toEqual({ ok: true, clueRef: target.id });
    const capturedHash = first.engine(sessionId).stateHash();
    await first.app.close();

    for (const [label, root, expected] of [
      ['pending', join(dir, 'pending-copy'), pendingHash],
      ['captured', join(dir, 'saves'), capturedHash],
    ] as const) {
      const text = await readFile(join(root, `${sessionId}.json`), 'utf8');
      const stripped = parseSave(text);
      delete stripped.checkpoint;
      for (const variant of [parseSave(text), stripped]) {
        const fresh = await mkdtemp(join(tmpdir(), 'hs-srv015-copy-'));
        try {
          await cp(root, join(fresh, 'saves'), { recursive: true });
          await writeFile(join(fresh, 'saves', `${sessionId}.json`), JSON.stringify(variant));
          const server = await boot(fresh);
          await loadGame(server, sessionId);
          expect(server.engine(sessionId).stateHash(), label).toBe(expected);
        } finally {
          await rm(fresh, { recursive: true, force: true });
        }
      }
    }
  });
});

test('a scan after the token expired in game time is refused, also after a restart', async () => {
  const first = await boot();
  const creds = await createGame(first);
  const { desktop } = await connect(first, creds);
  await playToPending(desktop, 6);
  const { sessionId } = creds;
  const { expiresAt } = first.engine(sessionId).snapshot().pendingCapture!;
  await first.app.close();

  const second = await boot();
  const resumed = await loadGame(second, sessionId);
  const clients = await connect(second, resumed);
  const text = second.qrText(sessionId);
  // Wait in the hero's own location until the window is over; the QR keeps its game window.
  while (second.engine(sessionId).playerView().clock.t < expiresAt) {
    expect(await clients.desktop.sendAction({ type: 'wait', minutes: 30 })).toMatchObject({
      ok: true,
    });
  }
  expect(await clients.phone.scanQr(text)).toMatchObject({ ok: false, error: 'QR_EXPIRED' });
});

test('a damaged file is skipped by the list, refused on load, and does not affect other saves', async () => {
  const first = await boot();
  const creds = await createGame(first);
  const { desktop } = await connect(first, creds);
  await playToPending(desktop, 4);
  await first.app.close();
  await writeFile(savePath('broken'), '{not json');
  // A journal whose entry was tampered with.
  const good = parseSave(await readFile(savePath(creds.sessionId), 'utf8'));
  good.actions[1]!.action = { type: 'wait', minutes: 5 };
  await writeFile(savePath('tampered'), JSON.stringify(good));
  // A stale temporary file of a crashed write is removed at start.
  await writeFile(join(dir, 'saves', `${creds.sessionId}.json.abc.tmp`), 'x');

  const second = await boot();
  const ids = SaveList.parse((await second.app.inject({ url: '/api/v1/saves' })).json()).map(
    ({ saveId }) => saveId,
  );
  expect(ids).toContain(creds.sessionId);
  expect(ids).not.toContain('broken');
  expect(await readdir(join(dir, 'saves'))).not.toContain(`${creds.sessionId}.json.abc.tmp`);
  for (const bad of ['broken', 'tampered']) {
    const refused = await second.app.inject({ method: 'POST', url: `/api/v1/saves/${bad}/load` });
    expect(refused.statusCode).toBe(422);
    expect(ErrorResponse.parse(refused.json()).error.code).toBe('SAVE_DESYNC');
  }
  expect((await loadGame(second, creds.sessionId)).sessionId).toBe(creds.sessionId);
});
