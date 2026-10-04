import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTestDb, seedSettings } from '#testing/testDb.js';

import {
  instantInput,
  tenantInstantReader,
  toStoredEnd,
  toStoredInstant
} from './instantInput.js';

describe('instantInput', () => {
  it.each([
    ['2026-10-01T12:00:00+02:00', '2026-10-01T10:00:00.000Z'],
    ['2026-10-01T12:00:00-05:30', '2026-10-01T17:30:00.000Z'],
    ['2026-10-01T12:00:00Z', '2026-10-01T12:00:00.000Z'],
    ['2026-10-01T12:00Z', '2026-10-01T12:00:00.000Z'],
    ['2026-10-01T12:00+02:00', '2026-10-01T10:00:00.000Z'],
    ['2026-10-01T12:00:00.5Z', '2026-10-01T12:00:00.500Z'],
    ['2026-10-01T12:00:00.123Z', '2026-10-01T12:00:00.123Z'],
    ['2026-10-01T12:00:00', '2026-10-01T10:00:00.000Z'],
    ['2026-10-01T12:00:00.250', '2026-10-01T10:00:00.250Z'],
    ['2026-10-01T12:00', '2026-10-01T10:00:00.000Z'],
    ['2026-10-01', '2026-09-30T22:00:00.000Z'],
    ['2026-01-15T12:00', '2026-01-15T11:00:00.000Z'],
    ['2026-01-15', '2026-01-14T23:00:00.000Z']
  ])('accepts %s and stores it, in Europe/Berlin, as %s', (value, stored) => {
    expect(instantInput.safeParse(value).success).toBe(true);
    expect(toStoredInstant(value, 'Europe/Berlin')).toBe(stored);
  });

  it.each([
    ['2026-10-01T12:00:00', 'UTC', '2026-10-01T12:00:00.000Z'],
    ['2026-10-01', 'UTC', '2026-10-01T00:00:00.000Z'],
    ['2026-10-01T12:00', 'America/New_York', '2026-10-01T16:00:00.000Z'],
    ['2026-10-01', 'Asia/Kolkata', '2026-09-30T18:30:00.000Z'],
    ['2026-10-01T12:00:00Z', 'Asia/Kolkata', '2026-10-01T12:00:00.000Z']
  ])('reads %s in %s as %s', (value, timeZone, stored) => {
    expect(toStoredInstant(value, timeZone)).toBe(stored);
  });

  it.each([
    // 02:00-03:00 does not exist on 2026-03-29: read with +02:00, the earlier of the two.
    ['2026-03-29T02:00', '2026-03-29T00:00:00.000Z'],
    ['2026-03-29T02:30', '2026-03-29T00:30:00.000Z'],
    ['2026-03-29T01:59:59.999', '2026-03-29T00:59:59.999Z'],
    ['2026-03-29T03:00', '2026-03-29T01:00:00.000Z'],
    // 02:00-03:00 occurs twice on 2026-10-25: its first occurrence, still on +02:00.
    ['2026-10-25T02:00', '2026-10-25T00:00:00.000Z'],
    ['2026-10-25T02:30', '2026-10-25T00:30:00.000Z'],
    ['2026-10-25T02:59:59.999', '2026-10-25T00:59:59.999Z'],
    ['2026-10-25T03:00', '2026-10-25T02:00:00.000Z'],
    ['2026-10-25T01:59', '2026-10-24T23:59:00.000Z']
  ])(
    'takes the earlier instant across a Europe/Berlin DST change: %s is %s',
    (value, stored) => {
      expect(toStoredInstant(value, 'Europe/Berlin')).toBe(stored);
    }
  );

  it.each([
    'yesterday',
    '',
    '2026-10-01 12:00:00Z',
    '2026-10-01T12:00:00 02:00',
    '2026-10-01T12:00:00+0200',
    '2026-02-30T00:00:00Z',
    '2026-02-30',
    '2026-10-01T25:00',
    '2026-10-01T12:00:00.1234567891Z',
    '2026-10-01T12:00:00Z[Europe/Berlin]',
    '2026-10-01+02:00',
    '2026-10',
    '1790850856445'
  ])('rejects %j', value => {
    expect(instantInput.safeParse(value).success).toBe(false);
  });
});

describe('toStoredEnd', () => {
  it.each([
    ['2026-10-01', 'Europe/Berlin', '2026-10-01T22:00:00.000Z'],
    ['2026-10-25', 'Europe/Berlin', '2026-10-25T23:00:00.000Z'],
    ['2026-10-01T12:00', 'Europe/Berlin', '2026-10-01T10:00:00.000Z'],
    ['2026-10-01T12:00Z', 'Europe/Berlin', '2026-10-01T12:00:00.000Z']
  ])(
    'ends the range %s in %s, exclusive, at %s: a date alone at the next midnight',
    (value, timeZone, end) => {
      expect(toStoredEnd(value, timeZone)).toBe(end);
    }
  );
});

describe('tenantInstantReader', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads in settings.timezone, and in UTC while it and the stack's TZ are unset", async () => {
    vi.stubEnv('TZ', undefined);
    const unsetDb = await makeTestDb();
    await seedSettings(unsetDb);
    const viennaDb = await makeTestDb();
    await seedSettings(viennaDb, { timezone: 'Europe/Vienna' });

    const unset = await tenantInstantReader(unsetDb);
    const vienna = await tenantInstantReader(viennaDb);

    expect(unset.start('2026-10-01T12:00')).toBe('2026-10-01T12:00:00.000Z');
    expect(vienna.start('2026-10-01T12:00')).toBe('2026-10-01T10:00:00.000Z');
    expect(vienna.start('2026-10-01T12:00Z')).toBe('2026-10-01T12:00:00.000Z');
    expect(vienna.end('2026-10-01')).toBe('2026-10-01T22:00:00.000Z');
  });
});
