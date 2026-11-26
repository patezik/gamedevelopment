import { ERROR_CODES, PROTOCOL_VERSION } from '@hs/protocol';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { WsClient, type SocketLike } from '../src/connection/WsClient';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useQrStore } from '../src/stores/qrStore';
import { CameraApp } from '../src/os-apps/camera/App';
import {
  ERROR_MESSAGES,
  MESSAGE_NOT_GAME_CODE,
  MESSAGE_OFFLINE,
  MESSAGE_PAIRING_CODE,
  MESSAGE_SAVED,
  qrResultMessage,
} from '../src/os-apps/camera/errors';
import { DEBOUNCE_MS, handleScan, type ScanDeps } from '../src/os-apps/camera/handleScan';

const EV = 'hs1:ev:01234567:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA';

function deps(over: Partial<ScanDeps> = {}): ScanDeps {
  return { now: 10_000, last: null, online: true, send: jest.fn(() => true), ...over };
}

describe('handleScan', () => {
  test('sends an evidence code and remembers it', () => {
    const d = deps();
    const r = handleScan(EV, d);
    expect(r.outcome).toEqual({ kind: 'sent' });
    expect(d.send).toHaveBeenCalledWith(EV);
    expect(r.last).toEqual({ raw: EV, at: 10_000 });
  });

  test('debounces the same code for 2 s, then sends again', () => {
    const first = handleScan(EV, deps());
    const d2 = deps({ now: 10_000 + DEBOUNCE_MS - 1, last: first.last });
    expect(handleScan(EV, d2).outcome).toEqual({ kind: 'ignored' });
    expect(d2.send).not.toHaveBeenCalled();
    const d3 = deps({ now: 10_000 + DEBOUNCE_MS, last: first.last });
    expect(handleScan(EV, d3).outcome).toEqual({ kind: 'sent' });
  });

  test('a different code inside the window is not debounced', () => {
    const first = handleScan(EV, deps());
    const other = `${EV}x`;
    const d = deps({ now: 10_100, last: first.last });
    expect(handleScan(other, d).outcome).toEqual({ kind: 'sent' });
  });

  test.each(['exp://192.168.1.5:8081', 'https://example.com', 'hello', ''])(
    'rejects %p as not a game code without sending',
    (raw) => {
      const d = deps();
      expect(handleScan(raw, d).outcome).toEqual({
        kind: 'rejected',
        message: MESSAGE_NOT_GAME_CODE,
      });
      expect(d.send).not.toHaveBeenCalled();
    },
  );

  test('a pairing QR gets its own hint and is not sent', () => {
    const d = deps();
    expect(handleScan('hs1:pair:h:7420:ABC123', d).outcome).toEqual({
      kind: 'rejected',
      message: MESSAGE_PAIRING_CODE,
    });
    expect(d.send).not.toHaveBeenCalled();
  });

  test('offline: nothing is sent', () => {
    const d = deps({ online: false });
    expect(handleScan(EV, d).outcome).toEqual({ kind: 'rejected', message: MESSAGE_OFFLINE });
    expect(d.send).not.toHaveBeenCalled();
  });

  test('a failed send is reported as no connection', () => {
    const d = deps({ send: jest.fn(() => false) });
    expect(handleScan(EV, d).outcome).toEqual({ kind: 'rejected', message: MESSAGE_OFFLINE });
  });
});

describe('error messages', () => {
  test('every server error code has a non-empty message', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  test('qr results map to distinct texts for the QR codes', () => {
    expect(qrResultMessage({ ok: true })).toBe(MESSAGE_SAVED);
    const texts = (
      ['QR_INVALID', 'QR_EXPIRED', 'QR_ALREADY_USED', 'QR_WRONG_SESSION'] as const
    ).map((error) => qrResultMessage({ ok: false, error }));
    expect(new Set(texts).size).toBe(4);
    expect(qrResultMessage({ ok: false })).toBe(ERROR_MESSAGES.INTERNAL);
  });
});

class MockSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  receive(type: string, payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: PROTOCOL_VERSION, type, id: 's', payload }) });
  }
}

describe('WsClient qr.scan', () => {
  const device = { host: 'h', port: 1, sessionId: 's', deviceToken: 't', wsPath: '/ws' };

  function setup() {
    const socket = new MockSocket();
    const client = new WsClient({
      device,
      appVersion: '1',
      onRevoked: () => {},
      createSocket: () => socket,
    });
    useQrStore.getState().reset();
    client.start();
    return { socket, client };
  }
  const welcome = {
    sessionId: 's',
    role: 'phone',
    protocolVersion: 1,
    serverVersion: '0',
    stateVersion: 1,
    lastSeq: 0,
  };

  test('not sent before welcome, sent after, result lands in the store', () => {
    jest.useFakeTimers();
    const { socket, client } = setup();
    socket.onopen?.();
    expect(client.sendQrScan(EV)).toBe(false);
    socket.receive('welcome', welcome);
    expect(client.sendQrScan(EV)).toBe(true);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'qr.scan', payload: { raw: EV } });
    socket.receive('qr.result', { ok: false, error: 'QR_EXPIRED' });
    expect(useQrStore.getState().result).toEqual({
      ok: false,
      error: 'QR_EXPIRED',
      clueRef: undefined,
    });
    client.stop();
    jest.useRealTimers();
  });

  test('a dropped socket forgets the pending scan', () => {
    jest.useFakeTimers();
    const { socket, client } = setup();
    socket.onopen?.();
    socket.receive('welcome', welcome);
    useQrStore.getState().markSent();
    socket.onclose?.();
    expect(useQrStore.getState().pending).toBe(false);
    client.stop();
    jest.useRealTimers();
  });
});

let mockOnScan: ((e: { data: string }) => void) | undefined;
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
const mockRequest = jest.fn();
const mockSend = jest.fn();

jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockPermission, mockRequest],
  CameraView: (props: { onBarcodeScanned?: (e: { data: string }) => void }) => {
    mockOnScan = props.onBarcodeScanned;
    return null;
  },
}));
jest.mock('../src/connection/gameConnection', () => ({
  sendQrScan: (raw: string) => mockSend(raw),
}));

describe('CameraApp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReturnValue(true);
    mockPermission = { granted: true, canAskAgain: true };
    useQrStore.getState().reset();
    useConnectionStore.setState({ status: 'online' });
  });

  test('a scan sends qr.scan and shows the server result', async () => {
    await render(<CameraApp />);
    await waitFor(() => expect(mockOnScan).toBeDefined());
    await act(async () => mockOnScan?.({ data: EV }));
    expect(mockSend).toHaveBeenCalledWith(EV);
    expect(await screen.findByText('Проверяем код…')).toBeTruthy();
    await act(async () => useQrStore.getState().setResult({ ok: false, error: 'QR_ALREADY_USED' }));
    expect(await screen.findByText(ERROR_MESSAGES.QR_ALREADY_USED)).toBeTruthy();
  });

  test('an Expo Go QR shows "not a game code" and sends nothing', async () => {
    await render(<CameraApp />);
    await waitFor(() => expect(mockOnScan).toBeDefined());
    await act(async () => mockOnScan?.({ data: 'exp://1.2.3.4:8081' }));
    expect(await screen.findByText(MESSAGE_NOT_GAME_CODE)).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('offline shows the banner and does not send', async () => {
    useConnectionStore.setState({ status: 'offline' });
    await render(<CameraApp />);
    await waitFor(() => expect(mockOnScan).toBeDefined());
    await act(async () => mockOnScan?.({ data: EV }));
    expect(await screen.findByText(MESSAGE_OFFLINE)).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('no permission: explanation and a request button', async () => {
    mockPermission = { granted: false, canAskAgain: true };
    await render(<CameraApp />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Разрешить камеру' }));
    expect(mockRequest).toHaveBeenCalled();
  });

  test('permission denied for good: link to settings instead of a request', async () => {
    mockPermission = { granted: false, canAskAgain: false };
    await render(<CameraApp />);
    expect(screen.queryByText('Разрешить камеру')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Открыть настройки' })).toBeTruthy();
  });
});
