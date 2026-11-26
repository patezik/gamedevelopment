import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { act, render, screen } from '@testing-library/react-native';
import OsHome from '../app/os/index';
import { usePhoneStore } from '../src/stores/phoneStore';
import { useSettingsStore } from '../src/stores/settingsStore';

const mockNotificationAsync = jest.fn(() => Promise.resolve());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock(
  'expo-haptics',
  () => ({
    notificationAsync: (...args: unknown[]) => mockNotificationAsync(...(args as [])),
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  }),
  { virtual: true },
);
jest.mock(
  'expo-audio',
  () => ({ createAudioPlayer: () => ({ play: jest.fn(), seekTo: () => Promise.resolve() }) }),
  { virtual: true },
);

const base = PhoneView.parse(fixture);
const quiet: PhoneView = { ...base, notifications: [], activeCall: undefined };
const incoming = {
  id: 'nt-live',
  appId: 'messages',
  title: 'Пришло по сети',
  text: 'Вы где?',
  at: 1400,
  read: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  usePhoneStore.getState().clear();
});

test('a server view.update shows a new notification on the home screen and vibrates', async () => {
  useSettingsStore.setState({ vibration: true, sound: true });
  expect(usePhoneStore.getState().applyUpdate(1, quiet)).toBe(true);
  await render(<OsHome />);
  expect(screen.queryByText('Пришло по сети')).toBeNull();
  await act(async () => {
    usePhoneStore.getState().applyUpdate(2, { ...quiet, notifications: [incoming] });
  });
  expect(screen.getByText('Пришло по сети')).toBeTruthy();
  expect(mockNotificationAsync).toHaveBeenCalledTimes(1);
});

test('with vibration off the toast still shows but the phone does not vibrate', async () => {
  useSettingsStore.setState({ vibration: false, sound: true });
  usePhoneStore.getState().applyUpdate(1, quiet);
  await render(<OsHome />);
  await act(async () => {
    usePhoneStore.getState().applyUpdate(2, { ...quiet, notifications: [incoming] });
  });
  expect(screen.getByText('Пришло по сети')).toBeTruthy();
  expect(mockNotificationAsync).not.toHaveBeenCalled();
});
