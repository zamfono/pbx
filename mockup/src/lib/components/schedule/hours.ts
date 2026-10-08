/**
 * The weekly opening-hours model of the schedule editor.
 *
 * The API stores a week as `HoursInterval[]` (`weekday` 1 = Monday … 7 = Sunday, `opens` and
 * `closes` as `HH:MM`, `closes` may be `24:00`). The editor works on a {@link Week}: per weekday
 * the ranges in the order the person entered them, so a list row keeps its place while its times
 * are typed. {@link validateIntervals} names the first rule the week breaks as an i18n code;
 * {@link mergeTouching} turns a valid week into its canonical stored form, one interval per
 * contiguous opening period.
 */
import type { HoursInterval } from '#lib/api/types.js';

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type DayRange = { start: string; end: string };
export type Week = Record<Weekday, DayRange[]>;

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
export const END_OF_DAY = '24:00';

const openingPattern = /^(?<hours>[01]\d|2[0-3]):(?<minutes>[0-5]\d)$/u;
const TIME_COMPONENT_WIDTH = 2;

/** Minutes since midnight of a time of day (`00:00`–`23:59`), or `undefined`. */
export const openingToMinutes = (time: string): number | undefined => {
  const match = openingPattern.exec(time);
  if (match?.groups === undefined) {
    return undefined;
  }
  return (
    Number(match.groups.hours) * MINUTES_PER_HOUR + Number(match.groups.minutes)
  );
};

/** Minutes since midnight of an interval bound: a time of day, or `24:00` = 1440. */
export const timeToMinutes = (time: string): number | undefined =>
  time === END_OF_DAY ? MINUTES_PER_DAY : openingToMinutes(time);

/** `HH:MM` of a minute count, clamped to `00:00`–`24:00`. */
export const minutesToTime = (minutes: number): string => {
  const clamped = Math.min(Math.max(Math.round(minutes), 0), MINUTES_PER_DAY);
  const hour = String(Math.floor(clamped / MINUTES_PER_HOUR));
  const minute = String(clamped % MINUTES_PER_HOUR);
  return `${hour.padStart(TIME_COMPONENT_WIDTH, '0')}:${minute.padStart(TIME_COMPONENT_WIDTH, '0')}`;
};

export const isWeekday = (value: number): value is Weekday =>
  Number.isInteger(value) && value >= 1 && value <= WEEKDAYS.length;

export const emptyWeek = (): Week => ({
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
  7: []
});

/** The editor's week of `intervals`, each day in the given order; unknown weekdays are skipped. */
export const weekFromIntervals = (intervals: HoursInterval[]): Week => {
  const week = emptyWeek();
  for (const { weekday, opens, closes } of intervals) {
    if (isWeekday(weekday)) {
      week[weekday].push({ start: opens, end: closes });
    }
  }
  return week;
};

/** The API intervals of `week`, Monday first, each day in the editor's order. */
export const intervalsFromWeek = (week: Week): HoursInterval[] =>
  WEEKDAYS.flatMap(weekday =>
    week[weekday].map(({ start, end }) => ({
      weekday,
      opens: start,
      closes: end
    }))
  );

const byOpening = (first: HoursInterval, second: HoursInterval): number =>
  (timeToMinutes(first.opens) ?? 0) - (timeToMinutes(second.opens) ?? 0);

export type ScheduleError = { weekday: number; code: string };

/**
 * The first rule `intervals` break, Monday first, as an i18n code with the weekday it concerns;
 * `undefined` when the API accepts them. Per day, malformed times and empty or inverted intervals
 * are reported before overlaps. Overlap covers a repeated `(weekday, opens)`, since every valid
 * interval is at least one minute long. Touching intervals pass: {@link mergeTouching} joins them.
 */
export const validateIntervals = (
  intervals: HoursInterval[]
): ScheduleError | undefined => {
  const unknown = intervals.find(({ weekday }) => !isWeekday(weekday));
  if (unknown !== undefined) {
    return { weekday: unknown.weekday, code: 'schedule.error.invalidWeekday' };
  }

  for (const weekday of WEEKDAYS) {
    const day = intervals.filter(interval => interval.weekday === weekday);

    for (const { opens, closes } of day) {
      const opening = openingToMinutes(opens);
      const closing = timeToMinutes(closes);
      if (opening === undefined || closing === undefined) {
        return { weekday, code: 'schedule.error.invalidTime' };
      }
      if (closing <= opening) {
        return { weekday, code: 'schedule.error.endBeforeStart' };
      }
    }

    const sorted = day.toSorted(byOpening);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const next = sorted[index];
      if (
        previous !== undefined &&
        next !== undefined &&
        (timeToMinutes(previous.closes) ?? 0) > (timeToMinutes(next.opens) ?? 0)
      ) {
        return { weekday, code: 'schedule.error.overlap' };
      }
    }
  }

  return undefined;
};

/**
 * Valid `intervals` in canonical stored form: Monday first, each day sorted by `opens`, touching
 * or overlapping intervals joined into one.
 */
export const mergeTouching = (intervals: HoursInterval[]): HoursInterval[] =>
  WEEKDAYS.flatMap(weekday => {
    const merged: HoursInterval[] = [];
    const day = intervals
      .filter(interval => interval.weekday === weekday)
      .toSorted(byOpening);

    for (const interval of day) {
      const last = merged.at(-1);
      const opening = timeToMinutes(interval.opens) ?? 0;
      const closing = timeToMinutes(interval.closes) ?? 0;
      if (last !== undefined && opening <= (timeToMinutes(last.closes) ?? 0)) {
        if (closing > (timeToMinutes(last.closes) ?? 0)) {
          last.closes = interval.closes;
        }
      } else {
        merged.push({ ...interval });
      }
    }

    return merged;
  });

const DEFAULT_RANGE: DayRange = { start: '09:00', end: '17:00' };

/**
 * `week` with a new range on `weekday`: 09:00–17:00 on an empty day, otherwise the hour after
 * the day's latest end, cut at `24:00`. A day already open until `24:00` gains a range starting
 * at `24:00`, which the validation names so the person adjusts its times.
 */
export const addRange = (week: Week, weekday: Weekday): Week => {
  const ranges = week[weekday];
  const latestEnd = Math.max(
    -1,
    ...ranges.map(range => timeToMinutes(range.end) ?? -1)
  );
  const added: DayRange =
    latestEnd < 0
      ? { ...DEFAULT_RANGE }
      : {
          start: minutesToTime(latestEnd),
          end: minutesToTime(latestEnd + MINUTES_PER_HOUR)
        };
  return { ...week, [weekday]: [...ranges, added] };
};

export const removeRange = (
  week: Week,
  weekday: Weekday,
  index: number
): Week => ({
  ...week,
  [weekday]: week[weekday].toSpliced(index, 1)
});

export const setRange = (
  week: Week,
  weekday: Weekday,
  index: number,
  range: Partial<DayRange>
): Week => ({
  ...week,
  [weekday]: week[weekday].map((current, position) =>
    position === index ? { ...current, ...range } : current
  )
});

/** `week` with `range` inserted into `weekday`, the day sorted by start. */
export const withRange = (
  week: Week,
  weekday: Weekday,
  range: DayRange
): Week => ({
  ...week,
  [weekday]: [...week[weekday], range].toSorted(
    (first, second) =>
      (timeToMinutes(first.start) ?? 0) - (timeToMinutes(second.start) ?? 0)
  )
});

export type DayGroup = {
  from: Weekday;
  to: Weekday;
  ranges: DayRange[];
};

/**
 * Consecutive open days with identical hours, for a compact summary. Each day's intervals are
 * merged first, so `08:00–12:00, 12:00–17:00` and `08:00–17:00` count as the same hours; closed
 * days end a group and appear in none.
 */
export const groupWeek = (intervals: HoursInterval[]): DayGroup[] => {
  const merged = weekFromIntervals(mergeTouching(intervals));
  const groups: DayGroup[] = [];
  const signature = (ranges: DayRange[]): string =>
    ranges.map(({ start, end }) => `${start}-${end}`).join(',');

  for (const weekday of WEEKDAYS) {
    const ranges = merged[weekday];
    if (ranges.length === 0) {
      continue;
    }
    const last = groups.at(-1);
    if (
      last !== undefined &&
      last.to === weekday - 1 &&
      signature(last.ranges) === signature(ranges)
    ) {
      last.to = weekday;
    } else {
      groups.push({ from: weekday, to: weekday, ranges });
    }
  }

  return groups;
};
