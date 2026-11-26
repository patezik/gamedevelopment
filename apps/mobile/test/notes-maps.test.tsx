import { PROTOCOL_VERSION, PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { WsClient, type SocketLike } from '../src/connection/WsClient';
import { formatCaseTime } from '../src/os/caseTime';
import { MapsApp, groupPins } from '../src/os-apps/maps/App';
import { NOTE_OFFLINE, NotesApp } from '../src/os-apps/notes/App';
import { useConnectionStore } from '../src/stores/connectionStore';
import { usePhoneStore } from '../src/stores/phoneStore';

const mockSendAction = jest.fn();
jest.mock('../src/connection/gameConnection', () => ({
  sendPhoneAction: (action: unknown) => mockSendAction(action),
}));

const view = PhoneView.parse(fixture);

beforeEach(() => {
  mockSendAction.mockReset();
  mockSendAction.mockReturnValue(true);
  useConnectionStore.setState({ status: 'online' });
});

test('formatCaseTime shows the case clock', () => {
  expect(formatCaseTime(0)).toBe('0:00');
  expect(formatCaseTime(1380)).toBe('23:00');
  expect(formatCaseTime(95)).toBe('1:35');
  expect(formatCaseTime(-30)).toBe('до начала, 0:30');
});

describe('NotesApp', () => {
  test('lists the auto journal and player notes, newest first', async () => {
    await render(<NotesApp view={view} />);
    expect(await screen.findByText('Найдена порванная записка в Зимнем саду.')).toBeTruthy();
    expect(screen.getByText('Журнал · 1:35')).toBeTruthy();
    expect(screen.getByText('Заметка · 10:50')).toBeTruthy();
    const texts = screen.getAllByText(/записка|ключ/).map((n) => n.props.children);
    expect(texts[0]).toBe('Проверить, кто брал ключ.');
  });

  test('shows an empty state', async () => {
    await render(<NotesApp view={{ ...view, notes: [] }} />);
    expect(await screen.findByText('Записей пока нет.')).toBeTruthy();
  });

  test('adds a trimmed note through the addNote action and clears the field', async () => {
    await render(<NotesApp view={view} />);
    const input = await screen.findByLabelText('Новая заметка');
    await fireEvent.changeText(input, '  Спросить повара  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Добавить' }));
    expect(mockSendAction).toHaveBeenCalledWith({ type: 'addNote', text: 'Спросить повара' });
    expect(screen.getByLabelText('Новая заметка').props.value).toBe('');
  });

  test('a blank note is never sent', async () => {
    await render(<NotesApp view={view} />);
    await fireEvent.changeText(await screen.findByLabelText('Новая заметка'), '   ');
    await fireEvent.press(screen.getByRole('button', { name: 'Добавить' }));
    expect(mockSendAction).not.toHaveBeenCalled();
  });

  test('offline keeps the text and explains', async () => {
    useConnectionStore.setState({ status: 'offline' });
    await render(<NotesApp view={view} />);
    await fireEvent.changeText(await screen.findByLabelText('Новая заметка'), 'Важно');
    await fireEvent.press(screen.getByRole('button', { name: 'Добавить' }));
    expect(mockSendAction).not.toHaveBeenCalled();
    expect(await screen.findByText(NOTE_OFFLINE)).toBeTruthy();
    expect(screen.getByLabelText('Новая заметка').props.value).toBe('Важно');
  });
});

describe('MapsApp', () => {
  test('shows pins with observation time only where the view has one', async () => {
    await render(<MapsApp view={view} />);
    expect(await screen.findByText('Доктор Белов · замечен(а) 23:00')).toBeTruthy();
    expect(screen.getByText('Где найдена записка')).toBeTruthy();
    expect(screen.getByText('Место 1')).toBeTruthy();
    expect(screen.getByText('Место 2')).toBeTruthy();
  });

  test('does not print raw location ids', async () => {
    await render(<MapsApp view={view} />);
    await screen.findByText('Место 1');
    expect(screen.queryByText(/loc_/)).toBeNull();
  });

  test('empty state', async () => {
    await render(<MapsApp view={{ ...view, mapPins: [] }} />);
    expect(await screen.findByText('Известных мест пока нет.')).toBeTruthy();
  });

  test('groupPins merges pins of one location, keeping order', () => {
    const pin = (id: string, locationId: string) => ({ id, locationId, label: id });
    const groups = groupPins([pin('a', 'x'), pin('b', 'y'), pin('c', 'x')]);
    expect(groups.map((g) => g.map((p) => p.id))).toEqual([['a', 'c'], ['b']]);
  });
});

class MockSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ type: string; payload: unknown }> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}

test('WsClient.sendAction sends action.request only after welcome', () => {
  jest.useFakeTimers();
  const socket = new MockSocket();
  const client = new WsClient({
    device: { host: 'h', port: 1, sessionId: 's', deviceToken: 't', wsPath: '/ws' },
    appVersion: '1',
    onRevoked: () => {},
    createSocket: () => socket,
  });
  client.start();
  socket.onopen?.();
  expect(client.sendAction({ type: 'addNote', text: 'x' })).toBe(false);
  const welcome = {
    sessionId: 's',
    role: 'phone',
    protocolVersion: 1,
    serverVersion: '0',
    stateVersion: 1,
    lastSeq: 0,
  };
  socket.onmessage?.({
    data: JSON.stringify({ v: PROTOCOL_VERSION, type: 'welcome', id: 's', payload: welcome }),
  });
  expect(client.sendAction({ type: 'addNote', text: 'x' })).toBe(true);
  expect(socket.sent.at(-1)).toMatchObject({
    type: 'action.request',
    payload: { action: { type: 'addNote', text: 'x' } },
  });
  client.stop();
  jest.useRealTimers();
});

describe('live updates from the server view', () => {
  // The OS routes pass the PhoneView held by phoneStore to the app (see MOB-005).
  function Live({ app: App }: { app: typeof NotesApp | typeof MapsApp }) {
    const live = usePhoneStore((s) => s.view);
    return live ? <App view={live} /> : null;
  }

  beforeEach(() => {
    usePhoneStore.getState().clear();
  });

  test('Notes shows a new journal entry after view.update', async () => {
    usePhoneStore.getState().applyUpdate(1, view);
    await render(<Live app={NotesApp} />);
    expect(screen.queryByText('Дверь подвала открыта.')).toBeNull();
    await act(async () => {
      usePhoneStore.getState().applyUpdate(2, {
        ...view,
        notes: [
          ...view.notes,
          { id: 'n_new', source: 'auto', text: 'Дверь подвала открыта.', at: 1500 },
        ],
      });
    });
    expect(screen.getByText('Дверь подвала открыта.')).toBeTruthy();
  });

  test('Maps shows a new pin after view.update', async () => {
    usePhoneStore.getState().applyUpdate(1, { ...view, mapPins: [] });
    await render(<Live app={MapsApp} />);
    expect(screen.getByText('Известных мест пока нет.')).toBeTruthy();
    await act(async () => {
      usePhoneStore.getState().applyUpdate(2, view);
    });
    expect(screen.getByText('Где найдена записка')).toBeTruthy();
  });
});
