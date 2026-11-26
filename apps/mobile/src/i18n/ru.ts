/** Russian source dictionary (QA-003). Keys are the contract: every other locale mirrors them. */
export const ru = {
  'settings.title': 'Настройки',
  'settings.language': 'Язык',
  'language.ru': 'Русский',
  'language.en': 'English',
  'common.inProgress': 'В разработке',
} as const;

export type MessageKey = keyof typeof ru;
