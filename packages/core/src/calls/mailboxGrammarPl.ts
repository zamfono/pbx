/**
 * The mailbox menu's counted phrases in Polish (§10.2 "Mailbox access"), from the generated Polish
 * set (§9.1). "Wiadomość" is feminine and the intro takes the accusative: "Masz jedną nową
 * wiadomość", "dwie nowe wiadomości", "pięć nowych wiadomości", each form one clip
 * (`mailboxGrammarGenerated.ts`).
 *
 * The core reads the numbers itself rather than through ARI's `number:`, which has no gender,
 * joins every number below 100 from its tens and its unit, and whose Polish reading takes 112 for
 * "few" ("sto dwanaście tysiące"). Every number from 0 to 99 is one clip of its own, so only a
 * hundred or a scale word is joined to it; the masculine is named as Asterisk's Polish number
 * reading names it (`say.c`'s `ast_say_number_full_pl`), so `number:` and `digits:` find those
 * clips as well, and the feminine of a number ending in 2 ("dwadzieścia dwie") adds a `z`, as
 * `say.c`'s own "dwie" (`2z`) does.
 */
import {
  atSentenceEnd,
  countedGrammar,
  countedPrompts,
  finalForm
} from './mailboxGrammarGenerated.js';

type Category = 'one' | 'few' | 'many';

/** "Masz", "Nie masz żadnych wiadomości", and the folders' noun phrases: "jedną nową wiadomość",
 * "nowe wiadomości", "nowych wiadomości", and the same with "i"; "jedną zapisaną wiadomość",
 * "zapisane wiadomości", "zapisanych wiadomości"; "Nowa wiadomość numer". */
export const POLISH_MAILBOX_PROMPTS = countedPrompts<Category>([
  'one',
  'few',
  'many'
]);

const TEN = 10;
const HUNDRED = 100;
const THOUSAND = 1000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;
/** The last digit a feminine count says as "dwie" rather than "dwa". */
const FEMININE_TWO = 2;
const FEW_DIGITS = { first: 2, last: 4 };
const TEENS = { first: 12, last: 14 };

/** Polish "few": a last digit of 2 to 4, but not 12 to 14 ("dwadzieścia dwie", "dwanaście"). */
function isFew(value: number): boolean {
  const last = value % TEN;
  const lastTwo = value % HUNDRED;
  return (
    last >= FEW_DIGITS.first &&
    last <= FEW_DIGITS.last &&
    !(lastTwo >= TEENS.first && lastTwo <= TEENS.last)
  );
}

function category(value: number): Category {
  if (value === 1) {
    return 'one';
  }
  return isFew(value) ? 'few' : 'many';
}

/** The scale words, largest first, as `say.c` names them: the singular, then `.2` for "few"
 * (tysiące) and `.5` for "many" (tysięcy). */
const SCALES = [BILLION, MILLION, THOUSAND];

function scaleWord(scale: number, count: number): string {
  if (count === 1) {
    return `digits/${scale}`;
  }
  return `digits/${scale}.${isFew(count) ? '2' : '5'}`;
}

/** 0 to 99 as one clip; the feminine of one ending in 2, but not 12, is "dwie". */
function belowHundred(value: number, feminine: boolean): string {
  const dwie =
    feminine && value % TEN === FEMININE_TWO && value !== TEENS.first;
  return `digits/${value}${dwie ? 'z' : ''}`;
}

/** 1 to 999: the hundreds, then the rest as one clip. */
function belowThousand(value: number, feminine: boolean): string[] {
  const hundreds = value - (value % HUNDRED);
  const rest = value % HUNDRED;
  return [
    ...(hundreds > 0 ? [`digits/${hundreds}`] : []),
    ...(rest > 0 ? [belowHundred(rest, feminine)] : [])
  ];
}

/** The clip names that say `value`; a scale's own count is said in the masculine ("dwa tysiące"),
 * and a lone 1 before a scale is left out ("tysiąc"). */
export function polishNumber(value: number, feminine: boolean): string[] {
  if (value === 0) {
    return ['digits/0'];
  }
  for (const scale of SCALES) {
    if (value >= scale) {
      const count = Math.floor(value / scale);
      const rest = value % scale;
      return [
        ...(count === 1 ? [] : polishNumber(count, false)),
        scaleWord(scale, count),
        ...(rest > 0 ? polishNumber(rest, feminine) : [])
      ];
    }
  }
  return belowThousand(value, feminine);
}

/** The same number ending a sentence, in the masculine (`atSentenceEnd`). */
export function polishNumberAtEnd(value: number): string[] {
  return atSentenceEnd(polishNumber(value, false));
}

const BELOW_HUNDRED = Array.from(
  { length: HUNDRED },
  (_unused, value) => value
);

/** The masculine clips: 0 to 99, the hundreds, and the scale words in their three forms; any of
 * them can end a number. */
const MASCULINE = [
  ...BELOW_HUNDRED.map(value => belowHundred(value, false)),
  ...BELOW_HUNDRED.filter(value => value > 0 && value < TEN).map(
    digit => `digits/${digit * HUNDRED}`
  ),
  ...SCALES.flatMap(scale => [
    `digits/${scale}`,
    `digits/${scale}.2`,
    `digits/${scale}.5`
  ])
];

/** Every clip `polishNumber` and `polishNumberAtEnd` can name: the masculine ones, the feminine
 * where it differs, and each masculine one's end-of-sentence form. */
export const POLISH_NUMBER_PROMPTS: readonly string[] = [
  ...new Set([
    ...MASCULINE,
    ...BELOW_HUNDRED.map(value => belowHundred(value, true))
  ]),
  ...MASCULINE.map(finalForm)
];

/** "Masz dwie nowe wiadomości i pięć zapisanych wiadomości", or "Nie masz żadnych wiadomości";
 * "Nowa wiadomość numer dwa", the number ending the sentence before the message plays. */
export const polishGrammar = countedGrammar({
  prompts: POLISH_MAILBOX_PROMPTS,
  category,
  count: value => (value === 1 ? [] : polishNumber(value, true)),
  position: polishNumberAtEnd
});
