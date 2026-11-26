import { stopGameConnection } from '../connection/gameConnection';
import { clearPairing } from './storage';

/** Forgets this phone: deletes the device token, drops the socket and the cached view. */
export async function unpairDevice(): Promise<void> {
  await clearPairing();
  stopGameConnection();
}
