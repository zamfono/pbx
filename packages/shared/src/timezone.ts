/**
 * The tenant clock (§11.4 `timezone`: "IANA name; … NULL = stack `TZ`, else UTC"), shared by
 * `api` and `core` so both processes evaluate hours in the same zone.
 */

const FALLBACK_TIMEZONE = 'UTC';

// `Intl` also takes UTC offsets such as `+01:00`, which are no IANA names.
const OFFSET_PREFIX = /^[+-]/u;

/**
 * Whether `name` is an IANA time zone the runtime knows, asked of `Intl` itself: its zone list
 * (`Intl.supportedValuesOf`) leaves out links such as `UTC` and `Etc/UTC`, which the database
 * still names, so the check constructs a formatter instead.
 */
export function isIanaTimeZone(name: string): boolean {
  if (name === '' || OFFSET_PREFIX.test(name)) {
    return false;
  }
  try {
    // eslint-disable-next-line no-new -- constructing it is the check; RangeError on an unknown zone
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone every hour-based feature evaluates in (§11.4, §6.4 "All hours resolve in the tenant's
 * time zone"): `settings.timezone`, else the stack's `TZ`, else UTC. A value `Intl` cannot use —
 * a row written before `settings.update` validated the field, or a POSIX-style `TZ` — counts as
 * absent, so a bad zone falls through the chain instead of throwing inside a call or a job.
 */
export function resolveTenantTimeZone(
  settingsTimezone: string | null,
  stackTz: string | undefined
): string {
  if (settingsTimezone !== null && isIanaTimeZone(settingsTimezone)) {
    return settingsTimezone;
  }
  if (stackTz !== undefined && isIanaTimeZone(stackTz)) {
    return stackTz;
  }
  return FALLBACK_TIMEZONE;
}
