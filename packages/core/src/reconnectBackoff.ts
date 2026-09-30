/**
 * The reconnect schedule the ARI and AMI clients share after their connection drops: the first
 * retry after a second, each further one twice as long, at most 30 s apart, back to a second
 * once a connection is up again.
 */
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_BACKOFF_FACTOR = 2;

export type ReconnectBackoff = {
  /** Arms the next `reconnect` after the current delay, and doubles the delay after it. */
  schedule: () => void;
  /** Back to the initial delay, for a connection that came up. */
  reset: () => void;
  /** Cancels an armed reconnect, for a client being closed. */
  cancel: () => void;
};

/** A backoff that calls `reconnect` on each armed retry, handing a failed one to `onError`. */
export function reconnectBackoff(
  reconnect: () => Promise<void>,
  onError: (error: unknown) => void
): ReconnectBackoff {
  let delayMs = RECONNECT_INITIAL_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    schedule(): void {
      cancel();
      const delay = delayMs;
      delayMs = Math.min(
        delay * RECONNECT_BACKOFF_FACTOR,
        RECONNECT_MAX_DELAY_MS
      );
      timer = setTimeout(() => {
        timer = null;
        reconnect().catch(onError);
      }, delay);
    },
    reset(): void {
      delayMs = RECONNECT_INITIAL_DELAY_MS;
    },
    cancel
  };
}
