import { describe, expect, it } from 'vitest';

import { introMedia, messageHeaderMedia } from './mailboxGrammar.js';
import { germanNumber } from './mailboxGrammarDe.js';
import { generatedPromptNames } from './promptSet.js';

const snd = (name: string): string => `sound:${name}`;
const digit = (name: string): string => snd(`digits/${name}`);
const YOU_HAVE = snd('mailbox/you-have');

describe('German mailbox intro (§10.2 "Mailbox access")', () => {
  it.each<[number, number, string[]]>([
    [0, 0, [snd('mailbox/none')]],
    // eine neue Nachricht
    [1, 0, [YOU_HAVE, snd('mailbox/new-one')]],
    // zwei, einundzwanzig neue Nachrichten
    [2, 0, [YOU_HAVE, digit('2'), snd('mailbox/new-other')]],
    [21, 0, [YOU_HAVE, digit('21'), snd('mailbox/new-other')]],
    // eine gespeicherte Nachricht
    [0, 1, [YOU_HAVE, snd('mailbox/old-one')]],
    // hundert eine neue Nachrichten, tausend eine
    [101, 0, [YOU_HAVE, digit('100'), digit('eine'), snd('mailbox/new-other')]],
    [
      1001,
      0,
      [YOU_HAVE, digit('1000'), digit('eine'), snd('mailbox/new-other')]
    ],
    // zwei neue Nachrichten und eine gespeicherte Nachricht
    [
      2,
      1,
      [
        YOU_HAVE,
        digit('2'),
        snd('mailbox/new-other-and'),
        snd('mailbox/old-one')
      ]
    ],
    // eine neue Nachricht und hundertzwölf gespeicherte Nachrichten
    [
      1,
      112,
      [
        YOU_HAVE,
        snd('mailbox/new-one-and'),
        digit('100'),
        digit('12'),
        snd('mailbox/old-other')
      ]
    ]
  ])('%i new and %i old', (newCount, oldCount, media) => {
    expect(introMedia('de', newCount, oldCount)).toEqual(media);
  });

  it('heads a message with its folder and its place, ending the sentence', () => {
    expect(messageHeaderMedia('de', 'new', 2)).toEqual([
      snd('mailbox/header-new'),
      snd('digits-final/2')
    ]);
    expect(messageHeaderMedia('de', 'new', 101)).toEqual([
      snd('mailbox/header-new'),
      digit('100'),
      snd('digits-final/1')
    ]);
    expect(messageHeaderMedia('de', 'old', 132)).toEqual([
      snd('mailbox/header-old'),
      digit('100'),
      snd('digits-final/32')
    ]);
  });
});

describe('German numbers', () => {
  it.each<[number, string[]]>([
    [0, ['0']],
    [21, ['21']],
    [100, ['100']],
    [132, ['100', '32']],
    [1000, ['1000']],
    [2001, ['2', '1000', '1']],
    [101_000, ['100', 'ein', '1000']],
    [101_000_000, ['100', 'eine', '1000000.2']],
    [112_000, ['100', '12', '1000']],
    [1_000_000, ['1000000']],
    [2_000_005, ['2', '1000000.2', '5']],
    [1_001_000_000, ['1000000000', '1000000']],
    [1_000_000_000_000, ['1000', '1000000000.2']]
  ])('%i', (value, names) => {
    expect(germanNumber(value)).toEqual(names.map(name => `digits/${name}`));
  });

  it('names only prompts the generated set holds, in the intro and the header', () => {
    const set = new Set(generatedPromptNames('de').map(snd));
    for (let newCount = 0; newCount <= 130; newCount += 1) {
      for (const oldCount of [0, 1, 2, 21, 1000, 2_000_000]) {
        for (const entry of introMedia('de', newCount, oldCount)) {
          expect(set).toContain(entry);
        }
      }
      for (const entry of messageHeaderMedia('de', 'old', newCount + 1)) {
        expect(set).toContain(entry);
      }
    }
  });
});
