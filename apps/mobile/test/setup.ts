// Native audio and haptics are absent under Jest. Suites that look at the calls mock the modules
// themselves (a mock in the suite replaces this one).
jest.mock('expo-audio', () => ({
  createAudioPlayer: () => ({ play: () => undefined, seekTo: () => Promise.resolve() }),
}));
jest.mock('expo-haptics', () => ({
  notificationAsync: () => Promise.resolve(),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
