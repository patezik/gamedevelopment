import * as SecureStore from 'expo-secure-store';
import { clearPairing, loadPairing, savePairing } from '../src/pairing/storage';

jest.mock('expo-secure-store', () => {
  const data = new Map<string, string>();
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => void data.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => void data.delete(k)),
  };
});

const device = { host: 'h', port: 7420, sessionId: 's', deviceToken: 't', wsPath: '/ws' };

test('saves, loads and clears the pairing through SecureStore', async () => {
  expect(await loadPairing()).toBeUndefined();
  await savePairing(device);
  expect(await loadPairing()).toEqual(device);
  await clearPairing();
  expect(await loadPairing()).toBeUndefined();
});

test('a corrupted record counts as not paired', async () => {
  await SecureStore.setItemAsync('hs.pairing', '{"host":1}');
  expect(await loadPairing()).toBeUndefined();
  await SecureStore.setItemAsync('hs.pairing', 'not json');
  expect(await loadPairing()).toBeUndefined();
});
