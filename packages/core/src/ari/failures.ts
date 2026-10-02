/**
 * The two ways a failure nobody acts on is handled. An ARI request on a channel or bridge that
 * has already gone (a hangup racing the request, the expected case) is dropped, and nothing
 * else is: every other failure either reaches the flow that made the request or, for a promise
 * nothing awaits, is logged with what failed.
 */
import { AriError, type Logger } from './types.js';

const HTTP_NOT_FOUND = 404;

/** Whether a rejected ARI request says its channel or bridge no longer exists: ARI answers 404
 * for a channel that has hung up or a bridge that has been destroyed. */
export function isGone(error: unknown): boolean {
  return error instanceof AriError && error.status === HTTP_NOT_FOUND;
}

/** A `.catch` handler for an ARI request on a channel or bridge that may already be gone: drops
 * that outcome and rethrows every other failure. */
export function ignoreGone(error: unknown): void {
  if (!isGone(error)) {
    throw error;
  }
}

/** A `.catch` handler for a promise nothing awaits: logs that `what` failed, with `fields` as the
 * line's context (a call's `callId`, §7), and continues. */
export function logFailure(
  log: Logger,
  what: string,
  fields: Record<string, unknown> = {}
): (error: unknown) => void {
  return (error: unknown) => {
    log.error({ err: error, ...fields }, `${what} failed`);
  };
}
