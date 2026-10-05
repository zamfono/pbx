import { describe, expect, it } from 'vitest';

import { LANGUAGES } from '@zamfono/shared';

import { dictionaryFor } from './index.js';

/** Every string of `dictionary` by its dotted key. */
function entries(dictionary: object, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(dictionary)) {
    if (typeof value === 'string') {
      result.set(`${prefix}${key}`, value);
    } else {
      for (const [inner, text] of entries(
        value as object,
        `${prefix}${key}.`
      )) {
        result.set(inner, text);
      }
    }
  }
  return result;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\w+\}/gu)].map(match => match[0]).sort();
}

describe('the six dictionaries', () => {
  const english = entries(dictionaryFor('en'));

  for (const language of LANGUAGES) {
    it(`${language} has every English key, non-empty, with the same placeholders`, () => {
      const dictionary = entries(dictionaryFor(language));
      expect([...dictionary.keys()].sort()).toEqual([...english.keys()].sort());
      for (const [key, text] of english) {
        const translated = dictionary.get(key) ?? '';
        expect(translated.trim(), key).not.toBe('');
        expect(placeholders(translated), key).toEqual(placeholders(text));
      }
    });
  }
});
