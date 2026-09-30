/** The current instant as an ISO 8601 UTC timestamp, the format stored in every `_at` column (§11.1). */
export function nowIso(): string {
  return new Date().toISOString();
}
