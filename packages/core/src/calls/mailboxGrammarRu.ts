/**
 * The mailbox menu's counted phrases in Russian (§10.2 "Mailbox access"), from the generated
 * Russian set (§9.1). "Сообщение" is neuter, and the count's last two digits pick the phrase: one
 * ("одно новое сообщение", which says its numeral itself, so 21 is "двадцать" and that phrase), few
 * ("два новых сообщения") or many ("пять новых сообщений") (`mailboxGrammarGenerated.ts`). Neuter
 * "два" sounds as the masculine, so every other count is masculine. "Тысяча" is feminine, its count
 * ending in "одна" or "две", named `<n>f`; a scale word has the same three forms, the singular,
 * `.2` for few and `.5` for many, and a lone 1 before it is left out where it starts the number.
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

type Category = 'one' | 'few' | 'many';

/** "У вас", "У вас нет сообщений", and the folders' noun phrases: "одно новое сообщение", "новых
 * сообщения", "новых сообщений", and the same with "и"; "одно сохранённое сообщение",
 * "сохранённых сообщения", "сохранённых сообщений"; "Новое сообщение номер". */
export const RUSSIAN_MAILBOX_PROMPTS = countedPrompts<Category>([
  'one',
  'few',
  'many'
]);

const TEN = 10;
const HUNDRED = 100;
const TEENS = { first: 11, last: 14 };
const FEW = { first: 2, last: 4 };
/** The last digits the feminine says differently: "одна", "две". */
const FEMININE_DIGITS = [1, FEW.first];

function category(value: number): Category {
  const lastTwo = value % HUNDRED;
  const last = value % TEN;
  if (lastTwo >= TEENS.first && lastTwo <= TEENS.last) {
    return 'many';
  }
  if (last === 1) {
    return 'one';
  }
  return last >= FEW.first && last <= FEW.last ? 'few' : 'many';
}

function belowHundred(value: number, feminine: boolean): string {
  const differs =
    feminine &&
    FEMININE_DIGITS.includes(value % TEN) &&
    !(value >= TEENS.first && value <= TEENS.last);
  return `digits/${value}${differs ? 'f' : ''}`;
}

function scaleWord(scale: number, count: number): string {
  const form = { one: '', few: '.2', many: '.5' }[category(count)];
  return `digits/${scale}${form}`;
}

/** `feminine`: the count of "тысяча". */
export function russianNumber(value: number, feminine = false): string[] {
  return composeNumber(
    value,
    below => hundredsAndRest(below, rest => belowHundred(rest, feminine)),
    // eslint-disable-next-line no-use-before-define -- a scale's count is a number itself
    SCALES
  );
}

/** A lone 1 is left out only where the scale starts the number: "тысяча", but "миллион одна
 * тысяча". */
const SCALES = [BILLION, MILLION, THOUSAND].map(scale => ({
  value: scale,
  said: (count: number, leading: boolean) => [
    ...(count === 1 && leading ? [] : russianNumber(count, scale === THOUSAND)),
    scaleWord(scale, count)
  ]
}));

/** A count before its phrase; one whose phrase is "одно …" leaves its last 1 to the phrase. */
function countClips(value: number): string[] {
  if (category(value) !== 'one') {
    return russianNumber(value);
  }
  return value === 1 ? [] : russianNumber(value - 1);
}

function position(value: number): string[] {
  return atSentenceEnd(russianNumber(value));
}

export const RUSSIAN_NUMBER_PROMPTS = numberClips(countClips, position);

export const russianGrammar = countedGrammar<Category>({
  prompts: RUSSIAN_MAILBOX_PROMPTS,
  category,
  count: countClips,
  position
});
