import { fireEvent, render, screen } from '@testing-library/react-native';
import { LOCALES, getLocale, missingKeys, setLocale, translate } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { SettingsApp } from '../src/os-apps/settings/App';

afterEach(() => {
  setLocale('ru');
  jest.restoreAllMocks();
});

test('every locale translates every ru key', () => {
  for (const locale of LOCALES) expect(missingKeys(locale)).toEqual([]);
});

test('ru strings are non-empty', () => {
  for (const value of Object.values(ru)) expect(value.trim()).not.toBe('');
});

test('a missing key falls back to ru with one warning', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const dictionaries = { ru, en: {} };
  expect(translate(dictionaries, 'settings.title', 'en')).toBe('Настройки');
  expect(translate(dictionaries, 'settings.title', 'en')).toBe('Настройки');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain('settings.title');
});

test('the settings screen switches the language', async () => {
  await render(<SettingsApp />);
  expect(screen.getByText('Язык')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'English' }));
  expect(getLocale()).toBe('en');
  expect(screen.getByText('Language')).toBeTruthy();
});
