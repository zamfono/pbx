import { describe, expect, it } from 'vitest';

import { isoStartupTime } from './restApi.js';

describe('isoStartupTime', () => {
  it("reads Asterisk's colon-less offset as ISO 8601 UTC", () => {
    expect(isoStartupTime('2026-09-29T10:00:00.000+0200')).toBe(
      '2026-09-29T08:00:00.000Z'
    );
  });

  it('refuses a value it cannot read', () => {
    expect(() => isoStartupTime('soon')).toThrow(/unreadable startup_time/u);
    expect(() => isoStartupTime(undefined)).toThrow(/unreadable/u);
  });
});
