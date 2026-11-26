import { PROTOCOL_VERSION } from '@hs/protocol';
import { render, screen } from '@testing-library/react-native';
import HomeScreen from '../app/index';

test('shows the companion name and shared protocol version', async () => {
  await render(<HomeScreen />);

  expect(screen.getByRole('header', { name: 'Hollow Signal' })).toBeTruthy();
  expect(screen.getByText(`Версия протокола ${PROTOCOL_VERSION}`)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Открыть телефон' })).toBeTruthy();
});
