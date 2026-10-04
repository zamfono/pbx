import { z } from 'zod';

import { wallClockMs, type Db } from '@zamfono/shared';

import { readTenantTimeZone } from '../tenantTimeZone.js';

// A date, alone or with a time of hours and minutes, seconds and fractions optional, that ends in
// `Z`, an offset `±hh:mm` or neither (§10.3).
const INSTANT_FORM =
  /^\d{4}-\d{2}-\d{2}(?<time>T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?<offset>Z|[+-]\d{2}:\d{2})?)?$/u;

type ParsedInstant =
  Temporal.Instant | Temporal.PlainDateTime | Temporal.PlainDate;

/**
 * `value` as the instant it names (`Z` or an offset), the wall-clock time it names (none), or
 * the date it names (a date alone); `null` when it is none of them.
 */
function parseInstant(value: string): ParsedInstant | null {
  const form = INSTANT_FORM.exec(value)?.groups;
  if (!form) {
    return null;
  }
  const { time, offset } = form;
  try {
    if (offset !== undefined) {
      return Temporal.Instant.from(value);
    }
    return time === undefined
      ? Temporal.PlainDate.from(value)
      : Temporal.PlainDateTime.from(value);
  } catch {
    return null;
  }
}

/**
 * An instant that a read filters stored timestamps by: an ISO 8601 date-time with `Z`, an offset
 * or none, seconds and fractions optional, or a date alone. A date-time without an offset is a
 * wall clock time in the tenant's time zone, a date alone that zone's midnight (§10.3).
 */
export const instantInput = z
  .string()
  .refine(
    value => parseInstant(value) !== null,
    'an ISO 8601 date-time, with or without an offset, or a date'
  );

function parsed(value: string): ParsedInstant {
  const instant = parseInstant(value);
  if (instant === null) {
    throw new Error(`not an instantInput: '${value}'`);
  }
  return instant;
}

/** `ms` in the form an `_at` column holds (`toISOString`: UTC with milliseconds). */
function stored(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * `value`, an `instantInput`, as the instant it names, in the form an `_at` column holds, so a
 * string comparison against the column compares instants. A value with an offset or `Z` is taken
 * as given; one without is read on `timeZone`'s wall clock, a date alone as its midnight.
 */
export function toStoredInstant(value: string, timeZone: string): string {
  const instant = parsed(value);
  if (instant instanceof Temporal.Instant) {
    return stored(instant.epochMilliseconds);
  }
  const dateTime =
    instant instanceof Temporal.PlainDate ? instant.toPlainDateTime() : instant;
  return stored(wallClockMs(dateTime, timeZone));
}

/**
 * `value`, an `instantInput`, as the exclusive end of a range (§10.3: `[from, to)`): the instant
 * it names, except that a date alone ends at the following midnight, so the range covers that day.
 */
export function toStoredEnd(value: string, timeZone: string): string {
  const instant = parsed(value);
  return instant instanceof Temporal.PlainDate
    ? toStoredInstant(instant.add({ days: 1 }).toString(), timeZone)
    : toStoredInstant(value, timeZone);
}

/**
 * `toStoredInstant` (`start`, also for a single instant) and `toStoredEnd` (`end`) bound to the
 * tenant's time zone as `api` resolves it (§11.4 `timezone`).
 */
export async function tenantInstantReader(db: Db): Promise<{
  start: (value: string) => string;
  end: (value: string) => string;
}> {
  const timeZone = await readTenantTimeZone(db);
  return {
    start: value => toStoredInstant(value, timeZone),
    end: value => toStoredEnd(value, timeZone)
  };
}
