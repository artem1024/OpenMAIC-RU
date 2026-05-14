import { describe, expect, it } from 'vitest';
import { translations } from '@/lib/i18n';

type Translations = typeof translations;
type Locale = keyof Translations;

/**
 * Recursively flattens a translation tree to a list of dotted leaf keys.
 *
 * Only string values become keys — nested objects are descended into so
 * the resulting set matches what `translate(locale, key)` actually
 * resolves at runtime.
 */
function collectKeys(node: unknown, prefix = '', acc: string[] = []): string[] {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      collectKeys(v, next, acc);
    }
  } else if (typeof node === 'string') {
    acc.push(prefix);
  }
  return acc;
}

function diff(reference: string[], target: string[]): string[] {
  const set = new Set(target);
  return reference.filter((k) => !set.has(k)).sort();
}

describe('i18n key alignment', () => {
  // zh-CN is the source of truth (defaultLocale + most complete tree).
  // Every key present there must also exist in en-US and ru-RU; otherwise
  // translate() silently falls back to en-US or returns the raw key in UI.
  const reference: Locale = 'zh-CN';
  const targets: Locale[] = ['en-US', 'ru-RU'];

  const referenceKeys = collectKeys(translations[reference]);

  for (const locale of targets) {
    it(`${locale} contains every key present in ${reference}`, () => {
      const localeKeys = collectKeys(translations[locale]);
      const missing = diff(referenceKeys, localeKeys);
      expect(missing, `Missing keys in ${locale}:\n  ${missing.join('\n  ')}`).toEqual([]);
    });
  }

  it('reference locale itself has at least one key (sanity)', () => {
    expect(referenceKeys.length).toBeGreaterThan(0);
  });
});
