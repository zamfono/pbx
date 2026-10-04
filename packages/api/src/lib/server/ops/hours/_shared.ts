import type { Selectable } from 'kysely';
import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT, type DB, type Db } from '@zamfono/shared';

import { inScope, type ScopeInput } from '../scope.js';
import { OpError } from '../types.js';

export type OpeningHoursRow = Selectable<DB['openingHours']>;
export type IntervalRow = Selectable<DB['openingHoursIntervals']>;

const MAX_WEEKDAY = 7;

/** One weekly open interval (§11.2 `opening_hours_intervals`), as `hours.set` takes it and `hours.get` returns it. */
export const intervalSchema = z.object({
  weekday: z
    .number()
    .int()
    .min(1)
    .max(MAX_WEEKDAY)
    .describe('ISO 8601 weekday: 1 is Monday, 7 Sunday.'),
  opens: z
    .string()
    .describe('HH:MM, inclusive, in the tenant time zone (settings.timezone).'),
  closes: z
    .string()
    .describe('HH:MM, exclusive, after opens; 24:00 is the end of the day.')
});
export type IntervalInput = z.infer<typeof intervalSchema>;

// 'HH:MM', 00:00-23:59, plus '24:00' standing for the end of day (§11.2 `opening_hours_intervals`).
const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u;

/**
 * Validates `intervals` against `opening_hours_intervals` (§11.2, §10.2 "Opening hours"): each
 * `opens`/`closes` is `HH:MM`, an interval never crosses midnight (`opens < closes`, so a night
 * shift is two rows either side of midnight), and no two intervals share a `(weekday, opens)`
 * pair. Returns them sorted by weekday then `opens`, the order `hours.get` also returns.
 */
export function validateIntervals(intervals: IntervalInput[]): IntervalInput[] {
  for (const interval of intervals) {
    if (
      !TIME_OF_DAY_PATTERN.test(interval.opens) ||
      !TIME_OF_DAY_PATTERN.test(interval.closes)
    ) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `hours: invalid time of day in ${interval.opens}-${interval.closes}`
      );
    }
    if (!(interval.opens < interval.closes)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `hours: interval ${interval.opens}-${interval.closes} crosses midnight`
      );
    }
  }
  const seen = new Set<string>();
  for (const interval of intervals) {
    const key = `${interval.weekday}:${interval.opens}`;
    if (seen.has(key)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `hours: duplicate interval starting ${interval.opens} on weekday ${interval.weekday}`
      );
    }
    seen.add(key);
  }
  return [...intervals].sort(
    (left, right) =>
      left.weekday - right.weekday || left.opens.localeCompare(right.opens)
  );
}

/** The live `opening_hours` row for `scope`, or `undefined` when none is set yet. */
export async function loadSchedule(
  db: Db,
  scope: ScopeInput
): Promise<OpeningHoursRow | undefined> {
  return db
    .selectFrom('openingHours')
    .selectAll()
    .where(inScope(scope))
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}

/** `openingHoursId`'s intervals, sorted by weekday then `opens`. */
export async function loadIntervals(
  db: Db,
  openingHoursId: string
): Promise<IntervalRow[]> {
  return db
    .selectFrom('openingHoursIntervals')
    .selectAll()
    .where('openingHoursId', '=', openingHoursId)
    .orderBy('weekday')
    .orderBy('opens')
    .execute();
}
