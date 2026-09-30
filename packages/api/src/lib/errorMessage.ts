/** A caught value's message for a log line, audit entry or warning: an `Error`'s own, else the value as a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
