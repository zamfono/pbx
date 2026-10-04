import { describe, expect, test } from 'vitest';

import { callingCode, normalizeDialed, normalizeInbound } from './numbers.js';

describe('normalizeInbound', () => {
  test.each([
    ['+4989123', 'e164', 'DE', '+4989123'],
    // `e164` is `+digits` only: neither `00` nor bare international digits are guessed.
    ['004989123456', 'e164', 'DE', '004989123456'],
    ['4989123456', 'e164', 'DE', '4989123456'],
    ['089123456', 'e164', 'DE', '089123456'],
    ['089123456', 'national', 'DE', '+4989123456'],
    // Italy keeps its leading 0 in the international form.
    ['0612345678', 'national', 'IT', '+390612345678'],
    ['00442079460000', 'national', 'DE', '+442079460000'],
    // The country's own international prefix: 011 in the US, 0011 in Australia.
    ['011442079460000', 'national', 'US', '+442079460000'],
    ['0011442079460000', 'national', 'AU', '+442079460000'],
    ['2125551234', 'national', 'US', '+12125551234'],
    ['+999', 'national', 'DE', '+999'],
    // Not a valid number → verbatim.
    ['42', 'national', 'DE', '42'],
    ['0000', 'national', 'DE', '0000'],
    // Germany's trunk prefix 0 is required: bare digits are neither national nor international.
    ['4989123456', 'national', 'DE', '4989123456'],
    ['89123456', 'national', 'DE', '89123456'],
    ['acct-4711', 'national', 'DE', 'acct-4711'],
    // whitespace → verbatim
    ['+43 1', 'e164', 'AT', '+43 1']
  ] as const)('normalizeInbound(%s,%s,%s)', (raw, format, country, out) => {
    expect(normalizeInbound(raw, format, country)).toBe(out);
  });
});

describe('normalizeDialed', () => {
  test.each([
    ['+4989123', 'DE', { kind: 'e164', number: '+4989123' }],
    ['004989123456', 'DE', { kind: 'e164', number: '+4989123456' }],
    ['089123456', 'DE', { kind: 'e164', number: '+4989123456' }],
    ['0612345678', 'IT', { kind: 'e164', number: '+390612345678' }],
    ['2125551234', 'US', { kind: 'e164', number: '+12125551234' }],
    ['12125551234', 'US', { kind: 'e164', number: '+12125551234' }],
    ['011442079460000', 'US', { kind: 'e164', number: '+442079460000' }],
    ['42', 'DE', { kind: 'incomplete' }],
    ['89123', 'DE', { kind: 'incomplete' }],
    ['0000', 'DE', { kind: 'incomplete' }],
    ['4989123456', 'DE', { kind: 'incomplete' }],
    ['0*1', 'DE', { kind: 'incomplete' }]
  ] as const)('normalizeDialed(%s, %s)', (raw, country, out) => {
    expect(normalizeDialed(raw, country)).toEqual(out);
  });
});

describe('callingCode', () => {
  test('is the calling code of a country', () => {
    expect(callingCode('IT')).toBe('39');
  });
});
