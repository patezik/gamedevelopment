import type { MessageKey } from './ru';

/** English dictionary; a key missing here falls back to Russian with a warning. */
export const en: Partial<Record<MessageKey, string>> = {
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'language.ru': 'Русский',
  'language.en': 'English',
  'common.inProgress': 'Under construction',
};
