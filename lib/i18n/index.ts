import { defaultLocale, type Locale } from './types';
export { type Locale, defaultLocale } from './types';
import { commonZhCN, commonEnUS, commonRuRU } from './common';
import { stageZhCN, stageEnUS, stageRuRU } from './stage';
import { chatZhCN, chatEnUS, chatRuRU } from './chat';
import { generationZhCN, generationEnUS, generationRuRU } from './generation';
import { settingsZhCN, settingsEnUS, settingsRuRU } from './settings';

export const translations = {
  'zh-CN': {
    ...commonZhCN,
    ...stageZhCN,
    ...chatZhCN,
    ...generationZhCN,
    ...settingsZhCN,
  },
  'en-US': {
    ...commonEnUS,
    ...stageEnUS,
    ...chatEnUS,
    ...generationEnUS,
    ...settingsEnUS,
  },
  'ru-RU': {
    ...commonRuRU,
    ...stageRuRU,
    ...chatRuRU,
    ...generationRuRU,
    ...settingsRuRU,
  },
} as const;

export type TranslationKey = keyof (typeof translations)[typeof defaultLocale];

function resolveKey(locale: Locale, key: string): string | undefined {
  const keys = key.split('.');
  let value: unknown = translations[locale];
  for (const k of keys) {
    value = (value as Record<string, unknown>)?.[k];
  }
  return typeof value === 'string' ? value : undefined;
}

export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  // Try active locale; fall back to en-US; otherwise return the key itself
  // so dev sees the missing key in UI rather than a blank string.
  let str = resolveKey(locale, key);
  if (str === undefined && locale !== 'en-US') {
    str = resolveKey('en-US', key);
  }
  let result = str ?? key;
  if (vars) {
    // Поддерживаем оба плейсхолдера: {{name}} (upstream-стиль) и {name}.
    result = result.replace(/\{\{?\s*(\w+)\s*\}?\}/g, (m, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
    );
  }
  return result;
}

/**
 * Substitutes named placeholders like `{name}` inside a translated string.
 *
 *   interpolate('Hello {name}, you have {count} items', { name: 'Anna', count: 3 })
 *   // => 'Hello Anna, you have 3 items'
 *
 * Placeholders that are missing in `vars` are left untouched so the bug is visible.
 */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Picks one of three Russian-style plural forms based on the count.
 * Falls back to the third form for `many`/`other`/`zero` categories.
 *
 *   plural(1, ['элемент', 'элемента', 'элементов']) // => 'элемент'
 *   plural(2, ['элемент', 'элемента', 'элементов']) // => 'элемента'
 *   plural(5, ['элемент', 'элемента', 'элементов']) // => 'элементов'
 */
export function plural(
  n: number,
  forms: [one: string, few: string, many: string],
  locale: string = 'ru-RU',
): string {
  const rule = new Intl.PluralRules(locale).select(n);
  if (rule === 'one') return forms[0];
  if (rule === 'few') return forms[1];
  return forms[2];
}

export function getClientTranslation(key: string): string {
  let locale: Locale = defaultLocale;

  if (typeof window !== 'undefined') {
    try {
      const storedLocale = localStorage.getItem('locale');
      if (storedLocale === 'zh-CN' || storedLocale === 'en-US' || storedLocale === 'ru-RU') {
        locale = storedLocale;
      }
    } catch {
      // localStorage unavailable, keep default locale
    }
  }

  return translate(locale, key);
}
