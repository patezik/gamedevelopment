import { MESSAGE_NOT_GAME_CODE, MESSAGE_OFFLINE, MESSAGE_PAIRING_CODE } from './errors';

/** The same code is processed at most once per window (qr-mechanics.md section 3). */
export const DEBOUNCE_MS = 2000;
export const EVIDENCE_PREFIX = 'hs1:ev:';
const PAIRING_PREFIX = 'hs1:pair:';

export interface LastScan {
  raw: string;
  at: number;
}

export interface ScanDeps {
  /** Milliseconds, monotonic enough for a 2 s window. */
  now: number;
  last: LastScan | null;
  online: boolean;
  /** Sends `qr.scan`; false means the message could not be sent. */
  send: (raw: string) => boolean;
}

export type ScanOutcome =
  { kind: 'ignored' } | { kind: 'rejected'; message: string } | { kind: 'sent' };

export interface ScanResult {
  outcome: ScanOutcome;
  /** Remember this for the next call (the debounce state). */
  last: LastScan | null;
}

/**
 * Decides what to do with a raw barcode value. Pure apart from `deps.send`: debounce state goes
 * in and out through `last`. Only `hs1:ev:` strings are ever sent; validation is the server's job.
 */
export function handleScan(raw: string, deps: ScanDeps): ScanResult {
  const { last } = deps;
  if (last && last.raw === raw && deps.now - last.at < DEBOUNCE_MS) {
    return { outcome: { kind: 'ignored' }, last };
  }
  const remembered: LastScan = { raw, at: deps.now };
  if (!raw.startsWith(EVIDENCE_PREFIX)) {
    const message = raw.startsWith(PAIRING_PREFIX) ? MESSAGE_PAIRING_CODE : MESSAGE_NOT_GAME_CODE;
    return { outcome: { kind: 'rejected', message }, last: remembered };
  }
  if (!deps.online || !deps.send(raw)) {
    return { outcome: { kind: 'rejected', message: MESSAGE_OFFLINE }, last: remembered };
  }
  return { outcome: { kind: 'sent' }, last: remembered };
}
