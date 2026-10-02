/** When a webhook delivery is made and retried (§10.6 "Webhooks"). */
import { tryParseJson } from './json.js';

// §10.6: three attempts total per delivery, and the two backoff delays between them.
export const DELIVERY_ATTEMPTS = 3;
const FIRST_RETRY_DELAY_MS = 1000;
const SECOND_RETRY_DELAY_MS = 4000;
const RETRY_BACKOFF_MS = [FIRST_RETRY_DELAY_MS, SECOND_RETRY_DELAY_MS];

/**
 * `true` when a hook's optional event-type filter, `eventTypesJson`, admits `eventType`; `null` means every type.
 * An unparsable filter admits nothing, so one malformed row never blocks delivery to the other
 * hooks matching the same event.
 */
export function matchesFilter(
  eventTypesJson: string | null,
  eventType: string
): boolean {
  if (eventTypesJson === null) {
    return true;
  }
  const types = tryParseJson(eventTypesJson);
  return Array.isArray(types) && types.includes(eventType);
}

/** The wait before retry `retry` (1-based), from `RETRY_BACKOFF_MS`. */
export function backoffMs(retry: number): number {
  const delay = RETRY_BACKOFF_MS[retry - 1];
  // `RETRY_BACKOFF_MS` has one entry per retry (`DELIVERY_ATTEMPTS - 1`), so this is always
  // in range.
  if (delay === undefined) {
    throw new Error(`webhooks: no backoff for retry ${retry}`);
  }
  return delay;
}
