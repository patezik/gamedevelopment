import type { PlayerAction } from '@hs/protocol';
import { AppState } from 'react-native';
import { clearPairing, loadPairing } from '../pairing/storage';
import { useConnectionStore } from '../stores/connectionStore';
import { usePhoneStore } from '../stores/phoneStore';
import { useQrStore } from '../stores/qrStore';
import { WsClient } from './WsClient';

let client: WsClient | null = null;
let appStateSub: { remove: () => void } | null = null;

/**
 * Starts (or keeps) the connection of a paired phone. Without a pairing the status stays
 * `unpaired`. Call again after pairing succeeds.
 */
export async function startGameConnection(opts: {
  appVersion: string;
  onRevoked: () => void;
}): Promise<void> {
  if (client) {
    return;
  }
  const device = await loadPairing();
  if (!device) {
    useConnectionStore.getState().setStatus('unpaired');
    return;
  }
  if (client) {
    return;
  }
  const created = new WsClient({
    device,
    appVersion: opts.appVersion,
    onRevoked: () => {
      void clearPairing().finally(() => {
        stopGameConnection();
        opts.onRevoked();
      });
    },
  });
  client = created;
  appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      created.resume();
    } else {
      created.pause();
    }
  });
  created.start();
}

/** Sends a scanned evidence QR to the server; false when there is no live connection. */
export function sendQrScan(raw: string): boolean {
  return client?.sendQrScan(raw) ?? false;
}

/** Unpair or unmount: drops the socket, the subscription and the cached view. */
export function stopGameConnection(): void {
  client?.stop();
  client = null;
  appStateSub?.remove();
  appStateSub = null;
  usePhoneStore.getState().clear();
  useQrStore.getState().reset();
  useConnectionStore.getState().setStatus('unpaired');
}

/** Sends a phone action (`message`, `answerCall`, ...); false when there is no live connection. */
export function sendPhoneAction(action: PlayerAction): boolean {
  return client?.sendAction(action) ?? false;
}

/** Sends `phone.ui`; false when there is no live connection. */
export function sendPhoneUi(kind: 'appOpened' | 'notificationRead', ref: string): boolean {
  return client?.sendPhoneUi(kind, ref) ?? false;
}
