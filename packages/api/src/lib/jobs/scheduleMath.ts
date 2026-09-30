/**
 * What `reloadTiming.ts` builds its maintenance-moment resolution on (§6.4 "Reload timing") beyond
 * `@zamfono/shared`'s wall-clock arithmetic: the longest closed gap of a weekly opening-hours
 * schedule within a 7-day window, derived from the `closedPeriods` core's sweep uses too. It also
 * holds `cutoffIso`, the "`days` before now" instant the daily purge's retention windows compare
 * their `_at` columns against.
 */
import {
  closedPeriods,
  MS_PER_DAY,
  type OpeningInterval
} from '@zamfono/shared';

export const DAYS_TO_SCAN = 7;

/** `now`, `days` earlier, as the ISO string every `_at`/`_json` column compares against. */
export function cutoffIso(now: string, days: number): string {
  return new Date(Date.parse(now) - days * MS_PER_DAY).toISOString();
}

export type Range = { start: number; end: number };

/** The longest closed gap of `intervals` within `[fromMs, fromMs + 7 days)`, or `null` when none exists. */
export function longestClosedGap(
  intervals: OpeningInterval[],
  fromMs: number,
  timezone: string
): Range | null {
  const periods = closedPeriods(
    { intervals },
    new Date(fromMs).toISOString(),
    DAYS_TO_SCAN,
    timezone
  );
  let longest: Range | null = null;
  for (const period of periods) {
    const gap = {
      start: Date.parse(period.start),
      end: Date.parse(period.end)
    };
    if (longest === null || gap.end - gap.start > longest.end - longest.start) {
      longest = gap;
    }
  }
  return longest;
}
