import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MessagesApp, clock, type MessagesActions } from '../src/os-apps/messages/App';

const base = PhoneView.parse(fixture);
const director = base.threads[0]!;

function actions(reply = true): MessagesActions & { reply: jest.Mock; ui: jest.Mock } {
  return { reply: jest.fn(() => reply), ui: jest.fn() };
}

function withThread(extra: Partial<PhoneView['threads'][number]> & { id: string }): PhoneView {
  return {
    ...base,
    threads: [
      ...base.threads,
      { contactId: 'ct_x', messages: [], availableReplies: [], unread: 0, ...extra },
    ],
  };
}

test('thread list shows contact name, last message and unread badge; reports appOpened', async () => {
  const a = actions();
  await render(<MessagesApp view={base} actions={a} />);
  expect(screen.getByText('Директор санатория')).toBeTruthy();
  expect(screen.getByText('И принесите ту записку, если нашли.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Директор санатория, 2' })).toBeTruthy();
  expect(a.ui).toHaveBeenCalledWith('appOpened', 'messages');
});

test('threads are ordered by latest message, newest first', async () => {
  const view = withThread({
    id: 'th_new',
    contactId: 'ct_station',
    messages: [{ id: 'z', from: 'them', text: 'Свежее', at: 1430, read: false }],
    unread: 1,
  });
  await render(<MessagesApp view={view} actions={actions()} />);
  const names = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
  expect(names).toEqual(['Участковый, 1', 'Директор санатория, 2']);
});

test('an unknown sender looks like any other thread', async () => {
  const view = withThread({
    id: 'th_unknown',
    contactId: 'ct_nobody',
    messages: [{ id: 'u1', from: 'them', text: 'Не ходите в подвал.', at: 1000, read: false }],
    unread: 1,
  });
  await render(<MessagesApp view={view} actions={actions()} />);
  expect(screen.getByRole('button', { name: 'ct_nobody, 1' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'ct_nobody, 1' }));
  expect(screen.getByText('Не ходите в подвал.')).toBeTruthy();
});

test('opening a thread shows messages with times, marks message notifications as read', async () => {
  const a = actions();
  const view: PhoneView = {
    ...base,
    notifications: [
      ...base.notifications,
      { id: 'nt_file', appId: 'files', title: 'Файл', text: 'Новый файл', at: 1300, read: false },
    ],
  };
  await render(<MessagesApp view={view} actions={a} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Директор санатория, 2' }));
  expect(screen.getByText(director.messages[0]!.text)).toBeTruthy();
  expect(screen.getByText('23:15')).toBeTruthy();
  expect(a.ui).toHaveBeenCalledWith('notificationRead', 'nt1');
  expect(a.ui).not.toHaveBeenCalledWith('notificationRead', 'nt_file');
  await fireEvent.press(screen.getByRole('button', { name: 'К списку переписок' }));
  expect(screen.getByRole('button', { name: 'Директор санатория, 2' })).toBeTruthy();
});

test('opening one thread marks only its own notifications as read', async () => {
  const a = actions();
  const view: PhoneView = {
    ...withThread({
      id: 'th_new',
      contactId: 'ct_station',
      messages: [{ id: 'z', from: 'them', text: 'Свежее', at: 1430, read: false }],
      unread: 1,
    }),
    notifications: [
      ...base.notifications,
      {
        id: 'nt_station',
        appId: 'messages',
        title: 'Участковый',
        text: 'Свежее',
        at: 1430,
        read: false,
      },
    ],
  };
  await render(<MessagesApp view={view} actions={a} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Участковый, 1' }));
  expect(a.ui).toHaveBeenCalledWith('notificationRead', 'nt_station');
  expect(a.ui).not.toHaveBeenCalledWith('notificationRead', 'nt1');
});

test('a read thread does not report notificationRead', async () => {
  const view: PhoneView = {
    ...base,
    threads: [{ ...director, unread: 0 }],
  };
  const a = actions();
  await render(<MessagesApp view={view} actions={a} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Директор санатория' }));
  expect(a.ui).not.toHaveBeenCalledWith('notificationRead', expect.anything());
});

test('template replies are sent as message actions; offline shows a notice', async () => {
  const a = actions(false);
  await render(<MessagesApp view={base} actions={a} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Директор санатория, 2' }));
  await fireEvent.press(screen.getByText('Скоро буду.'));
  expect(a.reply).toHaveBeenCalledWith('ct_director', 'reply_coming');
  expect(screen.getByText('Нет связи, ответ не отправлен')).toBeTruthy();
});

test('typing indicator shows in the thread and in the list', async () => {
  const view: PhoneView = { ...base, threads: [{ ...director, typing: true }] };
  await render(<MessagesApp view={view} actions={actions()} />);
  expect(screen.getByText('печатает…')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Директор санатория, 2' }));
  expect(screen.getByText('печатает…')).toBeTruthy();
});

test('no threads shows an empty state; clock wraps the day', async () => {
  await render(<MessagesApp view={{ ...base, threads: [] }} actions={actions()} />);
  expect(screen.getByText('Нет переписок')).toBeTruthy();
  expect([0, 1395, 1440 + 65].map(clock)).toEqual(['00:00', '23:15', '01:05']);
});
