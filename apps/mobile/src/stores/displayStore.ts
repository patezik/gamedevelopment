import { create } from 'zustand';

export type TextSize = 'small' | 'normal' | 'large';

export const TEXT_SCALE: Record<TextSize, number> = { small: 0.9, normal: 1, large: 1.25 };

/** Display preferences edited in the Settings app. Persisted by `persistSettings.ts`. */
export interface DisplayState {
  textSize: TextSize;
  /** Limits glitch effects driven by `PhoneView.effects.glitchLevel`. */
  reduceEffects: boolean;
  setTextSize: (size: TextSize) => void;
  setReduceEffects: (on: boolean) => void;
}

export const useDisplayStore = create<DisplayState>((set) => ({
  textSize: 'normal',
  reduceEffects: false,
  setTextSize: (textSize) => set({ textSize }),
  setReduceEffects: (reduceEffects) => set({ reduceEffects }),
}));

/** Scale for font sizes of in-game content. */
export function useTextScale(): number {
  return TEXT_SCALE[useDisplayStore((s) => s.textSize)];
}
