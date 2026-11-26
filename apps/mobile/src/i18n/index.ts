import { useSyncExternalStore } from 'react';
import { en } from './en';
import { ru, type MessageKey } from './ru';

export type Locale = 'ru' | 'en';
export const LOCALES: readonly Locale[] = ['ru', 'en'];
export const DEFAULT_LOCALE: Locale = 'ru';
export type { MessageKey };

type Dictionary = Partial<Record<MessageKey, string>>;
const DICTIONARIES: Record<Locale, Dictionary> = { ru, en };

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();
const warned = new Set<string>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of [...listeners]) listener();
}

/** Looks `key` up in `dictionaries[locale]`; a missing one falls back to ru and warns once. */
export function translate(
  dictionaries: Record<Locale, Dictionary>,
  key: MessageKey,
  locale: Locale,
): string {
  const text = dictionaries[locale][key];
  if (text !== undefined) return text;
  const mark = `${locale}:${key}`;
  if (!warned.has(mark)) {
    warned.add(mark);
    console.warn(
      `i18n: key '${key}' is missing for '${locale}', falling back to '${DEFAULT_LOCALE}'`,
    );
  }
  return dictionaries[DEFAULT_LOCALE][key] ?? key;
}

export function t(key: MessageKey, locale: Locale = current): string {
  return translate(DICTIONARIES, key, locale);
}

/** Keys of `ru` that `locale` does not translate. */
export function missingKeys(locale: Locale): MessageKey[] {
  return (Object.keys(ru) as MessageKey[]).filter((key) => DICTIONARIES[locale][key] === undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current locale; the component rerenders when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}
