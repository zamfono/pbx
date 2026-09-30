/**
 * Calendar and time-of-day arithmetic `reloadTiming.ts` builds its maintenance-moment
 * resolution from (§6.4 "Reload timing"): converting an instant to a timezone's wall-clock
 * date, and finding the longest closed gap of a weekly opening-hours schedule within a 7-day
 * window. It also holds `cutoffIso`, the "`days` before now" instant the daily purge's retention
 * windows compare their `_at` columns against.
 *
 * `@zamfono/core`'s `closedPeriods` (`packages/core/src/routing/schedule.ts`) computes closed
 * periods for the routing pipeline; `packages/api` does not depend on `@zamfono/core`
 * (`packages/api/package.json`), so `longestClosedGap` here implements the same calendar
 * arithmetic independently rather than importing it.
 */
import { MS_PER_DAY } from '@zamfono/shared';

export const MINUTES_PER_HOUR = 60;
export const DAYS_TO_SCAN = 7;
const ISO_WEEK_DAYS = 7;
// Two passes resolve the DST-transition case (the first guess lands on the wrong side of the
// offset change); a third pass would never change the result since the offset only takes one
// of two values around a transition.
const DST_CONVERSION_PASSES = 2;

const WEEKDAY_NUMBERS: Record<string, number | undefined> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

/** `now`, `days` earlier, as the ISO string every `_at`/`_json` column compares against. */
export function cutoffIso(now: string, days: number): string {
  return new Date(Date.parse(now) - days * MS_PER_DAY).toISOString();
}

export type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

/** The calendar date and time of day `instantMs` falls on in `timezone`. */
export function localParts(instantMs: number, timezone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    map[part.type] = part.value;
  }
  const weekday = WEEKDAY_NUMBERS[map.weekday ?? ''];
  if (weekday === undefined) {
    throw new Error(
      `reloadTiming: unrecognized weekday "${map.weekday ?? ''}"`
    );
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday,
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

/** Parses `'HH:MM'` (or `'24:00'`, end of day) into minutes since local midnight. */
export function parseTimeOfDay(value: string): number {
  const [hourPart = '0', minutePart = '0'] = value.split(':');
  return Number(hourPart) * MINUTES_PER_HOUR + Number(minutePart);
}

/** The UTC instant at which `timezone`'s wall clock reads `year`-`month`-`day` plus `minuteOfDay` minutes. */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string
): number {
  const hour = Math.floor(minuteOfDay / MINUTES_PER_HOUR);
  const minute = minuteOfDay % MINUTES_PER_HOUR;
  const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wantedAsUtc;
  for (let pass = 0; pass < DST_CONVERSION_PASSES; pass += 1) {
    const seen = localParts(guess, timezone);
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute
    );
    const drift = seenAsUtc - wantedAsUtc;
    if (drift === 0) {
      break;
    }
    guess -= drift;
  }
  return guess;
}

/** Shifts a calendar date by `offset` days, independent of any time zone. */
export function addDays(
  date: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  offset: number
): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + offset)
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

/** The ISO weekday `offset` days after `startWeekday`. */
function weekdayAt(startWeekday: number, offset: number): number {
  const index =
    (((startWeekday - 1 + offset) % ISO_WEEK_DAYS) + ISO_WEEK_DAYS) %
    ISO_WEEK_DAYS;
  return index + 1;
}

export type Interval = { weekday: number; opens: string; closes: string };
export type Range = { start: number; end: number };

/** `intervals`' open windows within `[fromMs, fromMs + 7 days)`, as merged UTC-instant ranges. */
function mergedOpenRanges(
  intervals: Interval[],
  fromMs: number,
  toMs: number,
  timezone: string
): Range[] {
  const start = localParts(fromMs, timezone);
  const ranges: Range[] = [];
  // One extra day on each side of the range so an open interval that starts before `fromMs` or
  // ends after `toMs` is still found and clipped into range.
  for (let offset = -1; offset <= DAYS_TO_SCAN; offset += 1) {
    const weekday = weekdayAt(start.weekday, offset);
    const day = addDays(start, offset);
    for (const interval of intervals) {
      if (interval.weekday !== weekday) {
        continue;
      }
      const openStart = zonedInstant(
        day.year,
        day.month,
        day.day,
        parseTimeOfDay(interval.opens),
        timezone
      );
      const openEnd = zonedInstant(
        day.year,
        day.month,
        day.day,
        parseTimeOfDay(interval.closes),
        timezone
      );
      if (openEnd <= fromMs || openStart >= toMs) {
        continue;
      }
      ranges.push({
        start: Math.max(openStart, fromMs),
        end: Math.min(openEnd, toMs)
      });
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** The longest closed gap of `intervals` within `[fromMs, fromMs + 7 days)`, or `null` when none exists. */
export function longestClosedGap(
  intervals: Interval[],
  fromMs: number,
  timezone: string
): Range | null {
  const toMs = fromMs + DAYS_TO_SCAN * MS_PER_DAY;
  const openRanges = mergedOpenRanges(intervals, fromMs, toMs, timezone);
  let longest: Range | null = null;
  let cursor = fromMs;
  const consider = (gap: Range): void => {
    if (longest === null || gap.end - gap.start > longest.end - longest.start) {
      longest = gap;
    }
  };
  for (const range of openRanges) {
    if (range.start > cursor) {
      consider({ start: cursor, end: range.start });
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < toMs) {
    consider({ start: cursor, end: toMs });
  }
  return longest;
}
