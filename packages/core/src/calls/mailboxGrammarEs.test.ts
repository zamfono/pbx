import { describe, expect, it } from 'vitest';

import { introMedia, messageHeaderMedia } from './mailboxGrammar.js';

const snd = (name: string): string => `sound:${name}`;
const digit = (name: string): string => snd(`digits/${name}`);
const YOU_HAVE = snd('mailbox/you-have');
const NEW = snd('mailbox/new-other');

describe('Spanish mailbox intro (§10.2 "Mailbox access")', () => {
  it.each<[number, string[]]>([
    [1, [YOU_HAVE, snd('mailbox/new-one')]],
    // veintiún mensajes nuevos, but once: once mensajes
    [21, [YOU_HAVE, digit('21un'), NEW]],
    [11, [YOU_HAVE, digit('11'), NEW]],
    // cien, ciento un
    [100, [YOU_HAVE, digit('100'), NEW]],
    [101, [YOU_HAVE, digit('ciento'), digit('1un'), NEW]],
    // veintiún mil, cien mil
    [21_000, [YOU_HAVE, digit('21un'), digit('1000'), NEW]],
    [100_000, [YOU_HAVE, digit('100'), digit('1000'), NEW]],
    // un millón de mensajes, mil millones de mensajes, dos millones quinientos mil mensajes
    [1_000_000, [YOU_HAVE, digit('1000000'), snd('mailbox/of'), NEW]],
    [
      1_000_000_000,
      [YOU_HAVE, digit('1000'), digit('1000000.2'), snd('mailbox/of'), NEW]
    ],
    [
      2_500_000,
      [
        YOU_HAVE,
        digit('2'),
        digit('1000000.2'),
        digit('500'),
        digit('1000'),
        NEW
      ]
    ]
  ])('%i new', (count, media) => {
    expect(introMedia('es', count, 0)).toEqual(media);
  });

  it('ends a header on the full form', () => {
    expect(messageHeaderMedia('es', 'new', 121)).toEqual([
      snd('mailbox/header-new'),
      digit('ciento'),
      snd('digits-final/21')
    ]);
  });
});
