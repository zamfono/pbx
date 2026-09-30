/** One second in milliseconds, for every `*_s` setting and timeout a timer or `Date` counts in ms. */
export const MS_PER_SECOND = 1000;

/** One calendar day of 24 hours, in milliseconds: the unit of every `*_days` retention and window setting. */
export const MS_PER_DAY = 86_400_000;

/** The current instant as an ISO 8601 UTC timestamp, the format stored in every `_at` column (§11.1). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** `now`, `days` earlier, as the ISO instant every retention window compares its `_at` column against. */
export function cutoffIso(now: string, days: number): string {
  return new Date(Date.parse(now) - days * MS_PER_DAY).toISOString();
}
