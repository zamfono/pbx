/**
 * Every prompt the core can play in a generated language (§9.1), the set
 * `images/asterisk/prompts/<language>/` has to hold in full: the fixed prompts, the mailbox menu
 * as the generated composition plays it, the language's counted phrases and number clips, the
 * digits a parking slot is read with, and the tone a recorded greeting starts on. The unit test checks the
 * committed set against it and `test/integration/prompts.sh` the image.
 */
import { digitsMedia, PROMPTS, type GeneratedLanguage } from '../prompts.js';
import {
  POLISH_MAILBOX_PROMPTS,
  POLISH_NUMBER_PROMPTS
} from './mailboxGrammarPl.js';
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

const LANGUAGE_PROMPTS: Record<GeneratedLanguage, readonly string[]> = {
  pl: [...leaves(POLISH_MAILBOX_PROMPTS), ...POLISH_NUMBER_PROMPTS]
};

const DIGIT_COUNT = 10;
const DIGITS = Array.from({ length: DIGIT_COUNT }, (_unused, digit) =>
  String(digit)
);

export function generatedPromptNames(language: GeneratedLanguage): string[] {
  const media = [
    ...mainMenuMedia(language, 1, 1),
    ...messageOptionsMedia(true, true),
    ...MAILBOX_SENTENCE_KEYS.map(promptMedia),
    // Each digit inside a slot's number and ending it.
    ...DIGITS.flatMap(digit => digitsMedia(language, `${digit}${digit}`))
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
