import { z } from 'zod';

import type { Db } from '@zamfono/shared';

import { readTenantTimeZone } from '../tenantTimeZone.js';

/**
 * An instant that a read filters stored timestamps by: an ISO 8601 date-time with any offset,
 * with seconds and fractions optional, or a date alone. A date-time without an offset is a wall
 * clock time in the tenant's time zone, a date alone that zone's midnight (§10.3).
 */
export const instantInput = z.union([
  z.iso.datetime({ offset: true, local: true }),
  z.iso.date()
]);

const HAS_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/u;
/**
 * `value`, an `instantInput`, in the form an `_at` column holds (`toISOString`: UTC with
 * milliseconds), so a string comparison against the column compares instants. A value with an
 * offset or `Z` is taken as given; one without is read on `timeZone`'s wall clock.
 */
export function toStoredInstant(value: string, timeZone: string): string {
  if (HAS_OFFSET.test(value)) {
    return new Date(value).toISOString();
  }
  const { epochMilliseconds } = Temporal.PlainDateTime.from(
    value
  ).toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  return new Date(epochMilliseconds).toISOString();
}

/** `toStoredInstant` bound to the tenant's time zone as `api` resolves it (§11.4 `timezone`). */
export async function tenantInstantReader(
  db: Db
): Promise<(value: string) => string> {
  const timeZone = await readTenantTimeZone(db);
  return value => toStoredInstant(value, timeZone);
}
