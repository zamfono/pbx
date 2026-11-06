import { describe, expect, it } from 'vitest';

import { introMedia, messageHeaderMedia } from './mailboxGrammar.js';

const snd = (name: string): string => `sound:${name}`;
const digit = (name: string): string => snd(`digits/${name}`);
const YOU_HAVE = snd('mailbox/you-have');

describe('Russian mailbox intro (§10.2 "Mailbox access")', () => {
  it.each<[number, string[]]>([
    [0, [snd('mailbox/none')]],
    // одно новое сообщение; двадцать | одно новое сообщение
    [1, [YOU_HAVE, snd('mailbox/new-one')]],
    [21, [YOU_HAVE, digit('20'), snd('mailbox/new-one')]],
    [101, [YOU_HAVE, digit('100'), snd('mailbox/new-one')]],
    // два, двадцать два новых сообщения; пять, одиннадцать, двенадцать новых сообщений
    [2, [YOU_HAVE, digit('2'), snd('mailbox/new-few')]],
    [22, [YOU_HAVE, digit('22'), snd('mailbox/new-few')]],
    [5, [YOU_HAVE, digit('5'), snd('mailbox/new-many')]],
    [11, [YOU_HAVE, digit('11'), snd('mailbox/new-many')]],
    [12, [YOU_HAVE, digit('12'), snd('mailbox/new-many')]],
    // тысяча, две тысячи, двадцать одна тысяча, пять тысяч
    [1000, [YOU_HAVE, digit('1000'), snd('mailbox/new-many')]],
    [2000, [YOU_HAVE, digit('2f'), digit('1000.2'), snd('mailbox/new-many')]],
    [21_000, [YOU_HAVE, digit('21f'), digit('1000'), snd('mailbox/new-many')]],
    [5000, [YOU_HAVE, digit('5'), digit('1000.5'), snd('mailbox/new-many')]],
    // миллион одна тысяча
    [
      1_001_000,
      [
        YOU_HAVE,
        digit('1000000'),
        digit('1f'),
        digit('1000'),
        snd('mailbox/new-many')
      ]
    ]
  ])('%i new', (count, media) => {
    expect(introMedia('ru', count, 0)).toEqual(media);
  });

  it('joins the new messages to the saved ones with "и"', () => {
    expect(introMedia('ru', 2, 1)).toEqual([
      YOU_HAVE,
      digit('2'),
      snd('mailbox/new-few-and'),
      snd('mailbox/old-one')
    ]);
  });

  it('ends a header on the masculine number', () => {
    expect(messageHeaderMedia('ru', 'old', 21)).toEqual([
      snd('mailbox/header-old'),
      snd('digits-final/21')
    ]);
  });
});
