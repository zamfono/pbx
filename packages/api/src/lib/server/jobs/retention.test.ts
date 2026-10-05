import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@zamfono/shared';

import { runPurge } from './purge.js';
import { scheduleRetention } from './retention.js';

vi.mock('./purge.js', () => ({ runPurge: vi.fn() }));

const runPurgeMock = vi.mocked(runPurge);
const INTERVAL_MS = 10;
const NOW = '2026-01-01T00:00:00.000Z';
const FAKE_DB = {} as unknown as Db;

describe('scheduleRetention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a purge cycle immediately and again on the next interval', async () => {
    runPurgeMock.mockReset().mockResolvedValue(undefined);
    const scheduler = scheduleRetention(FAKE_DB, () => NOW, INTERVAL_MS);
    expect(runPurgeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    scheduler.stop();

    expect(runPurgeMock).toHaveBeenCalledTimes(2);
    expect(runPurgeMock).toHaveBeenCalledWith(FAKE_DB, NOW);
  });

  it('keeps scheduling after a cycle throws', async () => {
    runPurgeMock
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const scheduler = scheduleRetention(FAKE_DB, () => NOW, INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    scheduler.stop();

    expect(runPurgeMock).toHaveBeenCalledTimes(2);
  });

  it('stop() clears the pending timer so no further cycle runs', async () => {
    runPurgeMock.mockReset().mockResolvedValue(undefined);
    const scheduler = scheduleRetention(FAKE_DB, () => NOW, INTERVAL_MS);
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(runPurgeMock).toHaveBeenCalledTimes(1);
  });
});
