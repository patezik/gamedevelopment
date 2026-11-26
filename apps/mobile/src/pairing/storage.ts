import * as SecureStore from 'expo-secure-store';
import type { PairedDevice } from './pairClient';

const KEY = 'hs.pairing';

export async function savePairing(device: PairedDevice): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(device));
}

export async function loadPairing(): Promise<PairedDevice | undefined> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as Partial<PairedDevice>;
    if (
      typeof v.host === 'string' &&
      typeof v.port === 'number' &&
      typeof v.sessionId === 'string' &&
      typeof v.deviceToken === 'string' &&
      typeof v.wsPath === 'string'
    ) {
      return {
        host: v.host,
        port: v.port,
        sessionId: v.sessionId,
        deviceToken: v.deviceToken,
        wsPath: v.wsPath,
      };
    }
  } catch {
    // a corrupted record counts as "not paired"
  }
  return undefined;
}

export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
