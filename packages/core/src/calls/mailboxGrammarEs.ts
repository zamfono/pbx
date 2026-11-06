/**
 * The mailbox menu's counted phrases in Spanish (§10.2 "Mailbox access"), from the generated
 * Spanish set (§9.1): "Tienes un mensaje nuevo", "dos mensajes nuevos"
 * (`mailboxGrammarGenerated.ts`). Before the masculine "mensajes" and before a scale word, a number
 * ending in 1 (not 11) is shortened, "veintiún", "treinta y un", "ciento un", named `<n>un`; at the
 * end of a sentence it is not ("número veintiuno"). A hundred is "cien" alone and "ciento" before
 * more. Spanish has no word for a thousand millions, "mil millones", so a million's count may run
 * past a thousand ("dos mil quinientos millones"); "un millón" is one clip, "dos" "millones".
 */
import {
  atSentenceEnd,
  composeNumber,
  countedGrammar,
  countedPrompts,
  hundredsAndRest,
  MILLION,
  numberClips,
  THOUSAND
} from './mailboxGrammarGenerated.js';

type Category = 'one' | 'other';

/** "Tienes", "No tienes mensajes", and the folders' noun phrases: "un mensaje nuevo", "mensajes
 * nuevos", and the same with "y"; "un mensaje guardado", "mensajes guardados"; "Mensaje nuevo
 * número". */
export const SPANISH_MAILBOX_PROMPTS = countedPrompts<Category>([
  'one',
  'other'
]);

const TEN = 10;
const ELEVEN = 11;
const HUNDRED = 100;
/** A hundred followed by more. */
export const CIENTO = 'digits/ciento';

function belowHundred(value: number, shortened: boolean): string {
  const un = shortened && value % TEN === 1 && value !== ELEVEN;
  return `digits/${value}${un ? 'un' : ''}`;
}

function belowThousand(value: number, shortened: boolean): string[] {
  return hundredsAndRest(
    value,
    rest => belowHundred(rest, shortened),
    (hundred, rest) =>
      hundred === HUNDRED && rest > 0 ? CIENTO : `digits/${hundred}`
  );
}

/** `shortened`: before a noun, a number ending in 1 takes its short form. */
export function spanishNumber(value: number, shortened: boolean): string[] {
  // eslint-disable-next-line no-use-before-define -- a scale's count is a number itself
  return composeNumber(value, rest => belowThousand(rest, shortened), SCALES);
}

const SCALES = [
  {
    value: MILLION,
    said: (count: number) =>
      count === 1
        ? [`digits/${MILLION}`]
        : [...spanishNumber(count, true), `digits/${MILLION}.2`]
  },
  {
    value: THOUSAND,
    said: (count: number) => [
      ...(count === 1 ? [] : spanishNumber(count, true)),
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
    ...spanishNumber(value, true),
    ...(value >= MILLION && value % MILLION === 0 ? [OF] : [])
  ];
}

function position(value: number): string[] {
  return atSentenceEnd(spanishNumber(value, false));
}

export const SPANISH_NUMBER_PROMPTS = numberClips(countClips, position);

export const spanishGrammar = countedGrammar<Category>({
  prompts: SPANISH_MAILBOX_PROMPTS,
  category: value => (value === 1 ? 'one' : 'other'),
  count: countClips,
  position
});
