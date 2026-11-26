import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';
import { BrowserApp, type BrowserActions } from '../src/os-apps/browser/App';
import { PRIVACY_LINES, SettingsScreen } from '../src/os-apps/settings/App';
import { savePairing, loadPairing } from '../src/pairing/storage';
import { unpairDevice } from '../src/pairing/unpair';
import { useDisplayStore } from '../src/stores/displayStore';
import { useSettingsStore } from '../src/stores/settingsStore';

jest.mock('expo-secure-store', () => {
  const data = new Map<string, string>();
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => void data.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => void data.delete(k)),
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn() }) }));

const view = PhoneView.parse(fixture);
const page = view.browserPages[0]!;
const browse = (): BrowserActions & { browse: jest.Mock } => ({ browse: jest.fn() });

beforeEach(() => {
  useDisplayStore.setState({ textSize: 'normal', reduceEffects: false });
  useSettingsStore.setState({ vibration: true, sound: true });
});

test('browser lists pages, opens one and sends the browse action', async () => {
  const a = browse();
  await render(<BrowserApp view={view} actions={a} />);
  await fireEvent.press(screen.getByRole('button', { name: page.title }));
  expect(a.browse).toHaveBeenCalledWith(page.id);
  expect(screen.getByText(page.text)).toBeTruthy();
  expect(screen.getByLabelText('Адрес страницы').props.children).toBe(page.url);
  await fireEvent.press(screen.getByRole('button', { name: 'К списку страниц' }));
  expect(screen.getByRole('button', { name: page.title })).toBeTruthy();
});

test('browser never opens a real URL, even for an http page', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const real: PhoneView = {
    ...view,
    browserPages: [{ ...page, url: 'https://example.com/evil', text: 'http://example.com' }],
  };
  await render(<BrowserApp view={real} actions={browse()} />);
  await fireEvent.press(screen.getByRole('button', { name: page.title }));
  await fireEvent.press(screen.getByText('https://example.com/evil'));
  await fireEvent.press(screen.getByText('http://example.com'));
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});

test('browser shows an empty state', async () => {
  await render(<BrowserApp view={{ ...view, browserPages: [] }} actions={browse()} />);
  expect(screen.getByText('Нет сохранённых страниц')).toBeTruthy();
});

test('toggles change vibration, sound and reduced effects', async () => {
  await render(<SettingsScreen onUnpair={jest.fn()} />);
  await fireEvent(screen.getByLabelText('Вибрация'), 'valueChange', false);
  await fireEvent(screen.getByLabelText('Звук'), 'valueChange', false);
  await fireEvent(screen.getByLabelText('Снизить эффекты'), 'valueChange', true);
  expect(useSettingsStore.getState()).toMatchObject({ vibration: false, sound: false });
  expect(useDisplayStore.getState().reduceEffects).toBe(true);
});

test('text size changes the stored size', async () => {
  await render(<SettingsScreen onUnpair={jest.fn()} />);
  await fireEvent.press(screen.getByText('Крупный'));
  expect(useDisplayStore.getState().textSize).toBe('large');
  expect(screen.getByRole('button', { name: 'Крупный' }).props.accessibilityState).toMatchObject({
    selected: true,
  });
});

test('privacy text says only the camera is used', async () => {
  await render(<SettingsScreen onUnpair={jest.fn()} />);
  for (const line of PRIVACY_LINES) expect(screen.getByText(line)).toBeTruthy();
  expect(screen.getByText(/только камеру/)).toBeTruthy();
});

test('unpairing needs a confirmation, then calls onUnpair once', async () => {
  const onUnpair = jest.fn();
  await render(<SettingsScreen onUnpair={onUnpair} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Отвязать устройство' }));
  expect(onUnpair).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Отмена'));
  expect(screen.getByRole('button', { name: 'Отвязать устройство' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Отвязать устройство' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Подтвердить отвязку' }));
  expect(onUnpair).toHaveBeenCalledTimes(1);
});

const saved = { host: 'h', port: 1, sessionId: 's', deviceToken: 'secret', wsPath: '/ws' };
const okFetch = () => jest.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));

test('unpairDevice tells the server with the device token, then deletes the stored token', async () => {
  await savePairing(saved);
  expect(await loadPairing()).toBeDefined();
  const fetchMock = okFetch();
  await unpairDevice(fetchMock);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
  expect(url).toBe('http://h:1/api/v1/sessions/s/device');
  expect(init.method).toBe('DELETE');
  expect(init.headers.authorization).toBe('Bearer secret');
  expect(await loadPairing()).toBeUndefined();
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
});

test('unpairDevice still unpairs locally when the server is unreachable', async () => {
  await savePairing(saved);
  const failing = jest.fn(async () => {
    throw new Error('network down');
  });
  await expect(unpairDevice(failing)).resolves.toBeUndefined();
  expect(failing).toHaveBeenCalledTimes(1);
  expect(await loadPairing()).toBeUndefined();
});
