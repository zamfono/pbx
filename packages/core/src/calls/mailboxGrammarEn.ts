/**
 * The mailbox menu's counted phrases in English (§10.2 "Mailbox access"), from the generated
 * English set (§9.1): "You have one new message", "two new messages" (`mailboxGrammarGenerated.ts`).
 * A scale word always has its count said ("one thousand"), and does not change: "two" "million".
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

/** "You have", "You have no messages", and the folders' noun phrases: "one new message", "new
 * messages", and the same with "and"; "one saved message", "saved messages"; "New message number". */
export const ENGLISH_MAILBOX_PROMPTS = countedPrompts<Category>([
  'one',
  'other'
]);

export function englishNumber(value: number): string[] {
  // eslint-disable-next-line no-use-before-define -- a scale's count is a number itself
  return composeNumber(value, hundredsAndRest, SCALES);
}

const SCALES = [BILLION, MILLION, THOUSAND].map(scale => ({
  value: scale,
  said: (count: number) => [...englishNumber(count), `digits/${scale}`]
}));

function countClips(value: number): string[] {
  return value === 1 ? [] : englishNumber(value);
}

function position(value: number): string[] {
  return atSentenceEnd(englishNumber(value));
}

export const ENGLISH_NUMBER_PROMPTS = numberClips(countClips, position);

export const englishGrammar = countedGrammar<Category>({
  prompts: ENGLISH_MAILBOX_PROMPTS,
  category: value => (value === 1 ? 'one' : 'other'),
  count: countClips,
  position
});
