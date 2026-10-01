import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { repeat } from './repeat.js';

const PERIOD_MS = 1000;

describe('repeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at once, then once every period, until stopped', async () => {
    const fn = vi.fn();
    const job = repeat(fn, PERIOD_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * PERIOD_MS);
    expect(fn).toHaveBeenCalledTimes(3);

    job.stop();
    await vi.advanceTimersByTimeAsync(2 * PERIOD_MS);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('starts the first run before it returns, which a stop() right after lets finish', async () => {
    const fn = vi.fn();
    const job = repeat(fn, PERIOD_MS);
    expect(fn).toHaveBeenCalledTimes(1);

    job.stop();
    await vi.advanceTimersByTimeAsync(2 * PERIOD_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a rejected run, and never overlaps a slow one', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      await new Promise(resolve => {
        setTimeout(resolve, 2 * PERIOD_MS);
      });
      throw new Error(`run ${String(calls)} failed`);
    });
    const job = repeat(fn, PERIOD_MS);
    // The first run settles at 2 periods, the second starts one period after that.
    await vi.advanceTimersByTimeAsync(3 * PERIOD_MS - 1);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    job.stop();
  });
});
