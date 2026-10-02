/**
 * Wall-clock arithmetic in an IANA time zone, for core's opening-hours evaluation
 * (`packages/core/src/routing/schedule.ts`) and api's maintenance-moment resolution
 * (`packages/api/src/lib/jobs/reloadTiming.ts`, §6.4 "Reload timing") and the time filters of
 * api's reads (§10.3): reading the local date, weekday and time of an instant, converting a
 * local date and time back to an instant (the earlier one where a DST change skips or repeats
 * it), and calendar-day and weekday shifts. Every computation
 * goes through `Intl` rather than a date library.
 */
import { MS_PER_DAY } from './time.js';

/** ISO 8601 weekday: 1 = Monday … 7 = Sunday. */
// eslint-disable-next-line no-magic-numbers -- the seven ISO weekday literals of the type itself
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const MINUTES_PER_HOUR = 60;
const ISO_WEEK_DAYS = 7;
const MS_PER_MINUTE = 60_000;

const WEEKDAY_NUMBERS: Record<string, Weekday> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

export type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  weekday: Weekday;
  hour: number;
  minute: number;
};

/** The calendar date and time of day `instant` falls on in `timeZone`. */
export function localParts(instant: number, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    map[part.type] = part.value;
  }
  const weekdayName = map.weekday;
  const weekday =
    weekdayName === undefined ? undefined : WEEKDAY_NUMBERS[weekdayName];
  if (weekday === undefined) {
    throw new Error(`zonedTime: unrecognized weekday "${weekdayName ?? ''}"`);
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

/** `timeZone`'s offset from UTC at `instant`, in ms, to the minute that `localParts` reads. */
function offsetAt(instant: number, timeZone: string): number {
  const local = localParts(instant, timeZone);
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute
  );
  return localAsUtc - Math.floor(instant / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/**
 * The instant at which `timeZone`'s wall clock reads `wallAsUtc` (the wall time's fields taken
 * as UTC). It is read with the zone's offset a day before and a day after; a reading that the
 * zone's clock actually shows wins, and where both do (a DST overlap) or neither does (a DST
 * gap) the earlier one is taken.
 */
export function wallClockToInstant(
  wallAsUtc: number,
  timeZone: string
): number {
  const readings = [
    wallAsUtc - offsetAt(wallAsUtc - MS_PER_DAY, timeZone),
    wallAsUtc - offsetAt(wallAsUtc + MS_PER_DAY, timeZone)
  ];
  const shown = readings.filter(
    instant => instant + offsetAt(instant, timeZone) === wallAsUtc
  );
  return Math.min(...(shown.length > 0 ? shown : readings));
}

/**
 * The instant at which `timeZone`'s wall clock reads `year`-`month`-`day` plus `minuteOfDay`
 * minutes, by `wallClockToInstant`. `minuteOfDay` may exceed a day's length (`'24:00'` parses
 * to 1440), which rolls over to the next calendar day.
 */
export function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string
): number {
  return wallClockToInstant(
    Date.UTC(year, month - 1, day, 0, minuteOfDay),
    timeZone
  );
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
export function weekdayAt(startWeekday: number, offset: number): Weekday {
  const index =
    (((startWeekday - 1 + offset) % ISO_WEEK_DAYS) + ISO_WEEK_DAYS) %
    ISO_WEEK_DAYS;
  return (index + 1) as Weekday;
}
