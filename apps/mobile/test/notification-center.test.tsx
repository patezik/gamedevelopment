import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { NotificationCenter } from '../src/os/NotificationCenter';
import { useSettingsStore } from '../src/stores/settingsStore';

const mockNotificationAsync = jest.fn(() => Promise.resolve());
const mockPlay = jest.fn();
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
  () => ({
    createAudioPlayer: () => ({ play: mockPlay, seekTo: () => Promise.resolve() }),
  }),
  { virtual: true },
);

const base = PhoneView.parse(fixture);
const quiet: PhoneView = { ...base, notifications: [], activeCall: undefined };
const incoming = {
  id: 'nt-new',
  appId: 'messages',
  title: 'Новое сообщение',
  text: 'Вы где?',
  at: 1400,
  read: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ vibration: true, sound: true });
});

test('a new notification shows a toast, vibrates and plays a sound', async () => {
  const { rerender } = await render(<NotificationCenter view={quiet} />);
  expect(screen.queryByText('Новое сообщение')).toBeNull();
  await rerender(<NotificationCenter view={{ ...quiet, notifications: [incoming] }} />);
  expect(screen.getByText('Новое сообщение')).toBeTruthy();
  expect(mockNotificationAsync).toHaveBeenCalledTimes(1);
  expect(mockPlay).toHaveBeenCalledTimes(1);
});

test('notifications present on first render are history: no toast, no vibration', async () => {
  await render(<NotificationCenter view={base} />);
  expect(screen.queryByText(base.notifications[0]!.title)).toBeNull();
  expect(mockNotificationAsync).not.toHaveBeenCalled();
});

test('the vibration setting disables vibration but not the toast', async () => {
  useSettingsStore.setState({ vibration: false });
  const { rerender } = await render(<NotificationCenter view={quiet} />);
  await rerender(<NotificationCenter view={{ ...quiet, notifications: [incoming] }} />);
  expect(screen.getByText('Новое сообщение')).toBeTruthy();
  expect(mockNotificationAsync).not.toHaveBeenCalled();
  expect(mockPlay).toHaveBeenCalledTimes(1);
});

test('the sound setting disables the sound', async () => {
  useSettingsStore.setState({ sound: false });
  const { rerender } = await render(<NotificationCenter view={quiet} />);
  await rerender(<NotificationCenter view={{ ...quiet, notifications: [incoming] }} />);
  expect(mockPlay).not.toHaveBeenCalled();
  expect(mockNotificationAsync).toHaveBeenCalledTimes(1);
});

test('the toast disappears after its timeout', async () => {
  jest.useFakeTimers();
  try {
    const { rerender } = await render(<NotificationCenter view={quiet} toastMs={1000} />);
    await rerender(
      <NotificationCenter view={{ ...quiet, notifications: [incoming] }} toastMs={1000} />,
    );
    expect(screen.getByText('Новое сообщение')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(1100);
    });
    expect(screen.queryByText('Новое сообщение')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test('the bell shows the unread count and the list opens the app of a notification', async () => {
  const onOpenApp = jest.fn();
  await render(<NotificationCenter view={base} onOpenApp={onOpenApp} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Уведомления, 1' }));
  await fireEvent.press(screen.getByText(base.notifications[0]!.title));
  expect(onOpenApp).toHaveBeenCalledWith('messages');
});

test('an empty centre says so and the badge disappears', async () => {
  await render(<NotificationCenter view={quiet} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Уведомления' }));
  expect(screen.getByText('Нет уведомлений')).toBeTruthy();
});

test('a ringing call shows the overlay once with vibration; answer and decline report the call', async () => {
  const onAnswerCall = jest.fn();
  const onDeclineCall = jest.fn();
  const contact = quiet.contacts[0]!;
  const ringing: PhoneView = {
    ...quiet,
    activeCall: { callId: 'c1', contactId: contact.id, state: 'ringing', lines: [], choices: [] },
  };
  const { rerender } = await render(
    <NotificationCenter view={quiet} onAnswerCall={onAnswerCall} onDeclineCall={onDeclineCall} />,
  );
  expect(screen.queryByText('Входящий звонок')).toBeNull();
  await rerender(
    <NotificationCenter view={ringing} onAnswerCall={onAnswerCall} onDeclineCall={onDeclineCall} />,
  );
  expect(screen.getByText('Входящий звонок')).toBeTruthy();
  expect(screen.getByText(contact.name)).toBeTruthy();
  expect(mockNotificationAsync).toHaveBeenCalledWith('warning');
  await rerender(
    <NotificationCenter
      view={{ ...ringing }}
      onAnswerCall={onAnswerCall}
      onDeclineCall={onDeclineCall}
    />,
  );
  expect(mockNotificationAsync).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Ответить' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Отклонить' }));
  expect(onAnswerCall).toHaveBeenCalledWith('c1');
  expect(onDeclineCall).toHaveBeenCalledWith('c1');
});
