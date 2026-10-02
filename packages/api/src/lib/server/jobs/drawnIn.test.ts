import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLL_INTERVAL_MS, scheduleDrawnIn } from './drawnIn.js';

const DUE_IN_MS = 5000;

describe('scheduleDrawnIn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at once, then at the moment a pass names when that is sooner than the poll', async () => {
    const pass = vi.fn(async () =>
      Promise.resolve(new Date(Date.now() + DUE_IN_MS))
    );
    const schedule = scheduleDrawnIn({ pass, failed: vi.fn() });
    expect(pass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DUE_IN_MS);
    expect(pass).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('reports a failed pass and retries on the regular poll', async () => {
    const pass = vi.fn(async () => Promise.reject(new Error('boom')));
    const failed = vi.fn();
    const schedule = scheduleDrawnIn({ pass, failed });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledWith(new Error('boom'));

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('runs a pass asked for while one is in flight once that one has settled', async () => {
    const settles: (() => void)[] = [];
    const pass = vi.fn(
      async () =>
        new Promise<null>(resolve => {
          settles.push(() => {
            resolve(null);
          });
        })
    );
    const schedule = scheduleDrawnIn({ pass, failed: vi.fn() });
    schedule.runNow();
    schedule.runNow();
    expect(pass).toHaveBeenCalledTimes(1);

    settles[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('runs no pass after stop()', async () => {
    const pass = vi.fn(async () => Promise.resolve(null));
    const schedule = scheduleDrawnIn({ pass, failed: vi.fn() });
    schedule.stop();
    schedule.runNow();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(pass).toHaveBeenCalledTimes(1);
  });
});
