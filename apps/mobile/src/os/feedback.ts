import { createAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useSettingsStore } from '../stores/settingsStore';

type Player = ReturnType<typeof createAudioPlayer>;
let player: Player | null = null;

/** Short vibration; does nothing when vibration is off in the settings. */
export function vibrate(kind: 'notification' | 'call'): void {
  if (!useSettingsStore.getState().vibration) {
    return;
  }
  const type =
    kind === 'call'
      ? Haptics.NotificationFeedbackType.Warning
      : Haptics.NotificationFeedbackType.Success;
  Haptics.notificationAsync(type).catch(() => undefined);
}

/** Short OS sound; does nothing when sound is off in the settings. */
export function playSound(): void {
  if (!useSettingsStore.getState().sound) {
    return;
  }
  try {
    player ??= createAudioPlayer(require('../../assets/sounds/notify.wav'));
    void player.seekTo(0);
    player.play();
  } catch {
    // Sound is decoration: a missing audio device must not break the OS.
  }
}
