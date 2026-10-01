import type { Selectable } from 'kysely';

import type { DB, Db } from '@zamfono/shared';

import { scopeColumns, type ScopeInput } from '../ooo/_shared.js';
import { OpError } from '../types.js';

export {
  assertOwnScopeOrAdmin,
  scopeColumns,
  scopeFromColumns,
  scopeInputSchema,
  type ScopeInput
} from '../ooo/_shared.js';

export type OpeningHoursRow = Selectable<DB['openingHours']>;
export type IntervalRow = Selectable<DB['openingHoursIntervals']>;

// `weekday` is ISO 8601 (1 = Monday … 7 = Sunday, §11.2 `opening_hours_intervals`), a plain
// `number` here since the zod input schema enforces the 1-7 range at runtime.
export type IntervalInput = { weekday: number; opens: string; closes: string };

const STATUS_UNPROCESSABLE_ENTITY = 422;

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
        STATUS_UNPROCESSABLE_ENTITY,
        `hours: invalid time of day in ${interval.opens}-${interval.closes}`
      );
    }
    if (!(interval.opens < interval.closes)) {
      throw new OpError(
        STATUS_UNPROCESSABLE_ENTITY,
        `hours: interval ${interval.opens}-${interval.closes} crosses midnight`
      );
    }
  }
  const seen = new Set<string>();
  for (const interval of intervals) {
    const key = `${interval.weekday}:${interval.opens}`;
    if (seen.has(key)) {
      throw new OpError(
        STATUS_UNPROCESSABLE_ENTITY,
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
  const columns = scopeColumns(scope);
  return db
    .selectFrom('openingHours')
    .selectAll()
    .where(
      'scopeUserId',
      columns.scopeUserId === null ? 'is' : '=',
      columns.scopeUserId
    )
    .where(
      'scopeRingGroupId',
      columns.scopeRingGroupId === null ? 'is' : '=',
      columns.scopeRingGroupId
    )
    .where(
      'scopeMenuId',
      columns.scopeMenuId === null ? 'is' : '=',
      columns.scopeMenuId
    )
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
