import { afterEach, expect, test, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { phoneView, playerView, startServer } from '../test/harness.ts';
import {
  FakeClientHttpError,
  FakeDesktop,
  FakePhone,
  runCommand,
  type FakeClient,
} from './index.ts';

type Server = Awaited<ReturnType<typeof startServer>>;
const servers: Server[] = [];
const clients: FakeClient[] = [];

async function setup(options?: Parameters<typeof startServer>[0]) {
  const server = await startServer(options);
  servers.push(server);
  const desktop = new FakeDesktop({
    baseUrl: server.baseUrl,
    token: server.desktopToken,
    sessionId: server.session.id,
  });
  clients.push(desktop);
  return { ...server, desktop };
}

async function pairedPhone(desktop: FakeDesktop) {
  const phone = await FakePhone.pairWith(desktop);
  clients.push(phone);
  return phone;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
});

test('desktop and phone connect, receive views and see each other online', async () => {
  const { desktop, session } = await setup();
  const welcome = await desktop.connect();
  expect(welcome).toMatchObject({ role: 'desktop', sessionId: session.id });
  expect(await desktop.waitForView()).toEqual(playerView);
  await desktop.waitForPeers(({ phone }) => phone === 'unpaired');

  const phone = await pairedPhone(desktop);
  await phone.connect();
  expect(await phone.waitForView()).toEqual(phoneView);
  await desktop.waitForPeers(({ phone: status }) => status === 'online');
  expect(phone.violations).toEqual([]);
  expect(desktop.violations).toEqual([]);
});

test('sendAction returns the result of the action; a phone cannot send desktop actions', async () => {
  const { desktop, dispatch } = await setup();
  await desktop.connect();
  expect(await desktop.sendAction({ type: 'wait', minutes: 15 })).toMatchObject({
    ok: true,
    minutesSpent: 15,
  });
  expect(dispatch).toHaveBeenCalledWith('desktop', { type: 'wait', minutes: 15 });

  const phone = await pairedPhone(desktop);
  await phone.connect();
  expect(await phone.sendAction({ type: 'wait', minutes: 5 })).toMatchObject({
    ok: false,
    error: 'ACTION_INVALID',
  });
});

test('scanQr sends the payload through the real QR service', async () => {
  const { desktop, store, dispatch } = await setup();
  const phone = await pairedPhone(desktop);
  await phone.connect();
  const tokenId = store.issue('clue_ledger', 120);
  expect((await desktop.evidenceQr(tokenId)).size).toBeGreaterThan(0);
  expect(await phone.scanQr(store.payload(tokenId))).toEqual({ ok: true, clueRef: 'clue_ledger' });
  expect(dispatch).toHaveBeenCalledWith('phone', { type: 'captureEvidence', tokenId });
  expect(await phone.scanQr('garbage')).toMatchObject({ ok: false });
});

test('REST errors carry the status and the error code of the server', async () => {
  const { desktop, baseUrl } = await setup();
  await expect(FakePhone.pair({ baseUrl, code: 'ZZZZZZ' })).rejects.toMatchObject({
    status: 400,
    code: 'PAIRING_CODE_INVALID',
  });
  await expect(FakePhone.pair({ baseUrl, code: 'ZZZZZZ' })).rejects.toBeInstanceOf(
    FakeClientHttpError,
  );
  await desktop.connect();
  const bad = new FakeDesktop({ baseUrl, token: 'x'.repeat(43), sessionId: desktop.sessionId! });
  await expect(bad.createPairingCode()).rejects.toMatchObject({ status: 401 });
});

test('a wrong token fails to connect and says why', async () => {
  const { baseUrl } = await setup();
  const stranger = new FakeDesktop({ baseUrl, token: 'nope' });
  clients.push(stranger);
  await expect(stranger.connect()).rejects.toThrow(/UNAUTHORIZED/);
});

test('unpairing closes the phone with DEVICE_REVOKED and the desktop sees it unpaired', async () => {
  const { desktop } = await setup();
  await desktop.connect();
  const phone = await pairedPhone(desktop);
  await phone.connect();
  const closed = phone.waitForClose();
  await desktop.unpairPhone();
  expect((await closed).reason).toBe('DEVICE_REVOKED');
  await desktop.waitForPeers(({ phone: status }) => status === 'unpaired');
});

test('a drop and reconnect resume from the last seq and replay what was missed', async () => {
  const { desktop, gateway, session } = await setup();
  await desktop.connect();
  await desktop.waitForView();
  await desktop.waitForPeers(() => true);
  const before = desktop.lastSeq;
  desktop.drop();
  await desktop.waitForClose();
  gateway.publishEvent(session, 'desktop', { type: 'gameOver' });
  await desktop.reconnect();
  await vi.waitFor(() => expect(desktop.events).toContainEqual({ type: 'gameOver' }));
  expect(desktop.lastSeq).toBeGreaterThan(before);
  expect(desktop.messages.filter((m) => m.type === 'resync')).toEqual([]);
});

test('chaos: random drops reconnect on their own and the session keeps working', async () => {
  const { desktop, baseUrl, desktopToken } = await setup();
  const rolls = [0, 1, 0, 1, 0, 1];
  let next = 0;
  const chaotic = new FakeDesktop({
    baseUrl,
    token: desktopToken,
    chaos: {
      intervalMs: 20,
      dropProbability: 0.5,
      random: () => rolls[next++ % rolls.length]!,
      reconnectDelayMs: 5,
    },
  });
  clients.push(chaotic, desktop);
  await chaotic.connect();
  await vi.waitFor(() => expect(chaotic.reconnects).toBeGreaterThanOrEqual(3), { timeout: 4000 });
  expect(chaotic.drops).toBeGreaterThanOrEqual(3);
  await vi.waitFor(() => expect(chaotic.connected).toBe(true));
  await chaotic.ping();
  expect(chaotic.violations).toEqual([]);
});

test('an invalid server message is a violation and fails the wait', async () => {
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  fake.on('connection', (socket) =>
    socket.on('message', () =>
      socket.send(JSON.stringify({ v: 1, id: 'x', type: 'welcome', payload: {} })),
    ),
  );
  await new Promise((resolve) => fake.once('listening', resolve));
  const { port } = fake.address() as { port: number };
  const desktop = new FakeDesktop({ baseUrl: `http://127.0.0.1:${port}`, token: 't' });
  clients.push(desktop);
  await expect(desktop.connect()).rejects.toThrow(/Invalid welcome/);
  expect(desktop.violations).toHaveLength(1);
  desktop.drop();
  await new Promise((resolve) => fake.close(resolve));
});

test('sending while disconnected fails clearly, and tokens never appear in JSON', async () => {
  const { desktop, desktopToken } = await setup();
  expect(() => desktop.send({ type: 'ping', payload: {} })).toThrow('Not connected');
  expect(JSON.stringify(desktop)).not.toContain(desktopToken);
  await desktop.connect();
  await expect(desktop.waitFor('pong', () => true, 20)).rejects.toThrow('Timed out');
});

test('the REPL drives a session and never prints a token', async () => {
  const { desktop, baseUrl, desktopToken } = await setup();
  const out: string[] = [];
  const run = async (context: Parameters<typeof runCommand>[0], line: string) =>
    out.push(...((await runCommand(context, line)) ?? ['<quit>']));

  const desktopContext = { role: 'desktop' as const, baseUrl, client: desktop as FakeClient };
  await run(desktopContext, 'connect');
  await run(desktopContext, 'action {"type":"wait","minutes":15}');
  await run(desktopContext, 'ping');
  await run(desktopContext, 'view');
  await run(desktopContext, 'code');
  const code = /pairing code (\w{6})/.exec(out.join('\n'))?.[1];
  expect(code).toBeDefined();

  const phoneContext = {
    role: 'phone' as const,
    baseUrl,
    client: undefined as FakeClient | undefined,
  };
  await run(phoneContext, 'view');
  await run(phoneContext, `pair ${code}`);
  clients.push(phoneContext.client!);
  await run(phoneContext, 'connect');
  await run(phoneContext, 'scan not-a-qr');
  await run(phoneContext, 'status');
  await run(phoneContext, 'frobnicate');
  await run(desktopContext, 'action {"type":"nonsense"}');
  await run(desktopContext, 'unpair');
  await run(phoneContext, 'quit');

  const text = out.join('\n');
  expect(text).toContain('"ok":true');
  expect(text).toContain('connected as phone');
  expect(text).toContain('No client yet');
  expect(text).toContain('unknown command');
  expect(text).toContain('error:');
  expect(text).toContain('phone unpaired');
  expect(text).toContain('<quit>');
  expect(text).not.toContain(desktopToken);
  expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/); // no session or device token
});

test('chaos: a roll at or above the probability does not drop the connection', async () => {
  const { baseUrl, desktopToken } = await setup();
  const calm = new FakeDesktop({
    baseUrl,
    token: desktopToken,
    chaos: { intervalMs: 10, dropProbability: 0.5, random: () => 0.5 },
  });
  clients.push(calm);
  await calm.connect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(calm.drops).toBe(0);
  expect(calm.connected).toBe(true);
});
