/**
 * The mailbox menu's counted phrases (§10.2 "Mailbox access") in each tenant language's own
 * grammar (§9.1): the intro ("you have 2 new messages") follows app_voicemail's `vm_intro_de`,
 * `vm_intro_es`, `vm_intro_fr`, `vm_intro_it` and `vm_intro_multilang` (Russian), and a message's
 * header ("new message 2") takes the same language's singular. English stays the menu's own
 * sentence, which names both folders.
 */
import type { Language } from '@zamfono/shared';

import {
  folderWord,
  MAILBOX_PROMPTS,
  sound,
  type Folder
} from './mailboxPrompts.js';

/** Core-sounds names only some languages' sets ship, by language; the image test checks each
 * ships in its language's own set. */
export const MAILBOX_LANGUAGE_PROMPTS = {
  de: { oneFeminine: 'digits/1F' },
  es: {
    youHaveNo: 'vm-youhaveno',
    oneMasculine: 'digits/1M',
    newSingular: 'vm-INBOXs',
    oldSingular: 'vm-Olds'
  },
  it: {
    one: 'digits/un',
    newSingular: 'vm-nuovo',
    newPlural: 'vm-nuovi',
    oldSingular: 'vm-vecchio',
    oldPlural: 'vm-vecchi'
  },
  ru: {
    oneNeuter: 'digits/1n',
    twoNeuter: 'digits/2n',
    newSingular: 'vm-newn',
    newPlural: 'vm-newx',
    oldSingular: 'vm-oldn',
    oldPlural: 'vm-oldx',
    messageFew: 'vm-messagex1',
    messageMany: 'vm-messagex2'
  }
} as const;

const { de, es, it, ru } = MAILBOX_LANGUAGE_PROMPTS;

function number(value: number): string {
  return `number:${value}`;
}

function messageNoun(value: number): string {
  return sound(
    value === 1 ? MAILBOX_PROMPTS.message : MAILBOX_PROMPTS.messages
  );
}

/** "You have no new messages and 1 old message": both folders, always. */
function introEn(newCount: number, oldCount: number): string[] {
  const count = (value: number): string =>
    value === 0 ? sound(MAILBOX_PROMPTS.no) : number(value);
  return [
    sound(MAILBOX_PROMPTS.youHave),
    count(newCount),
    folderWord('new'),
    messageNoun(newCount),
    sound(MAILBOX_PROMPTS.and),
    count(oldCount),
    folderWord('old'),
    messageNoun(oldCount)
  ];
}

/** `vm_intro_de` / `vm_intro_fr`: the folders that hold messages, the noun once at the end; German
 * says a single message with the feminine "eine". */
function introNumberAdjectiveNoun(
  one: string | null
): (newCount: number, oldCount: number) => string[] {
  const count = (value: number): string =>
    value === 1 && one !== null ? sound(one) : number(value);
  return (newCount, oldCount) => {
    const media = [sound(MAILBOX_PROMPTS.youHave)];
    if (newCount > 0) {
      media.push(
        count(newCount),
        folderWord('new'),
        oldCount > 0 ? sound(MAILBOX_PROMPTS.and) : messageNoun(newCount)
      );
    }
    if (oldCount > 0) {
      media.push(count(oldCount), folderWord('old'), messageNoun(oldCount));
    }
    if (newCount === 0 && oldCount === 0) {
      media.push(sound(MAILBOX_PROMPTS.no), sound(MAILBOX_PROMPTS.messages));
    }
    return media;
  };
}

/** `vm_intro_es`: noun before adjective, "un mensaje nuevo", "2 mensajes nuevos". */
function esPart(folder: Folder, value: number): string[] {
  if (value === 1) {
    return [
      sound(es.oneMasculine),
      sound(MAILBOX_PROMPTS.message),
      sound(folder === 'new' ? es.newSingular : es.oldSingular)
    ];
  }
  return [number(value), sound(MAILBOX_PROMPTS.messages), folderWord(folder)];
}

/** `vm_intro_it`: "un nuovo messaggio", "2 nuovi messaggi". */
function itAdjective(folder: Folder, value: number): string {
  if (folder === 'new') {
    return sound(value === 1 ? it.newSingular : it.newPlural);
  }
  return sound(value === 1 ? it.oldSingular : it.oldPlural);
}

function itPart(folder: Folder, value: number): string[] {
  return [
    value === 1 ? sound(it.one) : number(value),
    itAdjective(folder, value),
    messageNoun(value)
  ];
}

/** The Spanish and Italian intro: "you have" and each folder that holds messages, or the
 * language's own "no messages". */
function introParts(
  none: string[],
  part: (folder: Folder, value: number) => string[]
): (newCount: number, oldCount: number) => string[] {
  return (newCount, oldCount) => {
    if (newCount === 0 && oldCount === 0) {
      return none;
    }
    return [
      sound(MAILBOX_PROMPTS.youHave),
      ...(newCount > 0 ? part('new', newCount) : []),
      ...(newCount > 0 && oldCount > 0 ? [sound(MAILBOX_PROMPTS.and)] : []),
      ...(oldCount > 0 ? part('old', oldCount) : [])
    ];
  };
}

/** Only a Russian count's last two digits pick its forms, and from 20 on only its last digit
 * (`say.c`'s counted endings). */
const RU_LAST_TWO_DIGITS = 100;
const RU_TEENS_END = 20;
const RU_LAST_DIGIT = 10;

function ruTail(value: number): number {
  const tail = value % RU_LAST_TWO_DIGITS;
  return tail >= RU_TEENS_END ? tail % RU_LAST_DIGIT : tail;
}

/** The neuter forms of a count ending in 1 or 2, as `ast_say_number(…, "n")` says them. */
const RU_NEUTER_DIGITS: Partial<Record<number, string>> = {
  1: ru.oneNeuter,
  2: ru.twoNeuter
};

/** The last digits that take the noun's "few" plural; the rest past 1 take its "many". */
const RU_FEW = { first: 2, last: 4 };

/** A count before a neuter noun: a 1 or 2 at its end takes the neuter form (ARI's `number:` has
 * no gender). */
function ruNumber(value: number): string[] {
  const last = ruTail(value);
  const neuter = RU_NEUTER_DIGITS[last];
  if (neuter === undefined) {
    return [number(value)];
  }
  const rest = value - last;
  return [...(rest > 0 ? [number(rest)] : []), sound(neuter)];
}

function ruAdjective(folder: Folder, value: number): string {
  const singular = ruTail(value) === 1;
  if (folder === 'new') {
    return sound(singular ? ru.newSingular : ru.newPlural);
  }
  return sound(singular ? ru.oldSingular : ru.oldPlural);
}

function ruMessageNoun(value: number): string {
  const last = ruTail(value);
  if (last === 1) {
    return sound(MAILBOX_PROMPTS.message);
  }
  return sound(
    last >= RU_FEW.first && last <= RU_FEW.last ? ru.messageFew : ru.messageMany
  );
}

/** `vm_intro_multilang` with the neuter "сообщение": the noun once, counted by the last count. */
function introRu(newCount: number, oldCount: number): string[] {
  const media = [sound(MAILBOX_PROMPTS.youHave)];
  if (newCount > 0) {
    media.push(...ruNumber(newCount), ruAdjective('new', newCount));
    if (oldCount > 0) {
      media.push(sound(MAILBOX_PROMPTS.and));
    }
  }
  if (oldCount > 0) {
    media.push(...ruNumber(oldCount), ruAdjective('old', oldCount));
  }
  const last = oldCount > 0 ? oldCount : newCount;
  if (last === 0) {
    media.push(sound(MAILBOX_PROMPTS.no));
  }
  media.push(ruMessageNoun(last));
  return media;
}

type Grammar = {
  intro: (newCount: number, oldCount: number) => string[];
  /** "New message", before the message's place in its folder. */
  header: (folder: Folder) => string[];
};

const ADJECTIVE_NOUN_HEADER = (folder: Folder): string[] => [
  folderWord(folder),
  sound(MAILBOX_PROMPTS.message)
];

const GRAMMARS: Record<Language, Grammar> = {
  en: { intro: introEn, header: ADJECTIVE_NOUN_HEADER },
  de: {
    intro: introNumberAdjectiveNoun(de.oneFeminine),
    header: ADJECTIVE_NOUN_HEADER
  },
  fr: { intro: introNumberAdjectiveNoun(null), header: ADJECTIVE_NOUN_HEADER },
  es: {
    intro: introParts(
      [sound(es.youHaveNo), sound(MAILBOX_PROMPTS.messages)],
      esPart
    ),
    header: folder => esPart(folder, 1).slice(1)
  },
  it: {
    intro: introParts(
      [sound(MAILBOX_PROMPTS.no), sound(MAILBOX_PROMPTS.message)],
      itPart
    ),
    header: folder => itPart(folder, 1).slice(1)
  },
  ru: {
    intro: introRu,
    header: folder => [ruAdjective(folder, 1), sound(MAILBOX_PROMPTS.message)]
  }
};

/** "You have 2 new messages and 1 old message", in the channel's language. */
export function introMedia(
  language: Language,
  newCount: number,
  oldCount: number
): string[] {
  return GRAMMARS[language].intro(newCount, oldCount);
}

/** "New message 2", before the message itself. */
export function messageHeaderMedia(
  language: Language,
  folder: Folder,
  position: number
): string[] {
  return [...GRAMMARS[language].header(folder), number(position)];
}
