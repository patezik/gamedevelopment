import { stopGameConnection } from '../connection/gameConnection';
import { UNPAIR_TIMEOUT_MS, type FetchLike } from './pairClient';
import { clearPairing, loadPairing } from './storage';

/** Tells the server this phone is leaving (DELETE .../device with its own token). Never throws. */
async function notifyServer(fetchImpl: FetchLike): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UNPAIR_TIMEOUT_MS);
  try {
    const device = await loadPairing();
    if (!device) return;
    await fetchImpl(
      `http://${device.host}:${device.port}/api/v1/sessions/${encodeURIComponent(device.sessionId)}/device`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${device.deviceToken}` },
        body: '',
        signal: controller.signal,
      },
    );
  } catch {
    // best effort: the PC may be off or unreachable; the local unpair must still happen
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forgets this phone. First a best-effort notice to the server (so the desktop shows "not paired"),
 * then the local state goes: device token, socket and cached view.
 */
export async function unpairDevice(fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<void> {
  await notifyServer(fetchImpl);
  await clearPairing();
  stopGameConnection();
}
