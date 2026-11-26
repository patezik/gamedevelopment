import * as SecureStore from 'expo-secure-store';
import { useDisplayStore } from '../src/stores/displayStore';
import { startSettingsPersistence } from '../src/stores/persistSettings';
import { useSettingsStore } from '../src/stores/settingsStore';

jest.mock('expo-secure-store', () => {
  const data = new Map<string, string>();
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => void data.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => void data.delete(k)),
  };
});

test('settings survive a restart', async () => {
  const stop = await startSettingsPersistence();
  useSettingsStore.getState().setVibration(false);
  useSettingsStore.getState().setSound(false);
  useDisplayStore.getState().setTextSize('large');
  stop();

  // restart: stores back to defaults, then hydrated from storage
  useSettingsStore.setState({ vibration: true, sound: true });
  useDisplayStore.setState({ textSize: 'normal', reduceEffects: false });
  const stop2 = await startSettingsPersistence();
  expect(useSettingsStore.getState().vibration).toBe(false);
  expect(useSettingsStore.getState().sound).toBe(false);
  expect(useDisplayStore.getState().textSize).toBe('large');
  stop2();
});

test('a corrupted record falls back to defaults', async () => {
  await SecureStore.setItemAsync('hs.settings', '{"vibration":"yes","textSize":"huge"');
  useSettingsStore.setState({ vibration: true, sound: true });
  const stop = await startSettingsPersistence();
  expect(useSettingsStore.getState().vibration).toBe(true);
  stop();
});
