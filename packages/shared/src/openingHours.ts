/**
 * The closed periods of a weekly opening-hours schedule over a window of days, for §6.4 step 2's
 * midpoint-of-longest-closed-period search (`packages/api/src/lib/server/jobs/reloadTiming.ts`)
 * and for core's OOO/hours sweep, which wakes at the next edge of one (`packages/core/src/sweep.ts`).
 */
import { MINUTES_PER_HOUR, MS_PER_DAY } from './time.js';
import { wallClockMs } from './timezone.js';

/** One `opening_hours_intervals` row: open from `opens` to `closes` (`'HH:MM'`) on ISO `weekday`. */
export type OpeningInterval = {
  weekday: number;
  opens: string;
  closes: string;
};

/** Parses `'HH:MM'` (or `'24:00'`, end of day) into minutes since local midnight. */
export function parseTimeOfDay(value: string): number {
  const [hourPart = '0', minutePart = '0'] = value.split(':');
  return Number(hourPart) * MINUTES_PER_HOUR + Number(minutePart);
}

/**
 * The closed periods of `schedule` within `[fromIso, fromIso + days)`, merged
 * across day boundaries.
 */
export function closedPeriods(
  schedule: { intervals: readonly OpeningInterval[] },
  fromIso: string,
  days: number,
  timezone: string
): { start: string; end: string }[] {
  const from = new Date(fromIso).getTime();
  const to = from + days * MS_PER_DAY;
  const startDate = Temporal.Instant.fromEpochMilliseconds(from)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const instantAt = (date: Temporal.PlainDate, time: string): number =>
    wallClockMs(
      date.toPlainDateTime().add({ minutes: parseTimeOfDay(time) }),
      timezone
    );

  const openIntervals: { start: number; end: number }[] = [];
  // One extra day on each side of the range so an open interval that starts before `from` or
  // ends after `to` is still found and clipped into range, instead of being missed entirely.
  for (let dayOffset = -1; dayOffset <= days; dayOffset += 1) {
    const date = startDate.add({ days: dayOffset });
    for (const interval of schedule.intervals) {
      if (interval.weekday !== date.dayOfWeek) {
        continue;
      }
      const openStart = instantAt(date, interval.opens);
      const openEnd = instantAt(date, interval.closes);
      if (openEnd <= from || openStart >= to) {
        continue;
      }
      openIntervals.push({
        start: Math.max(openStart, from),
        end: Math.min(openEnd, to)
      });
    }
  }
  openIntervals.sort((earlier, later) => earlier.start - later.start);

  const mergedOpen: { start: number; end: number }[] = [];
  for (const interval of openIntervals) {
    const last = mergedOpen.at(-1);
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      mergedOpen.push({ ...interval });
    }
  }

  const closed: { start: string; end: string }[] = [];
  let cursor = from;
  for (const interval of mergedOpen) {
    if (interval.start > cursor) {
      closed.push({
        start: new Date(cursor).toISOString(),
        end: new Date(interval.start).toISOString()
      });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < to) {
    closed.push({
      start: new Date(cursor).toISOString(),
      end: new Date(to).toISOString()
    });
  }
  return closed;
}
