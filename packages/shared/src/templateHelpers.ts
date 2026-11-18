/**
 * What a template computes with (§9.4 "Templates"): the helpers, a fixed set, and how a
 * mustache's output is escaped for the field its template is. `templates.ts` registers both.
 */

/** A value as a helper reads it and a mustache writes it: text as it is, a number or boolean as
 * its text, anything else (a missing value, an object, a list) empty. */
export function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

/** A helper's index argument: an integer, else none. */
function index(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number)
    ? number
    : undefined;
}

/** `value`'s characters, as code points: what `slice` and `length` count. */
function characters(value: unknown): string[] {
  return Array.from(text(value));
}

const NOT_A_DIGIT = /[^0-9]/gu;

/**
 * The helpers (§9.4 "Templates"), each taking as many arguments as its function names, the last
 * `optional` of them optional. No regular expressions and no arithmetic: a template derives text
 * from text.
 */
export const HELPERS: Record<
  string,
  { run: (...args: unknown[]) => string; optional?: 1 }
> = {
  /** `slice value start end?`: `String.prototype.slice`'s reading, `end` exclusive, a negative
   * index counting from the end. */
  slice: {
    run: (value, start, end) =>
      characters(value)
        .slice(index(start) ?? 0, index(end))
        .join(''),
    optional: 1
  },
  /** `length value`: the number of characters. */
  length: { run: value => String(characters(value).length) },
  /** `replace value from to`: every occurrence of the literal text `from`. */
  replace: {
    run: (value, from, to) =>
      text(from) === ''
        ? text(value)
        : text(value).replaceAll(text(from), () => text(to))
  },
  /** `stripPrefix value prefix`: the value without the prefix it starts with, else unchanged. */
  stripPrefix: {
    run: (value, prefix) =>
      text(prefix) !== '' && text(value).startsWith(text(prefix))
        ? text(value).slice(text(prefix).length)
        : text(value)
  },
  /** `digits value`: only its digits. */
  digits: { run: value => text(value).replaceAll(NOT_A_DIGIT, '') }
};

/** The fewest and the most arguments the helper `name` takes. */
export function helperArity(name: string): [number, number] {
  const helper = HELPERS[name];
  const most = helper?.run.length ?? 0;
  return [most - (helper?.optional ?? 0), most];
}

// CR, LF, tab and the rest of C0, DEL and C1: nothing that could end a header or a line.
const CONTROL = /\p{Cc}/gu;
// RFC 3261's `user`, the subset §9.4 "SIP targets" allows unescaped; the rest is %-escaped.
const SIP_USER_UNESCAPED = /[A-Za-z0-9._~+-]/u;
const HEX = 16;
const HEX_DIGITS_PER_BYTE = 2;
const utf8 = new TextEncoder();

/** `value` with every byte of a character outside RFC 3261's unescaped set as `%XX`. */
function escapeSipUser(value: string): string {
  return Array.from(value, char =>
    SIP_USER_UNESCAPED.test(char)
      ? char
      : Array.from(
          utf8.encode(char),
          byte =>
            `%${byte.toString(HEX).toUpperCase().padStart(HEX_DIGITS_PER_BYTE, '0')}`
        ).join('')
  ).join('');
}

/**
 * How a mustache's output is escaped, by the field its template is (§9.4 "Templates"), so that a
 * substituted value never adds syntax of its own:
 * - `line`: control characters stripped, for a SIP or HTTP header and a `text/plain` body;
 * - `json`: JSON string escaping, for a value inside a string of an `application/json` body;
 * - `form`: form URL encoding, for `application/x-www-form-urlencoded`;
 * - `url`: URL-component escaping;
 * - `sipUser`: RFC 3261 user-part escaping;
 * - `plain`: as it is, for a value that is compared or checked whole and sent nowhere.
 */
export const ESCAPES = {
  line: (value: string) => value.replaceAll(CONTROL, ''),
  json: (value: string) => JSON.stringify(value).slice(1, -1),
  // A pair with an empty name serializes as `=<value>`.
  form: (value: string) =>
    new URLSearchParams([['', value]]).toString().slice(1),
  url: (value: string) => encodeURIComponent(value),
  sipUser: escapeSipUser,
  plain: (value: string) => value
} as const;
export type TemplateContext = keyof typeof ESCAPES;
