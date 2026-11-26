import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { CallsApp, type CallsActions } from '../src/os-apps/calls/App';
import { ContactsApp, type ContactsActions } from '../src/os-apps/contacts/App';

const base = PhoneView.parse(fixture);
const active = base.activeCall!;
const idle: PhoneView = { ...base, activeCall: undefined };

function callsActions(ok = true): CallsActions & Record<keyof CallsActions, jest.Mock> {
  return {
    call: jest.fn(() => ok),
    answer: jest.fn(() => ok),
    choose: jest.fn(() => ok),
    ui: jest.fn(),
  };
}
function contactsActions(ok = true): ContactsActions & { call: jest.Mock; ui: jest.Mock } {
  return { call: jest.fn(() => ok), ui: jest.fn() };
}

describe('Contacts', () => {
  test('lists contacts, opens a card, calls and opens the Calls app', async () => {
    const a = contactsActions();
    const openApp = jest.fn();
    await render(<ContactsApp view={idle} actions={a} openApp={openApp} />);
    expect(a.ui).toHaveBeenCalledWith('appOpened', 'contacts');
    await fireEvent.press(screen.getByRole('button', { name: 'Участковый' }));
    expect(screen.getByText('+7 495 010-02-02')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Позвонить' }));
    expect(a.call).toHaveBeenCalledWith('ct_station');
    expect(openApp).toHaveBeenCalledWith('calls');
  });

  test('message button opens Messages; offline call shows a notice and stays', async () => {
    const a = contactsActions(false);
    const openApp = jest.fn();
    await render(<ContactsApp view={idle} actions={a} openApp={openApp} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Участковый' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Позвонить' }));
    expect(screen.getByText('Нет связи, звонок не отправлен')).toBeTruthy();
    expect(openApp).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Написать' }));
    expect(openApp).toHaveBeenCalledWith('messages');
  });

  test('calling is disabled during another call; empty state', async () => {
    const a = contactsActions();
    const { unmount } = await render(<ContactsApp view={base} actions={a} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Участковый' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Позвонить' }));
    expect(a.call).not.toHaveBeenCalled();
    expect(screen.getByText('Идёт другой звонок')).toBeTruthy();
    await unmount();
    await render(<ContactsApp view={{ ...base, contacts: [] }} actions={a} />);
    expect(screen.getByText('Нет контактов')).toBeTruthy();
  });
});

describe('Calls', () => {
  test('active call shows lines and sends callChoice', async () => {
    const a = callsActions();
    await render(<CallsApp view={base} actions={a} />);
    expect(a.ui).toHaveBeenCalledWith('appOpened', 'calls');
    expect(screen.getByText('Доктор Белов')).toBeTruthy();
    expect(screen.getByText(active.lines[0]!.text)).toBeTruthy();
    await fireEvent.press(screen.getByText('Хорошо, потом уточню.'));
    expect(a.choose).toHaveBeenCalledWith('choice_back_off');
  });

  test('ringing call can be answered; offline notice', async () => {
    const a = callsActions(false);
    const view: PhoneView = {
      ...base,
      activeCall: { ...active, state: 'ringing', lines: [], choices: [] },
    };
    await render(<CallsApp view={view} actions={a} />);
    expect(screen.getByText('Входящий звонок')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Ответить' }));
    expect(a.answer).toHaveBeenCalledWith('call_doctor_1');
    expect(screen.getByText('Нет связи, ответ не отправлен')).toBeTruthy();
  });

  test('call log: newest first, missed marked, unknown number hides the id', async () => {
    const view: PhoneView = {
      ...idle,
      callLog: [
        ...base.callLog,
        {
          id: 'cl3',
          contactId: 'ct_secret_id',
          direction: 'incoming',
          at: 1300,
          durationMinutes: 2,
        },
      ],
    };
    await render(<CallsApp view={view} actions={callsActions()} />);
    expect(screen.getByText('Неизвестный номер')).toBeTruthy();
    expect(screen.queryByText(/ct_secret_id/)).toBeNull();
    expect(screen.getByText('Пропущенный, 20:00')).toBeTruthy();
    expect(screen.getByText('Входящий, 21:40, 2 мин')).toBeTruthy();
    expect(screen.getByText('Исходящий, 01:10, 3 мин')).toBeTruthy();
    const order = screen
      .getAllByText(/Неизвестный номер|Доктор Белов|Участковый/)
      .map((n) => n.props.children);
    expect(order).toEqual(['Неизвестный номер', 'Доктор Белов', 'Участковый']);
    expect(screen.queryByRole('button', { name: /Позвонить: Неизвестный/ })).toBeNull();
  });

  test('call back from the log; ended call notice; empty log', async () => {
    const a = callsActions();
    const { rerender } = await render(<CallsApp view={base} actions={a} />);
    await rerender(<CallsApp view={idle} actions={a} />);
    expect(screen.getByText('Звонок завершён')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Позвонить: Участковый' }));
    expect(a.call).toHaveBeenCalledWith('ct_station');
    await rerender(<CallsApp view={{ ...idle, callLog: [] }} actions={a} />);
    expect(screen.getByText('Журнал звонков пуст')).toBeTruthy();
  });
});
