import { now as demoNow } from '#lib/clock.svelte.js';

/**
 * Calendar dates on the tenant clock (Europe/Berlin), as the call filters and statistics pass them
 * to the API: `YYYY-MM-DD`, which `calls.list` and `stats.query` read as that day's midnight, or
 * as `to` the end of that day.
 */
const ZONE = 'Europe/Berlin';
const DAY_MS = 86_400_000;

const ISO_DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** The tenant-local date `daysBack` days before today. */
export function localDate(daysBack = 0): string {
  return ISO_DATE.format(new Date(demoNow() - daysBack * DAY_MS));
}

/** The tenant-local date of instant `iso`. */
export const dateOfInstant = (iso: string): string =>
  ISO_DATE.format(new Date(iso));

/** `YYYY-MM-DDTHH:mm` of now on the tenant clock, for a `datetime-local` input. */
export function localDateTime(ms = demoNow()): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(ms));
  return parts.replace(' ', 'T');
}

export type DateRange = 'today' | 'yesterday' | 'week' | 'month' | 'all';

/** The `from`/`to` of a preset range, as dates. */
export function rangeInput(range: DateRange): { from?: string; to?: string } {
  switch (range) {
    case 'today':
      return { from: localDate(0), to: localDate(0) };
    case 'yesterday':
      return { from: localDate(1), to: localDate(1) };
    case 'week':
      return { from: localDate(6), to: localDate(0) };
    case 'month':
      return { from: localDate(29), to: localDate(0) };
    case 'all':
      return {};
  }
}
