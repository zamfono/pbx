import { describe, expect, it } from 'vitest';

import { introMedia, messageHeaderMedia } from './mailboxGrammar.js';
import {
  POLISH_NUMBER_PROMPTS,
  polishNumber,
  polishNumberAtEnd
} from './mailboxGrammarPl.js';
import { generatedPromptNames } from './promptSet.js';

const snd = (name: string): string => `sound:${name}`;
const digit = (name: string): string => snd(`digits/${name}`);
const YOU_HAVE = snd('mailbox/you-have');

describe('Polish mailbox intro (§10.2 "Mailbox access")', () => {
  it.each<[number, number, string[]]>([
    [0, 0, [snd('mailbox/none')]],
    // jedną nową wiadomość
    [1, 0, [YOU_HAVE, snd('mailbox/new-one')]],
    // dwie nowe wiadomości, trzy, cztery
    [2, 0, [YOU_HAVE, digit('2z'), snd('mailbox/new-few')]],
    [4, 0, [YOU_HAVE, digit('4'), snd('mailbox/new-few')]],
    // pięć … dwadzieścia jeden nowych wiadomości
    [5, 0, [YOU_HAVE, digit('5'), snd('mailbox/new-many')]],
    [12, 0, [YOU_HAVE, digit('12'), snd('mailbox/new-many')]],
    [14, 0, [YOU_HAVE, digit('14'), snd('mailbox/new-many')]],
    [21, 0, [YOU_HAVE, digit('21'), snd('mailbox/new-many')]],
    // dwadzieścia dwie nowe wiadomości
    [22, 0, [YOU_HAVE, digit('22z'), snd('mailbox/new-few')]],
    [24, 0, [YOU_HAVE, digit('24'), snd('mailbox/new-few')]],
    // sto dwanaście nowych, sto dwadzieścia dwie nowe
    [112, 0, [YOU_HAVE, digit('100'), digit('12'), snd('mailbox/new-many')]],
    [122, 0, [YOU_HAVE, digit('100'), digit('22z'), snd('mailbox/new-few')]],
    // jedną zapisaną wiadomość
    [0, 1, [YOU_HAVE, snd('mailbox/old-one')]],
    // dwie nowe wiadomości i jedną zapisaną wiadomość
    [
      2,
      1,
      [
        YOU_HAVE,
        digit('2z'),
        snd('mailbox/new-few-and'),
        snd('mailbox/old-one')
      ]
    ],
    // jedną nową wiadomość i pięć zapisanych wiadomości
    [
      1,
      5,
      [
        YOU_HAVE,
        snd('mailbox/new-one-and'),
        digit('5'),
        snd('mailbox/old-many')
      ]
    ],
    [
      5,
      3,
      [
        YOU_HAVE,
        digit('5'),
        snd('mailbox/new-many-and'),
        digit('3'),
        snd('mailbox/old-few')
      ]
    ]
  ])('%i new and %i old', (newCount, oldCount, media) => {
    expect(introMedia('pl', newCount, oldCount)).toEqual(media);
  });

  it('heads a message with its folder and its place, in the masculine, ending the sentence', () => {
    expect(messageHeaderMedia('pl', 'new', 2)).toEqual([
      snd('mailbox/header-new'),
      snd('digits-final/2')
    ]);
    expect(messageHeaderMedia('pl', 'old', 1)).toEqual([
      snd('mailbox/header-old'),
      snd('digits-final/1')
    ]);
  });
});

describe('Polish numbers', () => {
  it.each<[number, boolean, string[]]>([
    [0, false, ['0']],
    [2, false, ['2']],
    [2, true, ['2z']],
    [1000, true, ['1000']],
    [1002, true, ['1000', '2z']],
    [2000, true, ['2', '1000.2']],
    [5000, true, ['5', '1000.5']],
    [12_000, true, ['12', '1000.5']],
    [22_000, true, ['22', '1000.2']],
    [22, true, ['22z']],
    [22, false, ['22']],
    [12, true, ['12']],
    [132, true, ['100', '32z']],
    [112_000, true, ['100', '12', '1000.5']],
    [1_001_000, true, ['1000000', '1000']],
    [2_000_000_002, true, ['2', '1000000000.2', '2z']],
    [1_000_000_000_000, false, ['1000', '1000000000.5']]
  ])('%i, feminine %s', (value, feminine, names) => {
    expect(polishNumber(value, feminine)).toEqual(
      names.map(name => `digits/${name}`)
    );
  });

  it.each<[number, string[]]>([
    [7, ['digits-final/7']],
    [21, ['digits-final/21']],
    [132, ['digits/100', 'digits-final/32']],
    [2000, ['digits/2', 'digits-final/1000.2']]
  ])('%i ending a sentence', (value, names) => {
    expect(polishNumberAtEnd(value)).toEqual(names);
  });

  it('names only clips the Polish set has, for any count', () => {
    const known = new Set(POLISH_NUMBER_PROMPTS);
    const named = new Set<string>();
    for (let value = 0; value <= 3000; value += 1) {
      for (const scale of [1, 1000, 1_000_000, 1_000_000_000]) {
        for (const name of [
          ...polishNumber(value * scale, true),
          ...polishNumber(value * scale, false),
          ...polishNumberAtEnd(value * scale)
        ]) {
          named.add(name);
        }
      }
    }
    expect([...named].filter(name => !known.has(name))).toEqual([]);
    expect(POLISH_NUMBER_PROMPTS.filter(name => !named.has(name))).toEqual([]);
  });

  it('names only prompts the generated set holds, in the intro and the header', () => {
    const set = new Set(generatedPromptNames('pl').map(snd));
    for (let newCount = 0; newCount <= 130; newCount += 1) {
      for (const oldCount of [0, 1, 2, 5, 12, 22, 1000]) {
        for (const entry of introMedia('pl', newCount, oldCount)) {
          expect(set).toContain(entry);
        }
      }
      for (const entry of messageHeaderMedia('pl', 'old', newCount + 1)) {
        expect(set).toContain(entry);
      }
    }
  });
});
