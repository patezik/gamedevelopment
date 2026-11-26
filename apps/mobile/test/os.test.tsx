import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppFrame } from '../src/os/AppFrame';
import { HomeGrid } from '../src/os/HomeGrid';
import { StatusBar, signalBars } from '../src/os/StatusBar';
import { OS_APPS, findApp } from '../src/os-apps/registry';

const view = PhoneView.parse(fixture);

test('HomeGrid shows every app with server badges', async () => {
  await render(<HomeGrid apps={OS_APPS} view={view} onOpen={() => {}} />);
  for (const app of OS_APPS) expect(screen.getByText(app.title)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Сообщения, 2' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Камера' })).toBeTruthy();
});

test('HomeGrid opens an app on press', async () => {
  const onOpen = jest.fn();
  await render(<HomeGrid apps={OS_APPS} view={view} onOpen={onOpen} />);
  await fireEvent.press(screen.getByText('Заметки'));
  expect(onOpen).toHaveBeenCalledWith('notes');
});

test('HomeGrid does not open a disabled app', async () => {
  const onOpen = jest.fn();
  const off: PhoneView = {
    ...view,
    apps: view.apps.map((a) => (a.id === 'browser' ? { ...a, enabled: false } : a)),
  };
  await render(<HomeGrid apps={OS_APPS} view={off} onOpen={onOpen} />);
  await fireEvent.press(screen.getByText('Браузер'));
  expect(onOpen).not.toHaveBeenCalled();
});

test('StatusBar shows game time and battery; signal maps to bars', async () => {
  await render(<StatusBar status={{ time: '08:20', battery: 71, signal: 82 }} />);
  expect(screen.getByText('08:20')).toBeTruthy();
  expect(screen.getByText('71%')).toBeTruthy();
  expect([0, 1, 25, 26, 100].map(signalBars)).toEqual([0, 1, 1, 2, 4]);
});

test('AppFrame home button calls onHome and shows the app', async () => {
  const onHome = jest.fn();
  const App = findApp('files')!.component;
  await render(
    <AppFrame status={view.status} title="Файлы" onHome={onHome}>
      <App view={view} />
    </AppFrame>,
  );
  expect(screen.getByText('В разработке')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Домой' }));
  expect(onHome).toHaveBeenCalledTimes(1);
});
