/** Runs a task once every task queued before it on the same queue has settled. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A new queue: each task waits for the one queued before it, whatever that one's outcome, and
 * settles with its own.
 */
export function serialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return task => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
