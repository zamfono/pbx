import { describe, expect, it } from 'vitest';

import { LANGUAGES } from '@zamfono/shared';

import { introMedia, messageHeaderMedia } from './mailboxGrammar.js';
import { generatedPromptNames } from './promptSet.js';

const COUNTS = [
  ...Array.from({ length: 1201 }, (_unused, value) => value),
  2001,
  21_000,
  101_000,
  1_000_000,
  1_001_000,
  2_000_101,
  21_000_000,
  1_000_000_000,
  2_500_000_000
];

describe.each(LANGUAGES)(
  'the %s mailbox phrases (§10.2 "Mailbox access")',
  language => {
    const set = new Set(
      generatedPromptNames(language).map(name => `sound:${name}`)
    );

    it('name only prompts the generated set holds, for any count and place', () => {
      const missing = new Set<string>();
      for (const count of COUNTS) {
        for (const entry of [
          ...introMedia(language, count, 0),
          ...introMedia(language, count, 1),
          ...introMedia(language, 2, count),
          ...messageHeaderMedia(language, 'new', count + 1)
        ]) {
          if (!set.has(entry)) {
            missing.add(entry);
          }
        }
      }
      expect([...missing]).toEqual([]);
    });
  }
);
