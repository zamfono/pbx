/**
 * Localized weekday and month names for the schedule components, following `i18n.locale`.
 */
import { i18n } from '#lib/i18n/index.svelte.js';

import type { Weekday } from './hours';

const intlLocale = (): string => (i18n.locale === 'de' ? 'de-DE' : 'en-GB');

/** 1 January 2024 was a Monday, so day `weekday` of that month is that weekday. */
const referenceDay = (weekday: number): Date =>
  new Date(Date.UTC(2024, 0, weekday));

/** `Montag`/`Monday`, or with `short` the abbreviation without a trailing dot: `Mo`/`Mon`. */
export const weekdayName = (
  weekday: Weekday | number,
  style: 'long' | 'short' = 'long'
): string =>
  new Intl.DateTimeFormat(intlLocale(), { weekday: style, timeZone: 'UTC' })
    .format(referenceDay(weekday))
    .replace(/\.$/u, '');

/** `Nov.`/`Nov`, with the year when the month is January: `Jan. 2027`. */
export const monthLabel = (time: number): string => {
  const date = new Date(time);
  return new Intl.DateTimeFormat(intlLocale(), {
    month: 'short',
    ...(date.getMonth() === 0 ? { year: 'numeric' } : {})
  }).format(date);
};
