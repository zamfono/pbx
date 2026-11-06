/**
 * The mailbox menu's counted phrases in French (§10.2 "Mailbox access"), from the generated French
 * set (§9.1): "Vous avez un nouveau message", "deux nouveaux messages"
 * (`mailboxGrammarGenerated.ts`). "Message" is masculine, so "vingt et un" needs no other form;
 * "mille" does not change and takes no "un"; "un million" is one clip, "deux" "millions".
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

/** "Vous avez", "Vous n'avez aucun message", and the folders' noun phrases: "un nouveau message",
 * "nouveaux messages", and the same with "et"; "un message enregistré", "messages enregistrés";
 * "Nouveau message numéro". */
export const FRENCH_MAILBOX_PROMPTS = countedPrompts<Category>([
  'one',
  'other'
]);

export function frenchNumber(value: number): string[] {
  // eslint-disable-next-line no-use-before-define -- a scale's count is a number itself
  return composeNumber(value, hundredsAndRest, SCALES);
}

/** "un million" and "un milliard" one clip each, `.2` the plural after a count of two or more. */
const SCALES = [
  ...[BILLION, MILLION].map(scale => ({
    value: scale,
    said: (count: number) =>
      count === 1
        ? [`digits/${scale}`]
        : [...frenchNumber(count), `digits/${scale}.2`]
  })),
  {
    value: THOUSAND,
    said: (count: number) => [
      ...(count === 1 ? [] : frenchNumber(count)),
      `digits/${THOUSAND}`
    ]
  }
];

/** "de", between an exact number of millions and the noun. */
export const OF = 'mailbox/of';

function countClips(value: number): string[] {
  if (value === 1) {
    return [];
  }
  return [
    ...frenchNumber(value),
    ...(value >= MILLION && value % MILLION === 0 ? [OF] : [])
  ];
}

function position(value: number): string[] {
  return atSentenceEnd(frenchNumber(value));
}

export const FRENCH_NUMBER_PROMPTS = numberClips(countClips, position);

export const frenchGrammar = countedGrammar<Category>({
  prompts: FRENCH_MAILBOX_PROMPTS,
  category: value => (value === 1 ? 'one' : 'other'),
  count: countClips,
  position
});
