import { describe, expect, it } from 'vitest';

import { cutoffIso, MS_PER_DAY, MS_PER_SECOND } from './time.js';

describe('time', () => {
  it('counts a second and a day in milliseconds', () => {
    expect(MS_PER_SECOND).toBe(1000);
    expect(MS_PER_DAY).toBe(86_400 * MS_PER_SECOND);
  });

  it('puts the cutoff whole days before now', () => {
    expect(cutoffIso('2026-09-30T12:00:00.000Z', 2)).toBe(
      '2026-09-28T12:00:00.000Z'
    );
  });
});
