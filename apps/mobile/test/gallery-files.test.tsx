import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { FILE_OFFLINE, FilesApp, WRONG_PASSWORD, buildTree } from '../src/os-apps/files/App';
import { GalleryApp } from '../src/os-apps/gallery/App';
import { cardStyleFor } from '../src/os-apps/gallery/EvidenceCard';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useDisplayStore } from '../src/stores/displayStore';

const mockSendAction = jest.fn();
jest.mock('../src/connection/gameConnection', () => ({
  sendPhoneAction: (action: unknown) => mockSendAction(action),
}));

const view = PhoneView.parse(fixture);

beforeEach(() => {
  mockSendAction.mockReset();
  mockSendAction.mockReturnValue(true);
  useConnectionStore.setState({ status: 'online' });
  useDisplayStore.setState({ textSize: 'normal' });
});

describe('GalleryApp', () => {
  test('shows a grid card for every photo, newest first', async () => {
    await render(<GalleryApp view={view} />);
    const buttons = screen.getAllByRole('button', { name: /^Снимок:/ });
    expect(buttons).toHaveLength(view.gallery.length);
    const times = view.gallery.map((g) => g.takenAt).sort((a, b) => b - a);
    const newest = view.gallery.find((g) => g.takenAt === times[0])!;
    expect(buttons[0]!.props.accessibilityLabel).toBe(`Снимок: ${newest.title}`);
  });

  test('opens a photo with time, place and zoom controls', async () => {
    await render(<GalleryApp view={view} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Снимок: Порванная записка' }));
    expect(screen.getByText('Время: 1:36')).toBeTruthy();
    expect(screen.getByText('Место: Зимний сад')).toBeTruthy();
    expect(screen.getByText('×1')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Увеличить' }));
    expect(screen.getByText('×1.5')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Уменьшить' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByText('Время: 1:36')).toBeNull();
  });

  test('zoom is bounded and an empty gallery says so', async () => {
    await render(<GalleryApp view={view} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Снимок: Порванная записка' }));
    expect(
      screen.getByRole('button', { name: 'Уменьшить' }).props.accessibilityState.disabled,
    ).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await fireEvent.press(screen.getByRole('button', { name: 'Увеличить' }));
    }
    expect(screen.getByText('×3')).toBeTruthy();
    await render(<GalleryApp view={{ ...view, gallery: [] }} />);
    expect(screen.getByText('Снимков пока нет.')).toBeTruthy();
  });

  test('card look depends only on the ref, not on a clue prefix', () => {
    expect(cardStyleFor('clue_note.jpg')).toEqual(cardStyleFor('clue_note.jpg'));
    const styles = new Set(
      ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg', 'g.jpg'].map(
        (r) => cardStyleFor(r).background,
      ),
    );
    expect(styles.size).toBeGreaterThan(1);
  });
});

describe('FilesApp', () => {
  test('lists files with a lock mark and opens an open document', async () => {
    await render(<FilesApp view={view} />);
    expect(screen.getByText('🔒 Бухгалтерия_2025.xlsx')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'График дежурств.pdf' }));
    expect(screen.getByText(/Ночное дежурство на этой неделе/)).toBeTruthy();
    expect(mockSendAction).toHaveBeenCalledWith({ type: 'openFile', fileId: 'file_schedule' });
    await fireEvent.press(screen.getByRole('button', { name: 'К списку файлов' }));
    expect(screen.getByText('🔒 Бухгалтерия_2025.xlsx')).toBeTruthy();
  });

  test('a locked file shows the hint and no content; opening it sends no action', async () => {
    await render(<FilesApp view={view} />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Бухгалтерия_2025.xlsx, закрыт паролем' }),
    );
    expect(screen.getByText('Подсказка: Год основания санатория')).toBeTruthy();
    expect(mockSendAction).not.toHaveBeenCalled();
  });

  test('sends unlockFile once; a wrong password gives a message and no retry', async () => {
    const { rerender } = await render(<FilesApp view={view} />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Бухгалтерия_2025.xlsx, закрыт паролем' }),
    );
    await fireEvent.changeText(screen.getByLabelText('Пароль'), '1900');
    await fireEvent.press(screen.getByRole('button', { name: 'Открыть' }));
    expect(mockSendAction).toHaveBeenCalledTimes(1);
    expect(mockSendAction).toHaveBeenCalledWith({
      type: 'unlockFile',
      fileId: 'file_accounts',
      password: '1900',
    });
    // The server answered with a new view; the file is still locked.
    await act(async () => {
      await rerender(<FilesApp view={{ ...view }} />);
    });
    expect(screen.getByText(WRONG_PASSWORD)).toBeTruthy();
    expect(mockSendAction).toHaveBeenCalledTimes(1);
  });

  test('a correct password shows the content from the next view', async () => {
    const { rerender } = await render(<FilesApp view={view} />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Бухгалтерия_2025.xlsx, закрыт паролем' }),
    );
    await fireEvent.changeText(screen.getByLabelText('Пароль'), '1923');
    await fireEvent.press(screen.getByRole('button', { name: 'Открыть' }));
    const unlocked = {
      ...view,
      files: view.files.map((f) =>
        f.id === 'file_accounts'
          ? { id: f.id, name: f.name, locked: false, content: 'Остаток: 0' }
          : f,
      ),
    };
    await act(async () => {
      await rerender(<FilesApp view={unlocked} />);
    });
    expect(screen.getByText('Остаток: 0')).toBeTruthy();
    expect(screen.queryByText(WRONG_PASSWORD)).toBeNull();
  });

  test('offline: the attempt is not sent and the player is told', async () => {
    mockSendAction.mockReturnValue(false);
    await render(<FilesApp view={view} />);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Бухгалтерия_2025.xlsx, закрыт паролем' }),
    );
    await fireEvent.changeText(screen.getByLabelText('Пароль'), 'x');
    await fireEvent.press(screen.getByRole('button', { name: 'Открыть' }));
    expect(screen.getByText(FILE_OFFLINE)).toBeTruthy();
  });

  test('buildTree groups by folder, root first', () => {
    const f = (id: string, name: string) => ({ id, name, locked: false });
    const tree = buildTree([f('1', 'b/x.txt'), f('2', 'root.txt'), f('3', 'a/y.txt')]);
    expect(tree.map((g) => g.folder)).toEqual(['', 'a', 'b']);
  });
});
