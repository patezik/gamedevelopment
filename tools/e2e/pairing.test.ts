import { PhoneView, PlayerView, PROTOCOL_VERSION } from '@hs/protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDesktop, FakePhone } from '@hs/fake-client';
import { afterEach, expect, test } from 'vitest';
import { buildApp } from '../../apps/server/src/app.ts';
import { readConfig } from '../../apps/server/src/config/index.ts';
import { renderMatrix } from '../../apps/server/src/qr/index.ts';
import { createSessionServices } from '../../apps/server/src/routes/generation.ts';
import { CreateSessionResponse } from '../../apps/server/src/routes/sessions.ts';

// INT-001: the pairing path of Godot <-> server <-> phone on the production build of the server
// (createSessionServices + HTTP + WebSocket), with FakeDesktop and FakePhone in place of Godot and
// the app. The manual run on a real Godot and an iPhone: docs/testing/pairing-checklist.md.

const apps: ReturnType<typeof buildApp>[] = [];
const clients: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

test('desktop and phone pair by code and exchange views; a drop resumes', async () => {
  const config = readConfig({ HS_DATA_DIR: mkdtempSync(join(tmpdir(), 'hs-data-')), HS_LOG_LEVEL: 'silent', HS_HOST: '127.0.0.1' });
  const app = buildApp(config, createSessionServices(config));
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  // New game: what Godot does on "Create case".
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { scenarioId: 'sanatorium_winter', seed: 'winter-42' },
  });
  expect(created.statusCode).toBe(201);
  const { sessionId, desktopToken, pairing } = CreateSessionResponse.parse(created.json());

  // The pairing screen draws the matrix of exactly the payload it also prints as text.
  const matrix = await app.inject({
    url: `/api/v1/sessions/${sessionId}/pairing-qr`,
    headers: { authorization: `Bearer ${desktopToken}` },
  });
  expect(matrix.statusCode).toBe(200);
  expect(matrix.json()).toEqual(renderMatrix(pairing.qrPayload));
  expect(pairing.qrPayload).toMatch(new RegExp(`^hs1:pair:[^:]+:\\d+:${pairing.code}$`));

  // Desktop: hello, first view, no phone yet ("Start investigation" must stay disabled).
  const desktop = new FakeDesktop({ baseUrl, token: desktopToken, sessionId });
  clients.push(desktop);
  expect(await desktop.connect()).toMatchObject({ role: 'desktop', sessionId });
  PlayerView.parse(await desktop.waitForView());
  await desktop.waitForPeers(({ phone }) => phone === 'unpaired');

  // Phone: POST /pair with the code, then hello; the desktop sees it online.
  const phone = await FakePhone.pair({ baseUrl, code: pairing.code });
  clients.push(phone);
  expect(await phone.connect()).toMatchObject({ role: 'phone', sessionId });
  PhoneView.parse(await phone.waitForView());
  await desktop.waitForPeers(({ phone: status }) => status === 'online');

  // The code is single-use: a second phone with the same code is refused.
  const reuse = await app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    payload: {
      code: pairing.code,
      deviceName: 'Second phone',
      appVersion: '0.0.0',
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  expect(reuse.statusCode).not.toBe(200);

  // An action by the desktop reaches both roles as view.update with the same state version.
  const phoneUpdate = phone.waitFor('view.update');
  const desktopUpdate = desktop.waitFor('view.update');
  expect(await desktop.sendAction({ type: 'move', locationId: 'loc_doctor_office' })).toMatchObject(
    { ok: true },
  );
  const [own, other] = await Promise.all([desktopUpdate, phoneUpdate]);
  PlayerView.parse(own.payload.view);
  PhoneView.parse(other.payload.view);
  expect(own.payload.stateVersion).toBe(other.payload.stateVersion);

  // Wi-Fi drop: the desktop sees the phone offline, then online again after resume.
  const offline = desktop.waitForPeers(({ phone: status }) => status === 'offline');
  phone.drop();
  await offline;
  const back = desktop.waitForPeers(({ phone: status }) => status === 'online');
  expect(await phone.reconnect()).toMatchObject({ role: 'phone', sessionId });
  await back;

  // After the resume an update still goes to both sides.
  const phoneAgain = phone.waitFor('view.update');
  const desktopAgain = desktop.waitFor('view.update');
  expect(await desktop.sendAction({ type: 'examineLocation' })).toMatchObject({ ok: true });
  const [a, b] = await Promise.all([desktopAgain, phoneAgain]);
  expect(a.payload.stateVersion).toBe(b.payload.stateVersion);

  expect(desktop.violations).toEqual([]);
  expect(phone.violations).toEqual([]);
});

test('the phone unpairs itself: the desktop sees unpaired, the old token is dead, a new code re-pairs', async () => {
  const config = readConfig({ HS_DATA_DIR: mkdtempSync(join(tmpdir(), 'hs-data-')), HS_LOG_LEVEL: 'silent', HS_HOST: '127.0.0.1' });
  const app = buildApp(config, createSessionServices(config));
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { scenarioId: 'sanatorium_winter', seed: 'winter-42' },
  });
  const { sessionId, desktopToken, pairing } = CreateSessionResponse.parse(created.json());

  const desktop = new FakeDesktop({ baseUrl, token: desktopToken, sessionId });
  clients.push(desktop);
  await desktop.connect();
  const phone = await FakePhone.pair({ baseUrl, code: pairing.code });
  clients.push(phone);
  await phone.connect();
  await desktop.waitForPeers(({ phone: status }) => status === 'online');

  // «Отвязать устройство» in the app: DELETE with the device token.
  const unpaired = desktop.waitForPeers(({ phone: status }) => status === 'unpaired');
  await phone.unpair();
  await unpaired;
  await expect(phone.unpair()).rejects.toThrow();

  // The desktop shows a new code and the same session pairs again.
  const again = await FakePhone.pairWith(desktop);
  clients.push(again);
  await again.connect();
  await desktop.waitForPeers(({ phone: status }) => status === 'online');
  expect(desktop.violations).toEqual([]);
});
