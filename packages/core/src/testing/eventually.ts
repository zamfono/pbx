// Test-only: waiting for the asynchronous state a test depends on instead of sleeping a fixed time.
// A fixed sleep guesses how long ARI round trips and DB reads take; under a loaded run that guess
// is wrong, and the assertion after it sees a half-finished flow.
import type { EventEmitter } from 'node:events';
import { vi } from 'vitest';

import type { FakeAri } from '../ari/fake.js';
import type { FakeRequest } from '../ari/fakeTransport.js';

// Well past a loaded run's slowest round trips, and still inside vitest's 5 s test timeout, so a
// state that never arrives fails on its own assertion rather than on the test timeout.
const EVENTUALLY_TIMEOUT_MS = 4000;
const EVENTUALLY_INTERVAL_MS = 5;

/**
 * Retries `check` until it stops throwing (an `expect` inside it holds) and resolves with its
 * result; rejects with the last failure once `timeoutMs` elapses.
 */
export function eventually<T>(
  check: () => T | Promise<T>,
  timeoutMs = EVENTUALLY_TIMEOUT_MS
): Promise<T> {
  return vi.waitFor(check, {
    timeout: timeoutMs,
    interval: EVENTUALLY_INTERVAL_MS
  });
}

/** The first `method path` request `fakeAri` received, waiting for it to land. */
export function requestTo(
  fakeAri: FakeAri,
  method: string,
  path: string
): Promise<FakeRequest> {
  return eventually(() => {
    const found = fakeAri.calls.find(
      entry => entry.method === method && entry.path === path
    );
    if (found === undefined) {
      throw new Error(`FakeAri received no ${method} ${path}`);
    }
    return found;
  });
}

/**
 * Resolves once the code under test next subscribes to `emitter`'s `event` (the ARI client's
 * event stream), for a test about to emit what that code waits for: an event emitted before the
 * subscription would go unseen. Call it before the step that leads to the subscription.
 */
export function nextSubscription(
  emitter: EventEmitter,
  event = 'event'
): Promise<void> {
  return new Promise(resolve => {
    const onNewListener = (name: string | symbol): void => {
      if (name === event) {
        emitter.off('newListener', onNewListener);
        // `newListener` fires just before the listener is added; the test resumes after it is.
        resolve();
      }
    };
    emitter.on('newListener', onNewListener);
  });
}
