/**
 * The mailbox menu's counted phrases in Italian (§10.2 "Mailbox access"), from the generated
 * Italian set (§9.1): "Hai un nuovo messaggio", "due nuovi messaggi" (`mailboxGrammarGenerated.ts`).
 * A thousand is "mille", more are "mila" after their count ("due" "mila"); "un milione" is one
 * clip, "due" "milioni".
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

/** "Hai", "Non hai messaggi", and the folders' noun phrases: "un nuovo messaggio", "nuovi
 * messaggi", and the same with "e"; "un messaggio salvato", "messaggi salvati"; "Nuovo messaggio
 * numero". */
export const ITALIAN_MAILBOX_PROMPTS = countedPrompts<Category>([
  'one',
  'other'
]);

export function italianNumber(value: number): string[] {
  // eslint-disable-next-line no-use-before-define -- a scale's count is a number itself
  return composeNumber(value, hundredsAndRest, SCALES);
}

/** A scale's singular with its "un" (`mille`, `un milione`) one clip, `.2` the plural after a
 * count of two or more. */
const SCALES = [BILLION, MILLION, THOUSAND].map(scale => ({
  value: scale,
  said: (count: number) =>
    count === 1
      ? [`digits/${scale}`]
      : [...italianNumber(count), `digits/${scale}.2`]
}));

/** "di", between an exact number of millions and the noun. */
export const OF = 'mailbox/of';

function countClips(value: number): string[] {
  if (value === 1) {
    return [];
  }
  return [
    ...italianNumber(value),
    ...(value >= MILLION && value % MILLION === 0 ? [OF] : [])
  ];
}

function position(value: number): string[] {
  return atSentenceEnd(italianNumber(value));
}

export const ITALIAN_NUMBER_PROMPTS = numberClips(countClips, position);

export const italianGrammar = countedGrammar<Category>({
  prompts: ITALIAN_MAILBOX_PROMPTS,
  category: value => (value === 1 ? 'one' : 'other'),
  count: countClips,
  position
});
