import * as SecureStore from 'expo-secure-store';
import { useDisplayStore, type TextSize } from './displayStore';
import { useSettingsStore } from './settingsStore';

const KEY = 'hs.settings';

/** Non-secret phone preferences kept across restarts (same store as the pairing record). */
export interface StoredSettings {
  vibration: boolean;
  sound: boolean;
  textSize: TextSize;
  reduceEffects: boolean;
}

const SIZES: readonly TextSize[] = ['small', 'normal', 'large'];

export async function loadSettings(): Promise<Partial<StoredSettings>> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) {
    return {};
  }
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof StoredSettings, unknown>>;
    const out: Partial<StoredSettings> = {};
    if (typeof v.vibration === 'boolean') out.vibration = v.vibration;
    if (typeof v.sound === 'boolean') out.sound = v.sound;
    if (typeof v.reduceEffects === 'boolean') out.reduceEffects = v.reduceEffects;
    if (SIZES.includes(v.textSize as TextSize)) out.textSize = v.textSize as TextSize;
    return out;
  } catch {
    return {}; // a corrupted record means defaults
  }
}

function snapshot(): StoredSettings {
  const s = useSettingsStore.getState();
  const d = useDisplayStore.getState();
  return {
    vibration: s.vibration,
    sound: s.sound,
    textSize: d.textSize,
    reduceEffects: d.reduceEffects,
  };
}

/** Restores saved settings into the stores, then saves every later change. Returns an unsubscribe. */
export async function startSettingsPersistence(): Promise<() => void> {
  const { vibration, sound, textSize, reduceEffects } = await loadSettings();
  useSettingsStore.setState({
    ...(vibration === undefined ? {} : { vibration }),
    ...(sound === undefined ? {} : { sound }),
  });
  useDisplayStore.setState({
    ...(textSize === undefined ? {} : { textSize }),
    ...(reduceEffects === undefined ? {} : { reduceEffects }),
  });
  const save = () => void SecureStore.setItemAsync(KEY, JSON.stringify(snapshot()));
  const offA = useSettingsStore.subscribe(save);
  const offB = useDisplayStore.subscribe(save);
  return () => {
    offA();
    offB();
  };
}
