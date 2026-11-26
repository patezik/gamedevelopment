import type { ErrorCode } from '@hs/protocol';
import { create } from 'zustand';

export interface QrResultState {
  ok: boolean;
  error?: ErrorCode | undefined;
  clueRef?: string | undefined;
}

export interface QrState {
  /** The last `qr.result`; `null` while a scan awaits its answer or before any scan. */
  result: QrResultState | null;
  /** A `qr.scan` was sent and no `qr.result` has arrived yet. */
  pending: boolean;
  markSent: () => void;
  setResult: (result: QrResultState) => void;
  reset: () => void;
}

export const useQrStore = create<QrState>((set) => ({
  result: null,
  pending: false,
  markSent: () => set({ pending: true, result: null }),
  setResult: (result) => set({ pending: false, result }),
  reset: () => set({ pending: false, result: null }),
}));
