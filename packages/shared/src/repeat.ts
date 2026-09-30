/**
 * The "run now, then every period, until stopped" schedule of the background jobs no request
 * drives: `core`'s retention sweep (§11.6) and `api`'s daily purge (§5.9).
 */

export type RepeatOptions = {
  /** Run `fn` once at once, before the first period has passed (the default), or only after it. */
  runNow?: boolean;
  /** Stops the schedule when aborted, like `stop()`. */
  signal?: AbortSignal;
  /** Keeps the pending timer from holding the process open (`Timeout.unref()`). */
  unref?: boolean;
};

/**
 * Runs `fn` now (unless `runNow` is false), then again `periodMs` after each run has settled, so
 * a slow run never overlaps the next. `fn` handles and logs its own failures: a rejection is
 * dropped here and the schedule goes on. `stop()` (or aborting `signal`) cancels the next run;
 * one already in flight finishes.
 */
export function repeat(
  fn: () => unknown,
  periodMs: number,
  options: RepeatOptions = {}
): { stop: () => void } {
  const state: { timer?: NodeJS.Timeout; stopped: boolean } = {
    stopped: false
  };
  const stop = (): void => {
    state.stopped = true;
    clearTimeout(state.timer);
  };
  const arm = (next: () => void): void => {
    state.timer = setTimeout(next, periodMs);
    if (options.unref === true) {
      state.timer.unref();
    }
  };
  // `fn` is called in `run` itself, not a microtask later, so the run `repeat` starts "now" is
  // already in flight when it returns: a `stop()` right after cancels only the runs after it.
  const run = (): void => {
    new Promise(resolve => {
      resolve(fn());
    })
      .catch(() => undefined)
      .finally(() => {
        if (!state.stopped) {
          arm(run);
        }
      });
  };
  if (options.signal?.aborted === true) {
    stop();
    return { stop };
  }
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.runNow ?? true) {
    run();
  } else {
    arm(run);
  }
  return { stop };
}
