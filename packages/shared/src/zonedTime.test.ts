import { describe, expect, it } from 'vitest';

import {
  addDays,
  localParts,
  MINUTES_PER_HOUR,
  parseTimeOfDay,
  weekdayAt,
  zonedTimeToInstant
} from './zonedTime.js';

const NINE_AM = 9 * MINUTES_PER_HOUR;
const END_OF_DAY = 1440;

describe('localParts', () => {
  it('reads the wall-clock date, weekday and time of an instant in a zone', () => {
    // 2026-03-30T07:30Z is Monday 09:30 CEST.
    expect(
      localParts(Date.parse('2026-03-30T07:30:00.000Z'), 'Europe/Berlin')
    ).toEqual({
      year: 2026,
      month: 3,
      day: 30,
      weekday: 1,
      hour: 9,
      minute: 30
    });
  });

  it('reads midnight as hour 0, not 24', () => {
    // 2026-01-04 is a Sunday.
    expect(localParts(Date.parse('2026-01-04T00:00:00.000Z'), 'UTC')).toEqual({
      year: 2026,
      month: 1,
      day: 4,
      weekday: 7,
      hour: 0,
      minute: 0
    });
  });
});

describe('parseTimeOfDay', () => {
  it.each([
    ['00:00', 0],
    ['09:30', 570],
    ['24:00', END_OF_DAY]
  ])('parses %s to %i minutes', (value, minutes) => {
    expect(parseTimeOfDay(value)).toBe(minutes);
  });
});

describe('zonedTimeToInstant', () => {
  it('converts a wall-clock time on either side of a DST transition', () => {
    // 09:00 CET (UTC+1) on the Friday before, 09:00 CEST (UTC+2) on the Monday after.
    expect(
      new Date(
        zonedTimeToInstant(2026, 3, 27, NINE_AM, 'Europe/Berlin')
      ).toISOString()
    ).toBe('2026-03-27T08:00:00.000Z');
    expect(
      new Date(
        zonedTimeToInstant(2026, 3, 30, NINE_AM, 'Europe/Berlin')
      ).toISOString()
    ).toBe('2026-03-30T07:00:00.000Z');
  });

  it.each([
    // Europe/Berlin: 02:00-03:00 is skipped on 2026-03-29 and repeated on 2026-10-25.
    ['Europe/Berlin', '2026-03-29', '02:30', '2026-03-29T00:30:00.000Z'],
    ['Europe/Berlin', '2026-10-25', '02:30', '2026-10-25T00:30:00.000Z'],
    // America/New_York: 02:00-03:00 is skipped on 2026-03-08, 01:00-02:00 repeated on 2026-11-01.
    ['America/New_York', '2026-03-08', '02:30', '2026-03-08T06:30:00.000Z'],
    ['America/New_York', '2026-11-01', '01:30', '2026-11-01T05:30:00.000Z']
  ])(
    'takes the earlier instant where DST skips or repeats the local time: %s %s %s',
    (timeZone, date, time, instant) => {
      const day = new Date(date);
      expect(
        new Date(
          zonedTimeToInstant(
            day.getUTCFullYear(),
            day.getUTCMonth() + 1,
            day.getUTCDate(),
            parseTimeOfDay(time),
            timeZone
          )
        ).toISOString()
      ).toBe(instant);
    }
  );

  it('rolls 24:00 over to the next midnight', () => {
    expect(
      new Date(
        zonedTimeToInstant(2026, 12, 31, END_OF_DAY, 'UTC')
      ).toISOString()
    ).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('addDays', () => {
  it('shifts across a year end and back across a month end', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1
    });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28
    });
  });
});

describe('weekdayAt', () => {
  it('wraps forwards past Sunday and backwards past Monday', () => {
    expect(weekdayAt(7, 1)).toBe(1);
    expect(weekdayAt(1, -1)).toBe(7);
    expect(weekdayAt(3, 14)).toBe(3);
  });
});
