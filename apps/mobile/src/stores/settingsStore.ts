import { create } from 'zustand';

/** Phone feedback settings. In memory; the Settings app (MOB-010) edits and persists them. */
export interface SettingsState {
  vibration: boolean;
  sound: boolean;
  setVibration: (on: boolean) => void;
  setSound: (on: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  vibration: true,
  sound: true,
  setVibration: (vibration) => set({ vibration }),
  setSound: (sound) => set({ sound }),
}));
