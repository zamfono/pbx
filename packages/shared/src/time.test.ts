import { describe, expect, it } from 'vitest';

import {
  cutoffIso,
  epochSeconds,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND
} from './time.js';

describe('time', () => {
  it('counts a second, a minute, an hour and a day in milliseconds', () => {
    expect(MS_PER_SECOND).toBe(1000);
    expect(MS_PER_MINUTE).toBe(60 * MS_PER_SECOND);
    expect(MS_PER_HOUR).toBe(60 * MS_PER_MINUTE);
    expect(MS_PER_DAY).toBe(24 * MS_PER_HOUR);
  });

  it('rounds an instant down to whole epoch seconds', () => {
    expect(epochSeconds(1_999)).toBe(1);
  });

  it('puts the cutoff whole days before now', () => {
    expect(cutoffIso('2026-09-30T12:00:00.000Z', 2)).toBe(
      '2026-09-28T12:00:00.000Z'
    );
  });
});
