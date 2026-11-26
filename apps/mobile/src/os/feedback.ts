import { createAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import callEndSound from '../../assets/audio/call_end.wav';
import errorSound from '../../assets/audio/error.wav';
import messageSound from '../../assets/audio/message.wav';
import notifySound from '../../assets/audio/notify.wav';
import ringSound from '../../assets/audio/ring.wav';
import scanOkSound from '../../assets/audio/scan_ok.wav';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Sounds of the phone OS (CNT-011, synthesised by tools/audio/synth.py, see
 * docs/game-design/audio-library.md). A new sound is a file here and a name in this table.
 */
export const SOUNDS = {
  notify: notifySound,
  message: messageSound,
  ring: ringSound,
  callEnd: callEndSound,
  scanOk: scanOkSound,
  error: errorSound,
};

export type SoundName = keyof typeof SOUNDS;

type Player = ReturnType<typeof createAudioPlayer>;
const players = new Map<SoundName, Player>();

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

/** OS sound (a notification by default); does nothing when sound is off in the settings. */
export function playSound(name: SoundName = 'notify'): void {
  if (!useSettingsStore.getState().sound) {
    return;
  }
  try {
    let player = players.get(name);
    if (!player) {
      player = createAudioPlayer(SOUNDS[name]);
      players.set(name, player);
    }
    void player.seekTo(0);
    player.play();
  } catch {
    // Sound is decoration: a missing audio device must not break the OS.
  }
}
