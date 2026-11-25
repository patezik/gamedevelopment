import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import OsLayout from '../app/os/_layout';
import { usePhoneStore } from '../src/stores/phoneStore';
import { useSettingsStore } from '../src/stores/settingsStore';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 24, bottom: 12, left: 0, right: 0 }),
}));

const mockNotificationAsync = jest.fn(() => Promise.resolve());
let mockRoute = 'home';
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => ({ appId: mockRoute }),
  Slot: () => {
    const Component =
      mockRoute === 'home'
        ? require('../app/os/index').default
        : require('../app/os/[appId]').default;
    return <Component />;
  },
}));
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
  mockRoute = 'home';
  usePhoneStore.getState().clear();
});

test('a server view.update shows a new notification on the home screen and vibrates', async () => {
  useSettingsStore.setState({ vibration: true, sound: true });
  expect(usePhoneStore.getState().applyUpdate(1, quiet)).toBe(true);
  await render(<OsLayout />);
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
  await render(<OsLayout />);
  await act(async () => {
    usePhoneStore.getState().applyUpdate(2, { ...quiet, notifications: [incoming] });
  });
  expect(screen.getByText('Пришло по сети')).toBeTruthy();
  expect(mockNotificationAsync).not.toHaveBeenCalled();
});

test('notifications and calls remain visible inside an app without replaying feedback on navigation', async () => {
  useSettingsStore.setState({ vibration: true, sound: true });
  usePhoneStore.getState().applyUpdate(1, quiet);
  const { rerender } = await render(<OsLayout />);
  mockRoute = 'notes';
  await rerender(<OsLayout />);
  await act(async () => {
    usePhoneStore.getState().applyUpdate(2, { ...quiet, notifications: [incoming] });
  });
  expect(screen.getByText('Пришло по сети')).toBeTruthy();
  expect(mockNotificationAsync).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole('alert'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/os/[appId]', params: { appId: 'messages' } });
  mockRoute = 'home';
  await rerender(<OsLayout />);
  expect(mockNotificationAsync).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole('button', { name: 'Уведомления, 1' })).toHaveLength(1);
  mockRoute = 'files';
  await rerender(<OsLayout />);
  await act(async () => {
    usePhoneStore.getState().applyUpdate(3, {
      ...quiet,
      notifications: [incoming],
      activeCall: {
        callId: 'incoming',
        contactId: quiet.contacts[0]!.id,
        state: 'ringing',
        lines: [],
        choices: [],
      },
    });
  });
  expect(screen.getByText('Входящий звонок')).toBeTruthy();
  expect(mockNotificationAsync).toHaveBeenCalledTimes(2);
});
