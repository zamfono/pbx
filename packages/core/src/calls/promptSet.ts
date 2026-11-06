/**
 * Every prompt the core can play in a language (§9.1), the set
 * `images/asterisk/prompts/<language>/<voice>/` has to hold in full, for each voice: the fixed
 * prompts, the mailbox menu, the language's counted phrases and number clips, the digits a parking
 * slot is read with, and the tone a recorded greeting starts on. The unit test checks the
 * committed sets against it and `test/integration/prompts.sh` the image.
 */
import type { Language } from '@zamfono/shared';

import { digitsMedia, PROMPTS } from '../prompts.js';
import {
  GERMAN_MAILBOX_PROMPTS,
  GERMAN_NUMBER_PROMPTS
} from './mailboxGrammarDe.js';
import {
  ENGLISH_MAILBOX_PROMPTS,
  ENGLISH_NUMBER_PROMPTS
} from './mailboxGrammarEn.js';
import {
  SPANISH_MAILBOX_PROMPTS,
  SPANISH_NUMBER_PROMPTS
} from './mailboxGrammarEs.js';
import {
  FRENCH_MAILBOX_PROMPTS,
  FRENCH_NUMBER_PROMPTS
} from './mailboxGrammarFr.js';
import {
  ITALIAN_MAILBOX_PROMPTS,
  ITALIAN_NUMBER_PROMPTS
} from './mailboxGrammarIt.js';
import {
  POLISH_MAILBOX_PROMPTS,
  POLISH_NUMBER_PROMPTS
} from './mailboxGrammarPl.js';
import {
  RUSSIAN_MAILBOX_PROMPTS,
  RUSSIAN_NUMBER_PROMPTS
} from './mailboxGrammarRu.js';
import {
  MAILBOX_SENTENCE_KEYS,
  mainMenuMedia,
  messageOptionsMedia,
  promptMedia
} from './mailboxPrompts.js';

/** The tone ARI's `record` plays with `beep` (`mailboxGreeting.ts`), resolved in the channel's
 * language like any other sound. */
export const BEEP_PROMPT = 'beep';

type Names = string | { readonly [key: string]: Names };

function leaves(names: Names): string[] {
  return typeof names === 'string'
    ? [names]
    : Object.values(names).flatMap(leaves);
}

const LANGUAGE_PROMPTS: Record<Language, readonly string[]> = {
  de: [...leaves(GERMAN_MAILBOX_PROMPTS), ...GERMAN_NUMBER_PROMPTS],
  en: [...leaves(ENGLISH_MAILBOX_PROMPTS), ...ENGLISH_NUMBER_PROMPTS],
  es: [...leaves(SPANISH_MAILBOX_PROMPTS), ...SPANISH_NUMBER_PROMPTS],
  fr: [...leaves(FRENCH_MAILBOX_PROMPTS), ...FRENCH_NUMBER_PROMPTS],
  it: [...leaves(ITALIAN_MAILBOX_PROMPTS), ...ITALIAN_NUMBER_PROMPTS],
  pl: [...leaves(POLISH_MAILBOX_PROMPTS), ...POLISH_NUMBER_PROMPTS],
  ru: [...leaves(RUSSIAN_MAILBOX_PROMPTS), ...RUSSIAN_NUMBER_PROMPTS]
};

const DIGIT_COUNT = 10;
const DIGITS = Array.from({ length: DIGIT_COUNT }, (_unused, digit) =>
  String(digit)
);

export function generatedPromptNames(language: Language): string[] {
  const media = [
    ...mainMenuMedia(1, 1),
    ...messageOptionsMedia(true, true),
    ...MAILBOX_SENTENCE_KEYS.map(promptMedia),
    // Each digit inside a slot's number and ending it.
    ...DIGITS.flatMap(digit => digitsMedia(`${digit}${digit}`))
  ].map(entry => entry.replace(/^sound:/u, ''));
  return [
    ...new Set([
      ...Object.values(PROMPTS),
      ...media,
      ...LANGUAGE_PROMPTS[language],
      BEEP_PROMPT
    ])
  ].sort();
}
