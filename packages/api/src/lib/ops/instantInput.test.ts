import { describe, expect, it } from 'vitest';

import { instantInput, toStoredInstant } from './instantInput.js';

describe('instantInput', () => {
  it.each([
    ['2026-10-01T12:00:00+02:00', '2026-10-01T10:00:00.000Z'],
    ['2026-10-01T12:00:00-05:30', '2026-10-01T17:30:00.000Z'],
    ['2026-10-01T12:00:00Z', '2026-10-01T12:00:00.000Z'],
    ['2026-10-01T12:00:00.5Z', '2026-10-01T12:00:00.500Z'],
    ['2026-10-01T12:00:00.123Z', '2026-10-01T12:00:00.123Z'],
    ['2026-10-01T12:00:00', '2026-10-01T12:00:00.000Z'],
    ['2026-10-01T12:00', '2026-10-01T12:00:00.000Z'],
    ['2026-10-01', '2026-10-01T00:00:00.000Z']
  ])('accepts %s and stores it as %s', (value, stored) => {
    expect(instantInput.safeParse(value).success).toBe(true);
    expect(toStoredInstant(value)).toBe(stored);
  });

  it.each([
    'yesterday',
    '',
    '2026-10-01 12:00:00Z',
    '2026-10-01T12:00:00 02:00',
    '2026-10-01T12:00:00+0200',
    '2026-02-30T00:00:00Z',
    '1790850856445'
  ])('rejects %j', value => {
    expect(instantInput.safeParse(value).success).toBe(false);
  });
});
