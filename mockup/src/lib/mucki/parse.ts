/**
 * What Mucki reads out of free text, in German and English: a new employee's details, pasted rows,
 * phone numbers, host names, durations and yes/no answers.
 */

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
const EXTENSION =
  /(?:durchwahl|nebenstelle|extension|ext\.?|dw\.?|nst\.?)\s*:?\s*(\d{2,6})\b/iu;

const NAME_STOPWORDS = new Set([
  'leg',
  'lege',
  'legen',
  'neue',
  'neuen',
  'neuer',
  'neu',
  'mitarbeiterin',
  'mitarbeiter',
  'kollegin',
  'kollege',
  'kollegen',
  'durchwahl',
  'app',
  'add',
  'create',
  'bitte',
  'please',
  'mit',
  'with',
  'extension',
  'benutzer',
  'benutzerin',
  'user',
  'ringotel',
  'an',
  'für',
  'ein',
  'eine',
  'einen',
  'employee',
  'new',
  'richte',
  'set',
  'up',
  'onboard',
  'onboarde',
  'nebenstelle',
  'e-mail',
  'email',
  'mail',
  'und',
  'and',
  'the',
  'der',
  'die',
  'das',
  'als',
  'hallo',
  'hi',
  'hey',
  'mucki'
]);

export type Onboarding = {
  name: string | null;
  email: string | null;
  extension: string | null;
  app: boolean;
};

const capitalise = (word: string): string =>
  word === '' ? word : word[0]!.toUpperCase() + word.slice(1);

function nameFromEmail(email: string): string | null {
  const local = email.split('@')[0] ?? '';
  const parts = local
    .split(/[._-]+/u)
    .filter(part => /^[a-zäöüß]+$/iu.test(part));
  return parts.length >= 2 ? parts.map(capitalise).join(' ') : null;
}

function nameFromText(text: string): string | null {
  const words = text
    .replace(EMAIL, ' ')
    .split(/[\s,;:()]+/u)
    .map(word => word.replace(/[.!?]+$/u, ''));
  let best: string[] = [];
  let run: string[] = [];
  for (const word of words) {
    const isName =
      /^[A-ZÄÖÜ][a-zäöüßéèáàčćšž'-]+$/u.test(word) &&
      !NAME_STOPWORDS.has(word.toLowerCase());
    if (isName) {
      run.push(word);
      if (run.length > best.length) {
        best = [...run];
      }
    } else {
      run = [];
    }
  }
  return best.length >= 2 ? best.slice(0, 3).join(' ') : null;
}

export function parseOnboarding(text: string): Onboarding {
  const email = EMAIL.exec(text)?.[0] ?? null;
  const withoutEmail = email === null ? text : text.replace(email, ' ');
  const extension =
    EXTENSION.exec(withoutEmail)?.[1] ??
    /(?:^|[\s,;])(\d{3})(?=$|[\s,;.])/u.exec(withoutEmail)?.[1] ??
    null;
  const name =
    nameFromText(text) ?? (email === null ? null : nameFromEmail(email));
  const app = /\b(app|ringotel|softphone|handy-?app)\b/iu.test(text);
  return { name, email, extension, app };
}

export type Row = {
  name: string;
  email: string;
  extension: string | null;
  line: string;
};

/** Rows of `name; e-mail; extension` (also tab- or comma-separated); header and blank lines skipped. */
export function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const cells = line
      .split(/\s*[;\t|]\s*|\s*,\s*/u)
      .filter(cell => cell !== '');
    const email = cells.find(cell => EMAIL.test(cell));
    if (cells.length < 2 || email === undefined) {
      continue;
    }
    const name = cells.find(cell => cell !== email && !/^\d+$/u.test(cell));
    const extension = cells.find(cell => /^\d{2,6}$/u.test(cell)) ?? null;
    if (name === undefined) {
      continue;
    }
    rows.push({
      name,
      email: EMAIL.exec(email)?.[0] ?? email,
      extension,
      line
    });
  }
  return rows;
}

/** The first phone number in `text` as E.164 (German national numbers get +49), or null. */
export function parsePhone(text: string): string | null {
  const match = /(?:\+|00)?\d[\d\s/().-]{6,}\d/u.exec(text);
  if (match === null) {
    return null;
  }
  const raw = match[0];
  const digits = raw.replace(/[^\d]/gu, '');
  if (raw.startsWith('+')) {
    return `+${digits}`;
  }
  if (raw.startsWith('00')) {
    return `+${digits.slice(2)}`;
  }
  if (digits.startsWith('0')) {
    return `+49${digits.slice(1)}`;
  }
  return null;
}

/** The first host name or IPv4 address in `text` that is not part of an e-mail address. */
export function parseHost(text: string): string | null {
  const cleaned = text.replace(new RegExp(EMAIL.source, 'gu'), ' ');
  const ip = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u.exec(cleaned);
  if (ip !== null) {
    return ip[0];
  }
  const host = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/iu.exec(
    cleaned
  );
  return host === null ? null : host[0].toLowerCase();
}

/** Seconds named in `text` ("20 Sekunden", "after 20 s"), or null. */
export function parseSeconds(text: string): number | null {
  const match = /(\d{1,3})\s*(?:s\b|sek|sec|seconds?|sekunden)/iu.exec(text);
  return match === null ? null : Number(match[1]);
}

export const isYes = (text: string): boolean =>
  /^\s*(ja|jo|jep|yes|yep|yeah|ok(ay)?|gern(e)?|klar|sure|bitte|please|mach|do it|los|go)\b/iu.test(
    text
  );

export const isNo = (text: string): boolean =>
  /^\s*(nein|nee|no|nope|lieber nicht|abbrechen|cancel|stop|später|later|nicht)\b/iu.test(
    text
  );
