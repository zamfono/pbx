/** One day in milliseconds, as retention windows, overrides and schedules count it (UTC, no DST). */
export const MS_PER_DAY = 86_400_000;

/** The current instant as an ISO 8601 UTC timestamp, the format stored in every `_at` column (§11.1). */
export function nowIso(): string {
  return new Date().toISOString();
}
