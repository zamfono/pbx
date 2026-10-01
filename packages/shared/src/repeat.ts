/**
 * The "run now, then every period, until stopped" schedule of the background jobs no request
 * drives: `core`'s retention sweep (§11.6) and `api`'s daily purge (§5.9).
 */

export type RepeatOptions = {
  /** Keeps the pending timer from holding the process open (`Timeout.unref()`). */
  unref?: boolean;
};

/**
 * Runs `fn` now, then again `periodMs` after each run has settled, so a slow run never overlaps
 * the next. `fn` handles and logs its own failures: a rejection is dropped here and the schedule
 * goes on. `stop()` cancels the next run; one already in flight finishes.
 */
export function repeat(
  fn: () => unknown,
  periodMs: number,
  options: RepeatOptions = {}
): { stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
  };
  const arm = (next: () => void): void => {
    timer = setTimeout(next, periodMs);
    if (options.unref === true) {
      timer.unref();
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
        if (!stopped) {
          arm(run);
        }
      });
  };
  run();
  return { stop };
}
