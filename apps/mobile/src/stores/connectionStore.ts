import type { ErrorCode } from '@hs/protocol';
import { create } from 'zustand';

export type ConnectionStatus = 'unpaired' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface ConnectionError {
  code: ErrorCode | 'INVALID_MESSAGE';
  message: string;
}

export interface ConnectionState {
  status: ConnectionStatus;
  /** Last processed session event number (sent as `ack` and in `resume`). */
  lastSeq: number;
  stateVersion: number;
  lastError: ConnectionError | null;
  setStatus: (status: ConnectionStatus) => void;
  noteSeq: (seq: number) => void;
  setPosition: (lastSeq: number, stateVersion: number) => void;
  setError: (error: ConnectionError | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'unpaired',
  lastSeq: 0,
  stateVersion: 0,
  lastError: null,
  setStatus: (status) => set({ status }),
  // Numbering has gaps (the buffer is per role), so only the maximum matters.
  noteSeq: (seq) => set((s) => (seq > s.lastSeq ? { lastSeq: seq } : s)),
  setPosition: (lastSeq, stateVersion) => set({ lastSeq, stateVersion }),
  setError: (lastError) => set({ lastError }),
}));

/** The "no connection to the game" banner is shown while a paired phone cannot reach the server. */
export function isOfflineBanner(status: ConnectionStatus): boolean {
  return status === 'reconnecting' || status === 'offline';
}
