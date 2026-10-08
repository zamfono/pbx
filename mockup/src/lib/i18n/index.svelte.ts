import { now as demoNow } from '#lib/clock.svelte.js';

/**
 * German and English UI text. Each area keeps its messages in `messages/<area>.ts`, exporting
 * `{ de, en }` with the same keys, every key prefixed `<area>.`; this module merges them. `t`
 * fills `{name}` placeholders. A missing key renders as the key itself, and a test checks that
 * both languages define the same keys.
 */

export type Locale = 'de' | 'en';
export type MessageTable = Record<string, string>;
export type Messages = { de: MessageTable; en: MessageTable };

const modules = import.meta.glob<{ default: Messages }>('./messages/*.ts', {
  eager: true
});

export const dictionaries: Messages = { de: {}, en: {} };
for (const module of Object.values(modules)) {
  Object.assign(dictionaries.de, module.default.de);
  Object.assign(dictionaries.en, module.default.en);
}

export const i18n = $state<{ locale: Locale }>({ locale: 'de' });

export function t(
  key: string,
  params: Record<string, string | number | null | undefined> = {}
): string {
  const template =
    dictionaries[i18n.locale][key] ?? dictionaries.en[key] ?? key;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Whether a key exists, for optional help texts. */
export const has = (key: string): boolean => key in dictionaries[i18n.locale];

const intlLocale = (): string => (i18n.locale === 'de' ? 'de-DE' : 'en-GB');
const TIME_ZONE = 'Europe/Berlin';

export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return '—';
  }
  return new Intl.DateTimeFormat(intlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TIME_ZONE
  }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return '—';
  }
  return new Intl.DateTimeFormat(intlLocale(), {
    dateStyle: 'medium',
    timeZone: TIME_ZONE
  }).format(new Date(iso));
}

export function formatTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return '—';
  }
  return new Intl.DateTimeFormat(intlLocale(), {
    timeStyle: 'short',
    timeZone: TIME_ZONE
  }).format(new Date(iso));
}

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** "vor 5 Min." / "5 min ago", for recent instants; older ones as a date. */
export function formatRelative(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return '—';
  }
  const seconds = Math.round((new Date(iso).getTime() - demoNow()) / SECOND);
  const format = new Intl.RelativeTimeFormat(intlLocale(), {
    numeric: 'auto',
    style: 'short'
  });
  const absolute = Math.abs(seconds);
  if (absolute < MINUTE) {
    return format.format(seconds, 'second');
  }
  if (absolute < HOUR) {
    return format.format(Math.round(seconds / MINUTE), 'minute');
  }
  if (absolute < DAY) {
    return format.format(Math.round(seconds / HOUR), 'hour');
  }
  if (absolute < 7 * DAY) {
    return format.format(Math.round(seconds / DAY), 'day');
  }
  return formatDate(iso);
}

/** Seconds as `m:ss` or `h:mm:ss`. */
export function formatDuration(
  totalSeconds: number | null | undefined
): string {
  if (totalSeconds === null || totalSeconds === undefined) {
    return '—';
  }
  const hours = Math.floor(totalSeconds / HOUR);
  const minutes = Math.floor((totalSeconds % HOUR) / MINUTE);
  const seconds = Math.floor(totalSeconds % MINUTE);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** A timeout in seconds as people say it: "25 s", "5 min", "1 h", "7 d". */
export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (value % DAY === 0) {
    return `${value / DAY} ${i18n.locale === 'de' ? 'T' : 'd'}`;
  }
  if (value % HOUR === 0) {
    return `${value / HOUR} h`;
  }
  if (value % MINUTE === 0 && value >= MINUTE) {
    return `${value / MINUTE} min`;
  }
  return `${value} s`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(intlLocale()).format(value);
}

const KIB = 1024;
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB;
    unit += 1;
  }
  return `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

/** German area codes of two and four digits the demo meets; others are taken as three digits
 * (mobile prefixes 15x–17x are three digits too). */
const DE_AREA_2 = new Set(['30', '40', '69', '89']);
const DE_AREA_4 = new Set(['8131', '8141', '8161', '8106', '8092']);

/** An E.164 number grouped for reading: +49 89 4520 115, +49 171 5550123. Other countries and
 * non-numeric numbers stay verbatim. */
export function formatPhone(number: string | null | undefined): string {
  if (number === null || number === undefined) {
    return '—';
  }
  const german = /^\+49(\d+)$/u.exec(number);
  if (german === null) {
    return number;
  }
  const digits = german[1] ?? '';
  const areaLength = DE_AREA_2.has(digits.slice(0, 2))
    ? 2
    : DE_AREA_4.has(digits.slice(0, 4))
      ? 4
      : 3;
  const area = digits.slice(0, areaLength);
  const rest = digits.slice(areaLength);
  const mobile = /^1[5-7]/u.test(area);
  const grouped =
    !mobile && rest.length >= 7 ? `${rest.slice(0, 4)} ${rest.slice(4)}` : rest;
  return `+49 ${area} ${grouped}`.trim();
}
