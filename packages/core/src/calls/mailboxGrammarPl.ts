/**
 * The mailbox menu's counted phrases in Polish (§10.2 "Mailbox access"), from the generated Polish
 * set (§9.1). "Wiadomość" is feminine and the intro takes the accusative: "Masz jedną nową
 * wiadomość", "dwie nowe wiadomości", "pięć nowych wiadomości". An adjective and its noun are
 * always said together, so each form is one clip, the new-message one also with the "i" (and)
 * that follows it before the old messages, cut from a sentence that goes on.
 *
 * The core reads the numbers itself rather than through ARI's `number:`, which has no gender,
 * joins every number below 100 from its tens and its unit, and whose Polish reading takes 112 for
 * "few" ("sto dwanaście tysiące"). Every number from 0 to 99 is one clip of its own, so only a
 * hundred or a scale word is joined to it; the masculine is named as Asterisk's Polish number
 * reading names it (`say.c`'s `ast_say_number_full_pl`), so `number:` and `digits:` find those
 * clips as well, and the feminine of a number ending in 2 ("dwadzieścia dwie") adds a `z`, as
 * `say.c`'s own "dwie" (`2z`) does.
 */
import { FINAL_DIGITS_DIR } from '../prompts.js';
import { sound, type Folder } from './mailboxPrompts.js';

export const POLISH_MAILBOX_PROMPTS = {
  /** "Masz", before the counts. */
  youHave: 'mailbox/you-have',
  /** "Nie masz żadnych wiadomości." */
  none: 'mailbox/none',
  /** The new messages' count noun phrase ending the sentence: "jedną nową wiadomość", "nowe
   * wiadomości", "nowych wiadomości". */
  newLast: {
    one: 'mailbox/new-one',
    few: 'mailbox/new-few',
    many: 'mailbox/new-many'
  },
  /** The same, followed by "i" before the old messages. */
  newAnd: {
    one: 'mailbox/new-one-and',
    few: 'mailbox/new-few-and',
    many: 'mailbox/new-many-and'
  },
  /** The old messages', always last: "jedną zapisaną wiadomość", "zapisane wiadomości",
   * "zapisanych wiadomości". */
  oldLast: {
    one: 'mailbox/old-one',
    few: 'mailbox/old-few',
    many: 'mailbox/old-many'
  },
  /** "Nowa wiadomość numer", "Zapisana wiadomość numer", before a message's place in its folder. */
  header: { new: 'mailbox/header-new', old: 'mailbox/header-old' }
} as const;

type Category = 'one' | 'few' | 'many';

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

function atEnd(name: string): string {
  return name.replace(/^digits\//u, `${FINAL_DIGITS_DIR}/`);
}

/** The same number ending a sentence, in the masculine: its last clip in the falling form that
 * ends one (`FINAL_DIGITS_DIR`), where a count's rises into the noun after it. */
export function polishNumberAtEnd(value: number): string[] {
  const names = polishNumber(value, false);
  return names.map((name, index) =>
    index === names.length - 1 ? atEnd(name) : name
  );
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
  ...MASCULINE.map(atEnd)
];

const PROMPTS_PL = POLISH_MAILBOX_PROMPTS;

/** One folder's count: "jedną nową wiadomość", or the number and the noun phrase. */
function folderPart(
  folder: Folder,
  count: number,
  beforeAnd: boolean
): string[] {
  const newForms = beforeAnd ? PROMPTS_PL.newAnd : PROMPTS_PL.newLast;
  const forms = folder === 'old' ? PROMPTS_PL.oldLast : newForms;
  const phrase = sound(forms[category(count)]);
  if (count === 1) {
    return [phrase];
  }
  return [...polishNumber(count, true).map(sound), phrase];
}

/** "Masz dwie nowe wiadomości i pięć zapisanych wiadomości": the folders that hold messages, or
 * "Nie masz żadnych wiadomości". */
export function introPl(newCount: number, oldCount: number): string[] {
  if (newCount === 0 && oldCount === 0) {
    return [sound(PROMPTS_PL.none)];
  }
  return [
    sound(PROMPTS_PL.youHave),
    ...(newCount > 0 ? folderPart('new', newCount, oldCount > 0) : []),
    ...(oldCount > 0 ? folderPart('old', oldCount, false) : [])
  ];
}

/** "Nowa wiadomość numer dwa", the number ending the sentence before the message plays. */
export function headerPl(folder: Folder, position: number): string[] {
  return [
    sound(PROMPTS_PL.header[folder]),
    ...polishNumberAtEnd(position).map(sound)
  ];
}
