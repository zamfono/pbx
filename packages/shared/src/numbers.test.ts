import { describe, expect, test } from 'vitest';

import { normalizeDialed, normalizeInbound } from './numbers.js';

describe('normalizeInbound', () => {
  test.each([
    ['+4989123', 'e164', 'DE', '+4989123'],
    ['004989123', 'e164', 'DE', '+4989123'],
    ['089123', 'national', 'DE', '+4989123'],
    ['004489123', 'national', 'DE', '+4489123'],
    ['acct-4711', 'e164', 'DE', 'acct-4711'],
    // whitespace → verbatim
    ['+43 1', 'e164', 'AT', '+43 1']
  ])('normalizeInbound(%s,%s,%s)', (raw, format, country, out) => {
    expect(normalizeInbound(raw, format as 'e164' | 'national', country)).toBe(
      out
    );
  });
});

describe('normalizeDialed', () => {
  test.each([
    ['+4989123', { kind: 'e164', number: '+4989123' }],
    ['004989123', { kind: 'e164', number: '+4989123' }],
    ['089123', { kind: 'e164', number: '+4989123' }],
    ['89123', { kind: 'incomplete' }],
    ['0*1', { kind: 'incomplete' }]
  ] as const)('normalizeDialed(%s)', (raw, out) => {
    expect(normalizeDialed(raw, 'DE')).toEqual(out);
  });
});
