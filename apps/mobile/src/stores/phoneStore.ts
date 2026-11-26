import { PhoneView } from '@hs/protocol';
import { create } from 'zustand';

export interface PhoneState {
  view: PhoneView | null;
  /** `null` until a snapshot is accepted (or after `resetVersion`). */
  stateVersion: number | null;
  /** Applies a `view.update`. Returns false (state untouched) for a stale or non-phone view. */
  applyUpdate: (stateVersion: number, view: unknown) => boolean;
  /** Keeps the shown view but accepts any next snapshot (resync, server restart). */
  resetVersion: () => void;
  clear: () => void;
}

export const usePhoneStore = create<PhoneState>((set, get) => ({
  view: null,
  stateVersion: null,
  applyUpdate: (stateVersion, view) => {
    const current = get().stateVersion;
    if (current !== null && stateVersion <= current) {
      return false;
    }
    const parsed = PhoneView.safeParse(view);
    if (!parsed.success) {
      return false;
    }
    set({ view: parsed.data, stateVersion });
    return true;
  },
  resetVersion: () => set({ stateVersion: null }),
  clear: () => set({ view: null, stateVersion: null }),
}));
