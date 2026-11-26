import { PROTOCOL_VERSION } from '@hs/protocol';
import phoneFixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import playerFixture from '@hs/protocol/fixtures/views/player-view.mid.json';
import { render, screen } from '@testing-library/react-native';
import { OfflineBanner } from '../src/connection/OfflineBanner';
import {
  backoffDelay,
  PING_INTERVAL_MS,
  SILENCE_TIMEOUT_MS,
  WsClient,
  type SocketLike,
} from '../src/connection/WsClient';
import { useConnectionStore } from '../src/stores/connectionStore';
import { usePhoneStore } from '../src/stores/phoneStore';

class MockSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ type: string; payload: Record<string, unknown>; ack?: number }> = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  receive(type: string, payload: Record<string, unknown>, seq?: number) {
    const msg = {
      v: PROTOCOL_VERSION,
      type,
      id: 's',
      payload,
      ...(seq === undefined ? {} : { seq }),
    };
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.onclose?.();
  }
}

const device = {
  host: 'h',
  port: 7420,
  sessionId: 's',
  deviceToken: 'secret-token',
  wsPath: '/ws',
};
let sockets: MockSocket[];
let onRevoked: jest.Mock;

function makeClient() {
  return new WsClient({
    device,
    appVersion: '1.2.3',
    random: () => 0.5, // zero jitter
    onRevoked,
    createSocket: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
  });
}

const welcome = {
  sessionId: 's',
  role: 'phone',
  protocolVersion: 1,
  serverVersion: '0',
  stateVersion: 3,
  lastSeq: 7,
};
const last = () => sockets[sockets.length - 1]!;
const status = () => useConnectionStore.getState().status;

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  onRevoked = jest.fn();
  useConnectionStore.setState({ status: 'unpaired', lastSeq: 0, stateVersion: 0, lastError: null });
  usePhoneStore.getState().clear();
});
afterEach(() => jest.useRealTimers());

test('first hello has no resume, carries role, token and version', () => {
  const c = makeClient();
  c.start();
  expect(last().url).toBe('ws://h:7420/ws');
  expect(status()).toBe('connecting');
  last().open();
  expect(last().sent[0]).toMatchObject({
    type: 'hello',
    payload: { role: 'phone', token: 'secret-token', appVersion: '1.2.3' },
  });
  expect(last().sent[0]!.payload).not.toHaveProperty('resume');
  last().receive('welcome', welcome);
  expect(status()).toBe('online');
  c.stop();
});

test('reconnect sends hello with resume (lastSeq, stateVersion) after a drop', () => {
  const c = makeClient();
  c.start();
  last().open();
  last().receive('welcome', { ...welcome, stateVersion: 0, lastSeq: 0 });
  last().receive('view.update', { stateVersion: 5, view: phoneFixture }, 9);
  last().drop();
  expect(status()).toBe('reconnecting');
  jest.advanceTimersByTime(500);
  expect(sockets).toHaveLength(2);
  last().open();
  expect(last().sent[0]!.payload.resume).toEqual({ lastSeq: 9, stateVersion: 5 });
  c.stop();
});

test('backoff doubles 0.5 -> 8 s, resets after welcome, status goes offline after 3 failures', () => {
  expect([0, 1, 2, 3, 4, 5, 9].map((a) => backoffDelay(a, () => 0.5))).toEqual([
    500, 1000, 2000, 4000, 8000, 8000, 8000,
  ]);
  expect(backoffDelay(0, () => 0)).toBe(400);
  expect(backoffDelay(0, () => 1)).toBe(600);

  const c = makeClient();
  c.start();
  last().drop();
  expect(status()).toBe('reconnecting');
  jest.advanceTimersByTime(499);
  expect(sockets).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(sockets).toHaveLength(2);
  last().drop();
  jest.advanceTimersByTime(999);
  expect(sockets).toHaveLength(2);
  jest.advanceTimersByTime(1);
  expect(sockets).toHaveLength(3);
  last().drop();
  expect(status()).toBe('offline');
  jest.advanceTimersByTime(2000);
  expect(sockets).toHaveLength(4);
  last().open();
  last().receive('welcome', welcome);
  expect(status()).toBe('online');
  last().drop();
  jest.advanceTimersByTime(500); // back to the first delay
  expect(sockets).toHaveLength(5);
  c.stop();
});

test('pings every 10 s with ack, only after welcome', () => {
  const c = makeClient();
  c.start();
  last().open();
  jest.advanceTimersByTime(PING_INTERVAL_MS);
  expect(last().sent.filter((m) => m.type === 'ping')).toHaveLength(0);
  last().receive('welcome', welcome);
  last().receive('event', { event: { type: 'gameOver' } }, 11);
  jest.advanceTimersByTime(PING_INTERVAL_MS);
  const pings = last().sent.filter((m) => m.type === 'ping');
  expect(pings).toHaveLength(1);
  expect(pings[0]!.ack).toBe(11);
  c.stop();
});

test('silence for 30 s counts as a dropped link', () => {
  const c = makeClient();
  c.start();
  last().open();
  last().receive('welcome', welcome);
  jest.advanceTimersByTime(SILENCE_TIMEOUT_MS - 1);
  expect(status()).toBe('online');
  last().receive('pong', {});
  jest.advanceTimersByTime(SILENCE_TIMEOUT_MS - 1);
  expect(status()).toBe('online');
  jest.advanceTimersByTime(1);
  expect(status()).toBe('reconnecting');
  expect(sockets[0]!.closed).toBe(true);
  c.stop();
});

test('invalid messages are ignored and logged without payload', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const c = makeClient();
  c.start();
  last().open();
  last().receive('welcome', welcome);
  last().onmessage?.({ data: 'not json' });
  last().onmessage?.({
    data: JSON.stringify({ v: 1, type: 'view.update', id: 'x', payload: { stateVersion: 'a' } }),
  });
  last().receive('view.update', { stateVersion: 9, view: { culpritIds: ['x'] } });
  last().receive('nonsense', {});
  expect(warn).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('culpritIds');
  expect(usePhoneStore.getState().view).toBeNull();
  expect(status()).toBe('online');
  warn.mockRestore();
  c.stop();
});

test('view.update: stateVersion only grows, PlayerView is rejected', () => {
  const c = makeClient();
  c.start();
  last().open();
  last().receive('welcome', { ...welcome, stateVersion: 0 });
  last().receive('view.update', { stateVersion: 4, view: phoneFixture });
  expect(usePhoneStore.getState().stateVersion).toBe(4);
  const next = { ...phoneFixture, status: { ...phoneFixture.status, battery: 1 } };
  last().receive('view.update', { stateVersion: 4, view: next });
  last().receive('view.update', { stateVersion: 3, view: next });
  expect(usePhoneStore.getState().view?.status.battery).toBe(phoneFixture.status.battery);
  last().receive('view.update', { stateVersion: 5, view: playerFixture });
  expect(usePhoneStore.getState().stateVersion).toBe(4);
  last().receive('view.update', { stateVersion: 6, view: next });
  expect(usePhoneStore.getState().view?.status.battery).toBe(1);
  expect(useConnectionStore.getState().stateVersion).toBe(6);
  c.stop();
});

test('resync and a restarted server accept a lower stateVersion', () => {
  const c = makeClient();
  c.start();
  last().open();
  last().receive('welcome', { ...welcome, stateVersion: 0 });
  last().receive('view.update', { stateVersion: 8, view: phoneFixture }, 12);
  last().receive('resync', { reason: 'buffer' });
  last().receive('view.update', { stateVersion: 2, view: phoneFixture });
  expect(usePhoneStore.getState().stateVersion).toBe(2);
  // server restarted: welcome reports an older state, the next hello must not resume past it
  last().drop();
  jest.advanceTimersByTime(500);
  last().open();
  last().receive('welcome', { ...welcome, stateVersion: 0, lastSeq: 1 });
  expect(usePhoneStore.getState().stateVersion).toBeNull();
  expect(useConnectionStore.getState().lastSeq).toBe(1);
  last().receive('view.update', { stateVersion: 1, view: phoneFixture });
  expect(usePhoneStore.getState().stateVersion).toBe(1);
  c.stop();
});

test('DEVICE_REVOKED stops reconnecting, clears the view and notifies', () => {
  const c = makeClient();
  c.start();
  last().open();
  last().receive('welcome', { ...welcome, stateVersion: 0 });
  last().receive('view.update', { stateVersion: 1, view: phoneFixture });
  last().receive('error', { code: 'DEVICE_REVOKED', message: 'revoked' });
  expect(onRevoked).toHaveBeenCalledTimes(1);
  expect(status()).toBe('unpaired');
  expect(usePhoneStore.getState().view).toBeNull();
  jest.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.closed).toBe(true);
});

test('PROTOCOL_MISMATCH is fatal: no retries, error kept', () => {
  const c = makeClient();
  c.start();
  last().open();
  last().receive('error', { code: 'PROTOCOL_MISMATCH', message: 'v' });
  last().drop();
  jest.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
  expect(useConnectionStore.getState().lastError?.code).toBe('PROTOCOL_MISMATCH');
});

test('background pauses without retries, foreground reconnects with resume', () => {
  const c = makeClient();
  c.start();
  last().open();
  last().receive('welcome', { ...welcome, stateVersion: 0 });
  last().receive('view.update', { stateVersion: 2, view: phoneFixture }, 4);
  c.pause();
  expect(status()).toBe('offline');
  expect(sockets[0]!.closed).toBe(true);
  jest.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
  c.resume();
  expect(sockets).toHaveLength(2);
  last().open();
  expect(last().sent[0]!.payload.resume).toEqual({ lastSeq: 4, stateVersion: 2 });
  c.stop();
});

test('the token is never logged', () => {
  const spies = [
    jest.spyOn(console, 'log'),
    jest.spyOn(console, 'warn'),
    jest.spyOn(console, 'error'),
  ];
  spies.forEach((s) => s.mockImplementation(() => {}));
  const c = makeClient();
  c.start();
  last().open();
  last().onmessage?.({ data: 'garbage' });
  last().drop();
  expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain('secret-token');
  spies.forEach((s) => s.mockRestore());
  c.stop();
});

test.each([
  ['unpaired', false],
  ['connecting', false],
  ['online', false],
  ['reconnecting', true],
  ['offline', true],
] as const)('banner for status %s: %s', async (s, shown) => {
  useConnectionStore.setState({ status: s });
  await render(<OfflineBanner />);
  expect(screen.queryByText('Нет связи с игрой') !== null).toBe(shown);
});
