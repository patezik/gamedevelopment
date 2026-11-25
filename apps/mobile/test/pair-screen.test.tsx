import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PairScreen from '../app/pair';
import { pairDevice } from '../src/pairing/pairClient';
import { savePairing } from '../src/pairing/storage';

const mockReplace = jest.fn();
let mockOnScan: ((e: { data: string }) => void) | undefined;

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: (props: { onBarcodeScanned?: (e: { data: string }) => void }) => {
    mockOnScan = props.onBarcodeScanned;
    return null;
  },
}));
jest.mock('../src/connection/gameConnection', () => ({
  startGameConnection: jest.fn(async () => undefined),
  stopGameConnection: jest.fn(),
}));
jest.mock('../src/pairing/storage', () => ({ savePairing: jest.fn(async () => undefined) }));
jest.mock('../src/pairing/pairClient', () => ({
  ...jest.requireActual('../src/pairing/pairClient'),
  pairDevice: jest.fn(),
}));

const device = { host: 'h', port: 7420, sessionId: 's', deviceToken: 't', wsPath: '/ws' };

beforeEach(() => {
  jest.clearAllMocks();
});

test('scanning a valid QR pairs, saves the token and opens the phone', async () => {
  (pairDevice as jest.Mock).mockResolvedValue({ ok: true, device });
  await render(<PairScreen />);
  mockOnScan?.({ data: 'hs1:pair:h:7420:ABC123' });
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/os'));
  expect((pairDevice as jest.Mock).mock.calls[0][0]).toEqual({
    host: 'h',
    port: 7420,
    code: 'ABC123',
  });
  expect(savePairing).toHaveBeenCalledWith(device);
});

test('an Expo Go QR is rejected without a network call', async () => {
  await render(<PairScreen />);
  mockOnScan?.({ data: 'exp://192.168.1.5:8081' });
  expect(await screen.findByText(/QR Expo Go/)).toBeTruthy();
  expect(pairDevice).not.toHaveBeenCalled();
  expect(savePairing).not.toHaveBeenCalled();
});

test('a server error is shown and nothing is saved', async () => {
  (pairDevice as jest.Mock).mockResolvedValue({ ok: false, code: 'PAIRING_CODE_EXPIRED' });
  await render(<PairScreen />);
  mockOnScan?.({ data: 'hs1:pair:h:7420:ABC123' });
  expect(await screen.findByText(/Код истёк/)).toBeTruthy();
  expect(savePairing).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

test('manual entry validates input and then pairs', async () => {
  (pairDevice as jest.Mock).mockResolvedValue({ ok: true, device });
  await render(<PairScreen />);
  await fireEvent.press(screen.getByText('Ввести вручную'));
  await fireEvent.changeText(screen.getByLabelText('Адрес игры'), 'bad');
  await fireEvent.changeText(screen.getByLabelText('Код привязки'), 'abc123');
  await fireEvent.press(screen.getByText('Привязать'));
  expect(await screen.findByText(/Проверьте адрес/)).toBeTruthy();
  expect(pairDevice).not.toHaveBeenCalled();

  await fireEvent.changeText(screen.getByLabelText('Адрес игры'), 'h:7420');
  await fireEvent.press(screen.getByText('Привязать'));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/os'));
  expect((pairDevice as jest.Mock).mock.calls[0][0].code).toBe('ABC123');
});
