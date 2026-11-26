import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.glitch.json';
import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { cancelAnimation, withRepeat, withTiming } from 'react-native-reanimated';
import OsLayout from '../app/os/_layout';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useDisplayStore } from '../src/stores/displayStore';
import { usePhoneStore } from '../src/stores/phoneStore';
import { useQrStore } from '../src/stores/qrStore';

let mockAppId: string | undefined;
let mockOnScan: ((event: { data: string }) => void) | undefined;
const mockSendScan = jest.fn<boolean, [string]>(() => true);

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ appId: mockAppId }),
  usePathname: () => (mockAppId ? `/os/${mockAppId}` : '/os'),
  Slot: () => {
    const Screen = mockAppId
      ? jest.requireActual<typeof import('../app/os/[appId]')>('../app/os/[appId]').default
      : jest.requireActual<typeof import('../app/os/index')>('../app/os/index').default;
    return <Screen />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/os/feedback', () => ({ vibrate: jest.fn(), playSound: jest.fn() }));
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
  CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: typeof mockOnScan }) => {
    mockOnScan = onBarcodeScanned;
    return null;
  },
}));
jest.mock('../src/connection/gameConnection', () => ({
  sendQrScan: (raw: string) => mockSendScan(raw),
}));

const base = PhoneView.parse(fixture);
const initialView: PhoneView = { ...base, notifications: [], activeCall: undefined };
const hidden = { includeHiddenElements: true };
let motionChanged: (enabled: boolean) => void;

beforeEach(() => {
  mockAppId = undefined;
  mockOnScan = undefined;
  jest.clearAllMocks();
  usePhoneStore.getState().clear();
  useDisplayStore.getState().setReduceEffects(false);
  useQrStore.getState().reset();
  useConnectionStore.setState({ status: 'online' });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'reduceMotionChanged') motionChanged = listener as typeof motionChanged;
    return { remove: jest.fn() };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('a live glitch update changes noise intensity and zero removes it', async () => {
  usePhoneStore.getState().applyUpdate(1, { ...initialView, effects: { glitchLevel: 0 } });
  await render(<OsLayout />);
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();

  await act(() =>
    usePhoneStore.getState().applyUpdate(2, { ...initialView, effects: { glitchLevel: 25 } }),
  );
  const lowOpacity = screen.getByTestId('os-static', hidden).props.style.opacity;
  expect(lowOpacity).toBeGreaterThan(0);
  expect(screen.getByTestId('os-static', hidden).props.pointerEvents).toBe('none');

  await act(() => usePhoneStore.getState().applyUpdate(3, initialView));
  expect(screen.getByTestId('os-static', hidden).props.style.opacity).toBeGreaterThan(lowOpacity);
  expect(withTiming).toHaveBeenCalledWith(3.2, { duration: 75 });

  await act(() =>
    usePhoneStore.getState().applyUpdate(4, { ...initialView, effects: { glitchLevel: 0 } }),
  );
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();
  expect(cancelAnimation).toHaveBeenCalled();
});

test('wallpaper comes from the view and can change even at glitch level zero', async () => {
  usePhoneStore.getState().applyUpdate(1, {
    ...initialView,
    effects: { glitchLevel: 0, wallpaperVariant: 'pine_forest' },
  });
  await render(<OsLayout />);
  const daylight = screen.getByTestId('os-wallpaper', hidden).props.source;

  await act(() =>
    usePhoneStore.getState().applyUpdate(2, {
      ...initialView,
      effects: { glitchLevel: 0, wallpaperVariant: 'pine_forest_dark' },
    }),
  );
  expect(screen.getByTestId('os-wallpaper', hidden).props.source).not.toEqual(daylight);
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();

  await act(() =>
    usePhoneStore.getState().applyUpdate(3, {
      ...initialView,
      effects: { glitchLevel: 0, wallpaperVariant: 'unavailable' },
    }),
  );
  expect(screen.queryByTestId('os-wallpaper', hidden)).toBeNull();
});

test('reducing effects clears distortion immediately and keeps the original photo title', async () => {
  mockAppId = 'gallery';
  usePhoneStore.getState().applyUpdate(1, initialView);
  await render(<OsLayout />);
  expect(screen.getByTestId('os-static', hidden)).toBeTruthy();
  expect(screen.getAllByTestId('photo-preview-distortion', hidden)).toHaveLength(
    base.gallery.length,
  );
  expect(screen.getByText(base.gallery[0]!.title)).toBeTruthy();

  await act(() => useDisplayStore.getState().setReduceEffects(true));
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();
  expect(screen.queryByTestId('photo-preview-distortion', hidden)).toBeNull();
  expect(screen.getByText(base.gallery[0]!.title)).toBeTruthy();
});

test('honours system Reduce Motion on mount and follows changes while the OS is open', async () => {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true);
  usePhoneStore.getState().applyUpdate(1, initialView);
  await render(<OsLayout />);
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();
  await act(() => motionChanged(false));
  expect(screen.getByTestId('os-static', hidden)).toBeTruthy();
  expect(withRepeat).toHaveBeenCalledWith(expect.any(Number), -1, false, undefined, 'never');
  await act(() => motionChanged(true));
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();
});

test('a late system preference read cannot override a newer Reduce Motion event', async () => {
  let completeRead!: (enabled: boolean) => void;
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockReturnValueOnce(
    new Promise((resolve) => {
      completeRead = resolve;
    }),
  );
  usePhoneStore.getState().applyUpdate(1, initialView);
  await render(<OsLayout />);
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();
  await act(() => motionChanged(true));
  await act(() => completeRead(false));
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();
});

test('briefly changes a chrome label at high intensity and retains its accessibility label', async () => {
  jest.useFakeTimers();
  mockAppId = 'gallery';
  usePhoneStore.getState().applyUpdate(1, { ...initialView, effects: { glitchLevel: 49 } });
  await render(<OsLayout />);
  expect(screen.getByText('Галерея')).toBeTruthy();
  await act(() => jest.advanceTimersByTime(5000));
  expect(screen.queryByText('ШУМ')).toBeNull();

  await act(() =>
    usePhoneStore.getState().applyUpdate(2, { ...initialView, effects: { glitchLevel: 50 } }),
  );
  await act(() => jest.advanceTimersByTime(5000));
  expect(screen.getByText('ШУМ')).toBeTruthy();
  expect(screen.getByLabelText('Галерея')).toBeTruthy();

  await act(() => jest.advanceTimersByTime(250));
  expect(screen.queryByText('ШУМ')).toBeNull();
  expect(screen.getByText('Галерея')).toBeTruthy();

  await act(() => jest.advanceTimersByTime(4750));
  expect(screen.getByText('ШУМ')).toBeTruthy();
  await act(() => useDisplayStore.getState().setReduceEffects(true));
  expect(screen.getByText('Галерея')).toBeTruthy();
  await act(() => jest.advanceTimersByTime(5000));
  expect(screen.queryByText('ШУМ')).toBeNull();
});

test('switching from an affected screen to camera keeps scanning at full intensity', async () => {
  usePhoneStore.getState().applyUpdate(1, { ...initialView, effects: { glitchLevel: 100 } });
  const { rerender } = await render(<OsLayout />);
  expect(screen.getByTestId('os-static', hidden)).toBeTruthy();
  expect(withRepeat).toHaveBeenCalledTimes(1);
  expect(StyleSheet.flatten(screen.getByTestId('os-effect-surface').props.style).transform).toEqual(
    [{ translateX: 0 }],
  );

  mockAppId = 'camera';
  await rerender(<OsLayout />);
  expect(screen.queryByTestId('os-static', hidden)).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId('os-effect-surface').props.style)).toHaveProperty(
    'transform',
    undefined,
  );
  expect(cancelAnimation).toHaveBeenCalledTimes(1);
  expect(mockOnScan).toBeDefined();
  const raw = 'hs1:ev:01234567:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA';
  await act(() => mockOnScan?.({ data: raw }));
  expect(mockSendScan).toHaveBeenCalledWith(raw);
});
