/** One second in milliseconds, for every `*_s` setting and timeout a timer or `Date` counts in ms. */
export const MS_PER_SECOND = 1000;

/** One minute in milliseconds. */
export const MS_PER_MINUTE = 60_000;

/** One hour in milliseconds. */
export const MS_PER_HOUR = 3_600_000;

/** One calendar day of 24 hours, in milliseconds: the unit of every `*_days` retention and window setting. */
export const MS_PER_DAY = 86_400_000;

export const MINUTES_PER_HOUR = 60;

/** The longest delay `setTimeout` takes; a later instant is waited for in slices of at most this. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The current instant as an ISO 8601 UTC timestamp, the format stored in every `_at` column (§11.1). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** The ISO instant `ms` milliseconds after `iso` (before it for a negative `ms`). */
export function addMsIso(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** `now`, `days` earlier, as the ISO instant every retention window compares its `_at` column against. */
export function cutoffIso(now: string, days: number): string {
  return addMsIso(now, -days * MS_PER_DAY);
}

/** The instant `ms` in whole seconds since the epoch, the unit JWT and sealed-cookie expiries count in. */
export function epochSeconds(ms: number): number {
  return Math.floor(ms / MS_PER_SECOND);
}

/** The instant this process started, as an ISO 8601 UTC timestamp. */
export function processStartedAtIso(): string {
  return new Date(Date.now() - process.uptime() * MS_PER_SECOND).toISOString();
}
