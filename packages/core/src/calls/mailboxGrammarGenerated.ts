/**
 * The mailbox menu's counted phrases in a generated set (§9.1, §10.2 "Mailbox access"), the same in
 * every generated language: "you have", then each folder that holds messages, its count and the
 * folder's noun phrase in the form the count takes. The phrase of the category a single message
 * falls in says its numeral itself ("eine neue Nachricht", "одно новое сообщение"), so the count
 * before it leaves that out: nothing for 1, "двадцать" for 21 in Russian. The new messages'
 * phrase also comes with the "and" that follows it before the old ones, spoken as a sentence that
 * goes on. A language module names its plural categories, picks one for a count and reads the
 * numbers, which `composeNumber` builds from its clips: every number below 100 is one, so only a
 * hundred or a scale word is joined to it.
 */
import { FINAL_DIGITS_DIR } from '../prompts.js';
import { sound, type Folder } from './mailboxPrompts.js';

/** The clip names of a language's counted phrases, one per plural category it has. */
export function countedPrompts<Category extends string>(
  categories: readonly Category[]
) {
  const forms = (folder: Folder, suffix = ''): Record<Category, string> =>
    Object.fromEntries(
      categories.map(category => [
        category,
        `mailbox/${folder}-${category}${suffix}`
      ])
    ) as Record<Category, string>;
  return {
    /** "You have", before the counts. */
    youHave: 'mailbox/you-have',
    /** "You have no messages." */
    none: 'mailbox/none',
    /** The new messages' noun phrase ending the sentence. */
    newLast: forms('new'),
    /** The same, followed by "and" before the old messages. */
    newAnd: forms('new', '-and'),
    /** The old messages', always last. */
    oldLast: forms('old'),
    /** "New message number", "Saved message number", before a message's place in its folder. */
    header: { new: 'mailbox/header-new', old: 'mailbox/header-old' }
  } as const;
}

/** A number clip's falling form, which ends a sentence (`FINAL_DIGITS_DIR`) where a count's rises
 * into the noun after it. */
export function finalForm(name: string): string {
  return name.replace(/^digits\//u, `${FINAL_DIGITS_DIR}/`);
}

/** A number's clips ending a sentence: the last in its falling form. */
export function atSentenceEnd(names: readonly string[]): string[] {
  return names.map((name, index) =>
    index === names.length - 1 ? finalForm(name) : name
  );
}

const HUNDRED = 100;
export const THOUSAND = 1000;
export const MILLION = 1_000_000;
export const BILLION = 1_000_000_000;

/** A scale word and the clips that say `count` of it: "zwei" "tausend", "eine Million";
 * `leading` when it starts the number, where most languages leave a lone 1 out. */
export type Scale = {
  value: number;
  said: (count: number, leading: boolean) => string[];
};

/**
 * The clips that say `value`: its largest scale's count and word, then the rest; below a thousand,
 * the language's own reading (`belowThousand`, for 1 to 999).
 */
export function composeNumber(
  value: number,
  belowThousand: (value: number) => string[],
  scales: readonly Scale[],
  leading = true
): string[] {
  if (value === 0) {
    return ['digits/0'];
  }
  for (const scale of scales) {
    if (value >= scale.value) {
      const rest = value % scale.value;
      return [
        ...scale.said(Math.floor(value / scale.value), leading),
        ...(rest > 0 ? composeNumber(rest, belowThousand, scales, false) : [])
      ];
    }
  }
  return belowThousand(value);
}

/** 1 to 999 as the hundreds' clip ("zweihundert") and the rest's (`belowHundred`). */
export function hundredsAndRest(
  value: number,
  belowHundred: (value: number) => string = rest => `digits/${rest}`,
  hundreds: (value: number, rest: number) => string = hundred =>
    `digits/${hundred}`
): string[] {
  const rest = value % HUNDRED;
  const hundred = value - rest;
  return [
    ...(hundred > 0 ? [hundreds(hundred, rest)] : []),
    ...(rest > 0 ? [belowHundred(rest)] : [])
  ];
}

const LARGEST_COUNT = 999;

/** Every clip a language's counts and places can name: each form a count from 0 to 999 takes, alone
 * and before each scale, decides every clip there is. */
export function numberClips(
  ...readings: readonly ((value: number) => string[])[]
): string[] {
  const named = new Set<string>();
  for (let value = 0; value <= LARGEST_COUNT; value += 1) {
    for (const scale of [1, THOUSAND, MILLION, BILLION]) {
      for (const reading of readings) {
        for (const name of reading(value * scale)) {
          named.add(name);
        }
      }
    }
  }
  return [...named].sort();
}

export function countedGrammar<Category extends string>(language: {
  prompts: ReturnType<typeof countedPrompts<Category>>;
  category: (count: number) => Category;
  /** A count before the noun phrase, without the numeral the phrase says itself. */
  count: (value: number) => string[];
  /** A message's place, ending the sentence. */
  position: (value: number) => string[];
}) {
  const { prompts } = language;

  function folderPart(
    folder: Folder,
    count: number,
    beforeAnd: boolean
  ): string[] {
    const newForms = beforeAnd ? prompts.newAnd : prompts.newLast;
    const forms = folder === 'old' ? prompts.oldLast : newForms;
    const phrase = sound(forms[language.category(count)]);
    return [...language.count(count).map(sound), phrase];
  }

  return {
    intro(newCount: number, oldCount: number): string[] {
      if (newCount === 0 && oldCount === 0) {
        return [sound(prompts.none)];
      }
      return [
        sound(prompts.youHave),
        ...(newCount > 0 ? folderPart('new', newCount, oldCount > 0) : []),
        ...(oldCount > 0 ? folderPart('old', oldCount, false) : [])
      ];
    },
    header(folder: Folder, position: number): string[] {
      return [
        sound(prompts.header[folder]),
        ...language.position(position).map(sound)
      ];
    }
  };
}
