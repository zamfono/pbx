import { z } from 'zod';

import { localParts, MS_PER_DAY, type Db } from '@zamfono/shared';

import { tenantTimeZone } from '../tenantTimeZone.js';

/**
 * An instant that a read filters stored timestamps by: an ISO 8601 date-time with any offset,
 * with seconds and fractions optional, or a date alone. A date-time without an offset is a wall
 * clock time in the tenant's time zone, a date alone that zone's midnight (§10.3).
 */
export const instantInput = z.union([
  z.iso.datetime({ offset: true, local: true }),
  z.iso.date()
]);

const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/u;
const MS_PER_MINUTE = 60_000;

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
function wallTimeToInstant(wallAsUtc: number, timeZone: string): number {
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
 * `value`, an `instantInput`, in the form an `_at` column holds (`toISOString`: UTC with
 * milliseconds), so a string comparison against the column compares instants. A value with an
 * offset or `Z` is taken as given; one without is read on `timeZone`'s wall clock.
 */
export function toStoredInstant(value: string, timeZone: string): string {
  if (HAS_OFFSET.test(value)) {
    return new Date(value).toISOString();
  }
  const wall = value.length === ISO_DATE_LENGTH ? `${value}T00:00` : value;
  const wallAsUtc = Date.parse(`${wall}Z`);
  return new Date(wallTimeToInstant(wallAsUtc, timeZone)).toISOString();
}

/**
 * `toStoredInstant` bound to the tenant's time zone as `api` resolves it (§11.4 `timezone`); a
 * database without its `settings` row reads as one whose `timezone` is unset.
 */
export async function tenantInstantReader(
  db: Db
): Promise<(value: string) => string> {
  const row = await db
    .selectFrom('settings')
    .select('timezone')
    .where('id', '=', 1)
    .executeTakeFirst();
  const timeZone = tenantTimeZone(row?.timezone ?? null);
  return value => toStoredInstant(value, timeZone);
}
