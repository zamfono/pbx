/**
 * Wall-clock arithmetic in an IANA time zone, for the opening-hours evaluation in `schedule.ts`:
 * reading the local date, weekday and time of an instant, converting a local date and time back
 * to an instant across DST transitions, and calendar-day and weekday shifts. Every computation
 * goes through `Intl` rather than a date library.
 */

/** ISO 8601 weekday: 1 = Monday … 7 = Sunday. */
// eslint-disable-next-line no-magic-numbers -- the seven ISO weekday literals of the type itself
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const MINUTES_PER_HOUR = 60;
const ISO_WEEK_DAYS = 7;
// Two passes resolve the DST-transition case (the first guess lands on the wrong side of the
// offset change); a third pass would never change the result since the offset only takes one
// of two values around a transition.
const ZONE_CONVERSION_PASSES = 2;

const WEEKDAY_NUMBERS: Record<string, Weekday> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

type LocalDateTime = {
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
    throw new Error(`schedule: unrecognized weekday "${weekdayName ?? ''}"`);
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

/**
 * The UTC instant at which `timeZone`'s wall clock reads `year`-`month`-`day`
 * plus `minuteOfDay` minutes. `minuteOfDay` may exceed a day's length
 * (`'24:00'` parses to 1440), which rolls over to the next calendar day.
 */
export function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string
): number {
  const hour = Math.floor(minuteOfDay / MINUTES_PER_HOUR);
  const minute = minuteOfDay % MINUTES_PER_HOUR;
  const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wantedAsUtc;
  for (let pass = 0; pass < ZONE_CONVERSION_PASSES; pass += 1) {
    const seen = localParts(guess, timeZone);
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
export function weekdayAt(startWeekday: number, offset: number): Weekday {
  const index =
    (((startWeekday - 1 + offset) % ISO_WEEK_DAYS) + ISO_WEEK_DAYS) %
    ISO_WEEK_DAYS;
  return (index + 1) as Weekday;
}
