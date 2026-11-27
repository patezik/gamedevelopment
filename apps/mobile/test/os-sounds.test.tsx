import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { act, render, waitFor } from '@testing-library/react-native';
import { CameraApp } from '../src/os-apps/camera/App';
import { SOUNDS } from '../src/os/feedback';
import { NotificationCenter } from '../src/os/NotificationCenter';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useQrStore } from '../src/stores/qrStore';
import { useSettingsStore } from '../src/stores/settingsStore';

const mockPlay = jest.fn();
let mockOnScan: ((e: { data: string }) => void) | undefined;

jest.mock(
  'expo-audio',
  () => ({
    createAudioPlayer: (source: unknown) => ({
      play: () => mockPlay(source),
      seekTo: () => Promise.resolve(),
    }),
  }),
  { virtual: true },
);
jest.mock(
  'expo-haptics',
  () => ({
    notificationAsync: () => Promise.resolve(),
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  }),
  { virtual: true },
);
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
  CameraView: (props: { onBarcodeScanned?: (e: { data: string }) => void }) => {
    mockOnScan = props.onBarcodeScanned;
    return null;
  },
}));
jest.mock('../src/connection/gameConnection', () => ({ sendQrScan: () => true }));
// Jest turns every asset into the same stub, so give each file its own id to tell them apart.
jest.mock('../assets/audio/notify.wav', () => ({ __esModule: true, default: 11 }));
jest.mock('../assets/audio/message.wav', () => ({ __esModule: true, default: 12 }));
jest.mock('../assets/audio/ring.wav', () => ({ __esModule: true, default: 13 }));
jest.mock('../assets/audio/call_end.wav', () => ({ __esModule: true, default: 14 }));
jest.mock('../assets/audio/scan_ok.wav', () => ({ __esModule: true, default: 15 }));
jest.mock('../assets/audio/error.wav', () => ({ __esModule: true, default: 16 }));

const base = PhoneView.parse(fixture);
const quiet: PhoneView = { ...base, notifications: [], activeCall: undefined };
const note = {
  id: 'nt-a',
  appId: 'messages',
  title: 'Новое сообщение',
  text: 'Вы где?',
  at: 1400,
  read: false,
};
const contact = quiet.contacts[0]!;
const ringing: PhoneView = {
  ...quiet,
  activeCall: { callId: 'c2', contactId: contact.id, state: 'ringing', lines: [], choices: [] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOnScan = undefined;
  useSettingsStore.setState({ vibration: true, sound: true });
  useQrStore.getState().reset();
  useConnectionStore.setState({ status: 'online' });
});

test('every OS sound is its own file', () => {
  const sources = Object.values(SOUNDS);
  expect(Object.keys(SOUNDS).sort()).toEqual(
    ['callEnd', 'error', 'message', 'notify', 'ring', 'scanOk'].sort(),
  );
  expect(new Set(sources).size).toBe(sources.length);
});

test('message, notification, ring and call end each play their own sound', async () => {
  const { rerender } = await render(<NotificationCenter view={quiet} />);
  await rerender(<NotificationCenter view={{ ...quiet, notifications: [note] }} />);
  const other = { ...note, id: 'nt-b', appId: 'files' };
  await rerender(<NotificationCenter view={{ ...quiet, notifications: [note, other] }} />);
  await rerender(<NotificationCenter view={ringing} />);
  await rerender(<NotificationCenter view={quiet} />);
  expect(mockPlay.mock.calls.map((c) => c[0])).toEqual([
    SOUNDS.message,
    SOUNDS.notify,
    SOUNDS.ring,
    SOUNDS.callEnd,
  ]);
});

test('with sound off a call rings and ends silently', async () => {
  useSettingsStore.setState({ sound: false });
  const { rerender } = await render(<NotificationCenter view={quiet} />);
  await rerender(<NotificationCenter view={ringing} />);
  await rerender(<NotificationCenter view={quiet} />);
  expect(mockPlay).not.toHaveBeenCalled();
});

test('a saved clue plays the scan sound, a refusal the error sound', async () => {
  await render(<CameraApp />);
  await act(async () => useQrStore.getState().setResult({ ok: true, clueRef: 'c1' }));
  expect(mockPlay).toHaveBeenLastCalledWith(SOUNDS.scanOk);
  await act(async () => useQrStore.getState().setResult({ ok: false, error: 'QR_EXPIRED' }));
  expect(mockPlay).toHaveBeenLastCalledWith(SOUNDS.error);
});

test('a rejected scan plays the error sound, and nothing plays with sound off', async () => {
  await render(<CameraApp />);
  await waitFor(() => expect(mockOnScan).toBeDefined());
  await act(async () => mockOnScan?.({ data: 'exp://1.2.3.4:8081' }));
  expect(mockPlay).toHaveBeenCalledWith(SOUNDS.error);
  mockPlay.mockClear();
  useSettingsStore.setState({ sound: false });
  await act(async () => useQrStore.getState().setResult({ ok: true, clueRef: 'c2' }));
  expect(mockPlay).not.toHaveBeenCalled();
});
