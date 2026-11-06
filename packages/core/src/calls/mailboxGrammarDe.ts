/**
 * The mailbox menu's counted phrases in German (§10.2 "Mailbox access"), from the generated German
 * set (§9.1): "Sie haben eine neue Nachricht", "zwei neue Nachrichten" (`mailboxGrammarGenerated.ts`).
 * A single message's "eine" its phrase says itself; a number ending in a lone 1 says it as "eine"
 * before the feminine "Nachrichten", "Million" or "Milliarde" ("hundert" "eine" "neue Nachrichten")
 * and "ein" before "tausend", where a number ending a sentence says "eins". Every other number has
 * no gender: "hundert" "zwölf", "zwei" "tausend", "eine Million", "zwei" "Millionen".
 */
import {
  atSentenceEnd,
  BILLION,
  composeNumber,
  countedGrammar,
  countedPrompts,
  hundredsAndRest,
  MILLION,
  numberClips,
  THOUSAND
} from './mailboxGrammarGenerated.js';

type Category = 'one' | 'other';

/** "Sie haben", "Sie haben keine Nachrichten", and the folders' noun phrases: "eine neue
 * Nachricht", "neue Nachrichten", and the same with "und"; "eine gespeicherte Nachricht",
 * "gespeicherte Nachrichten"; "Neue Nachricht Nummer". */
export const GERMAN_MAILBOX_PROMPTS = countedPrompts<Category>([
  'one',
  'other'
]);

/** A lone 1 ending a count: before a feminine noun, and before "tausend". */
export const EINE = 'digits/eine';
export const EIN = 'digits/ein';

/** `one`: how a lone 1 at the end is said, "eins" unless a noun or a scale follows. */
export function germanNumber(value: number, one = 'digits/1'): string[] {
  return composeNumber(
    value,
    below =>
      hundredsAndRest(below, rest => (rest === 1 ? one : `digits/${rest}`)),
    // eslint-disable-next-line no-use-before-define -- a scale's count is a number itself
    SCALES
  );
}

/** "tausend" has one form, a lone 1 before it left out; a million and a billion are nouns, "eine
 * Million" one clip, `.2` their plural after a count of two or more. */
const SCALES = [
  ...[BILLION, MILLION].map(scale => ({
    value: scale,
    said: (count: number) =>
      count === 1
        ? [`digits/${scale}`]
        : [...germanNumber(count, EINE), `digits/${scale}.2`]
  })),
  {
    value: THOUSAND,
    said: (count: number) => [
      ...(count === 1 ? [] : germanNumber(count, EIN)),
      `digits/${THOUSAND}`
    ]
  }
];

function countClips(value: number): string[] {
  return value === 1 ? [] : germanNumber(value, EINE);
}

function position(value: number): string[] {
  return atSentenceEnd(germanNumber(value));
}

export const GERMAN_NUMBER_PROMPTS = numberClips(countClips, position);

/** "Sie haben zwei neue Nachrichten und eine gespeicherte Nachricht", or "Sie haben keine
 * Nachrichten"; "Neue Nachricht Nummer zwei", the number ending the sentence. */
export const germanGrammar = countedGrammar<Category>({
  prompts: GERMAN_MAILBOX_PROMPTS,
  category: value => (value === 1 ? 'one' : 'other'),
  count: countClips,
  position
});
