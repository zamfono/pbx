import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconnectBackoff } from './reconnectBackoff.js';

describe('reconnectBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** When each `schedule()` in a row fires, relative to the one before it. */
  async function delaysOf(count: number): Promise<number[]> {
    const at: number[] = [];
    const backoff = reconnectBackoff(() => {
      at.push(Date.now());
      return Promise.resolve();
    }, vi.fn());
    let last = Date.now();
    const delays: number[] = [];
    for (let attempt = 0; attempt < count; attempt += 1) {
      backoff.schedule();
      // eslint-disable-next-line no-await-in-loop -- each retry is armed only after the one before fired
      await vi.runOnlyPendingTimersAsync();
      const fired = at.at(-1) ?? last;
      delays.push(fired - last);
      last = fired;
    }
    return delays;
  }

  it('doubles from one second up to thirty', async () => {
    expect(await delaysOf(7)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000
    ]);
  });

  it('starts over at one second after a reset', async () => {
    const reconnect = vi.fn(() => Promise.resolve());
    const backoff = reconnectBackoff(reconnect, vi.fn());
    backoff.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    backoff.reset();
    backoff.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it('never reconnects once cancelled, and hands a failed reconnect to onError', async () => {
    const failure = new Error('refused');
    const reconnect = vi.fn(() => Promise.reject(failure));
    const onError = vi.fn();
    const backoff = reconnectBackoff(reconnect, onError);
    backoff.schedule();
    backoff.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconnect).not.toHaveBeenCalled();

    backoff.schedule();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
