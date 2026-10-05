import { describe, expect, it } from 'vitest';

import type { Language } from '@zamfono/shared';

import { introMedia, messageHeaderMedia } from './mailboxGrammar.js';

const snd = (name: string): string => `sound:${name}`;
const num = (value: number): string => `number:${value}`;

const YOU_HAVE = snd('vm-youhave');
const AND = snd('vm-and');
const NEW = snd('vm-INBOX');
const OLD = snd('vm-Old');
const MESSAGE = snd('vm-message');
const MESSAGES = snd('vm-messages');

/** [new, old] counts and what the intro says for them. */
type IntroCase = [number, number, string[]];

const INTROS: Record<Language, IntroCase[]> = {
  en: [
    [
      0,
      0,
      [YOU_HAVE, snd('vm-no'), NEW, MESSAGES, AND, snd('vm-no'), OLD, MESSAGES]
    ],
    [1, 0, [YOU_HAVE, num(1), NEW, MESSAGE, AND, snd('vm-no'), OLD, MESSAGES]],
    [2, 0, [YOU_HAVE, num(2), NEW, MESSAGES, AND, snd('vm-no'), OLD, MESSAGES]],
    [5, 0, [YOU_HAVE, num(5), NEW, MESSAGES, AND, snd('vm-no'), OLD, MESSAGES]],
    [
      21,
      0,
      [YOU_HAVE, num(21), NEW, MESSAGES, AND, snd('vm-no'), OLD, MESSAGES]
    ],
    [2, 1, [YOU_HAVE, num(2), NEW, MESSAGES, AND, num(1), OLD, MESSAGE]]
  ],
  de: [
    [0, 0, [YOU_HAVE, snd('vm-no'), MESSAGES]],
    [1, 0, [YOU_HAVE, snd('digits/1F'), NEW, MESSAGE]],
    [2, 0, [YOU_HAVE, num(2), NEW, MESSAGES]],
    [5, 0, [YOU_HAVE, num(5), NEW, MESSAGES]],
    [21, 0, [YOU_HAVE, num(21), NEW, MESSAGES]],
    [2, 1, [YOU_HAVE, num(2), NEW, AND, snd('digits/1F'), OLD, MESSAGE]],
    [0, 21, [YOU_HAVE, num(21), OLD, MESSAGES]]
  ],
  fr: [
    [0, 0, [YOU_HAVE, snd('vm-no'), MESSAGES]],
    [1, 0, [YOU_HAVE, num(1), NEW, MESSAGE]],
    [2, 0, [YOU_HAVE, num(2), NEW, MESSAGES]],
    [5, 0, [YOU_HAVE, num(5), NEW, MESSAGES]],
    [21, 0, [YOU_HAVE, num(21), NEW, MESSAGES]],
    [2, 1, [YOU_HAVE, num(2), NEW, AND, num(1), OLD, MESSAGE]]
  ],
  es: [
    [0, 0, [snd('vm-youhaveno'), MESSAGES]],
    [1, 0, [YOU_HAVE, snd('digits/1M'), MESSAGE, snd('vm-INBOXs')]],
    [2, 0, [YOU_HAVE, num(2), MESSAGES, NEW]],
    [5, 0, [YOU_HAVE, num(5), MESSAGES, NEW]],
    [21, 0, [YOU_HAVE, num(21), MESSAGES, NEW]],
    [
      2,
      1,
      [
        YOU_HAVE,
        num(2),
        MESSAGES,
        NEW,
        AND,
        snd('digits/1M'),
        MESSAGE,
        snd('vm-Olds')
      ]
    ],
    [0, 5, [YOU_HAVE, num(5), MESSAGES, OLD]]
  ],
  it: [
    [0, 0, [snd('vm-no'), MESSAGE]],
    [1, 0, [YOU_HAVE, snd('digits/un'), snd('vm-nuovo'), MESSAGE]],
    [2, 0, [YOU_HAVE, num(2), snd('vm-nuovi'), MESSAGES]],
    [5, 0, [YOU_HAVE, num(5), snd('vm-nuovi'), MESSAGES]],
    [21, 0, [YOU_HAVE, num(21), snd('vm-nuovi'), MESSAGES]],
    [
      2,
      1,
      [
        YOU_HAVE,
        num(2),
        snd('vm-nuovi'),
        MESSAGES,
        AND,
        snd('digits/un'),
        snd('vm-vecchio'),
        MESSAGE
      ]
    ],
    [0, 5, [YOU_HAVE, num(5), snd('vm-vecchi'), MESSAGES]]
  ],
  ru: [
    [0, 0, [YOU_HAVE, snd('vm-no'), snd('vm-messagex2')]],
    [1, 0, [YOU_HAVE, snd('digits/1n'), snd('vm-newn'), MESSAGE]],
    [2, 0, [YOU_HAVE, snd('digits/2n'), snd('vm-newx'), snd('vm-messagex1')]],
    [5, 0, [YOU_HAVE, num(5), snd('vm-newx'), snd('vm-messagex2')]],
    [21, 0, [YOU_HAVE, num(20), snd('digits/1n'), snd('vm-newn'), MESSAGE]],
    [
      2,
      1,
      [
        YOU_HAVE,
        snd('digits/2n'),
        snd('vm-newx'),
        AND,
        snd('digits/1n'),
        snd('vm-oldn'),
        MESSAGE
      ]
    ],
    [0, 11, [YOU_HAVE, num(11), snd('vm-oldx'), snd('vm-messagex2')]],
    [
      0,
      22,
      [YOU_HAVE, num(20), snd('digits/2n'), snd('vm-oldx'), snd('vm-messagex1')]
    ]
  ]
};

/** What a message's header says before its place in the folder, new and old. */
const HEADERS: Record<Language, [string[], string[]]> = {
  en: [
    [NEW, MESSAGE],
    [OLD, MESSAGE]
  ],
  de: [
    [NEW, MESSAGE],
    [OLD, MESSAGE]
  ],
  fr: [
    [NEW, MESSAGE],
    [OLD, MESSAGE]
  ],
  es: [
    [MESSAGE, snd('vm-INBOXs')],
    [MESSAGE, snd('vm-Olds')]
  ],
  it: [
    [snd('vm-nuovo'), MESSAGE],
    [snd('vm-vecchio'), MESSAGE]
  ],
  ru: [
    [snd('vm-newn'), MESSAGE],
    [snd('vm-oldn'), MESSAGE]
  ]
};

describe('mailbox counted phrases per language (§10.2 "Mailbox access", §9.1)', () => {
  for (const [language, cases] of Object.entries(INTROS)) {
    it.each(cases)(
      `${language}: the intro for %i new and %i old`,
      (newCount, oldCount, expected) => {
        expect(introMedia(language as Language, newCount, oldCount)).toEqual(
          expected
        );
      }
    );
  }

  it.each(Object.entries(HEADERS))(
    '%s: a message header names its folder in the singular',
    (language, [newHeader, oldHeader]) => {
      expect(messageHeaderMedia(language as Language, 'new', 3)).toEqual([
        ...newHeader,
        num(3)
      ]);
      expect(messageHeaderMedia(language as Language, 'old', 21)).toEqual([
        ...oldHeader,
        num(21)
      ]);
    }
  );
});
