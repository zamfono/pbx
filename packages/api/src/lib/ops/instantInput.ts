import { z } from 'zod';

/**
 * An instant that a read filters stored timestamps by: an ISO 8601 date-time with any offset,
 * with seconds and fractions optional, or a date alone. A date-time without an offset, and a
 * date alone, are read as UTC, the zone every `_at` column is stored in (§11.1).
 */
export const instantInput = z.union([
  z.iso.datetime({ offset: true, local: true }),
  z.iso.date()
]);

const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * `value`, an `instantInput`, in the form an `_at` column holds (`toISOString`: UTC with
 * milliseconds), so a string comparison against the column compares instants. ECMAScript reads a
 * date alone as UTC but a date-time without an offset in the host's zone, so the latter gets `Z`.
 */
export function toStoredInstant(value: string): string {
  const utc =
    value.length === ISO_DATE_LENGTH || HAS_OFFSET.test(value)
      ? value
      : `${value}Z`;
  return new Date(utc).toISOString();
}
