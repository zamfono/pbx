import { describe, expect, it } from 'vitest';

import { closedPeriods, parseTimeOfDay } from './openingHours.js';
import { MS_PER_HOUR } from './time.js';

const weekdayHoursSchedule = {
  intervals: [1, 2, 3, 4, 5].map(weekday => ({
    weekday,
    opens: '09:00',
    closes: '17:00'
  }))
};

const hoursOf = (period: { start: string; end: string }): number =>
  (Date.parse(period.end) - Date.parse(period.start)) / MS_PER_HOUR;

describe('parseTimeOfDay', () => {
  it.each([
    ['00:00', 0],
    ['09:30', 570],
    ['24:00', 1440]
  ])('parses %s to %i minutes', (value, minutes) => {
    expect(parseTimeOfDay(value)).toBe(minutes);
  });
});

describe('closedPeriods', () => {
  it('contains one weekend period of at least 63 hours for a Mon-Fri 9-17 schedule', () => {
    // 2026-03-18T00:00Z is a Wednesday, still CET (before the March DST transition).
    const periods = closedPeriods(
      weekdayHoursSchedule,
      '2026-03-18T00:00:00.000Z',
      7,
      'Europe/Berlin'
    );

    const MIN_WEEKEND_HOURS = 63;
    const longPeriods = periods.filter(
      period => hoursOf(period) >= MIN_WEEKEND_HOURS
    );

    expect(longPeriods).toHaveLength(1);
  });

  it('shortens the weekend across the spring-forward night by the lost hour', () => {
    // Fri 2026-03-27 17:00 CET (16:00Z) to Mon 2026-03-30 09:00 CEST (07:00Z): 64 wall-clock
    // hours, 63 elapsed, since 02:00-03:00 on the Sunday never happens.
    const periods = closedPeriods(
      weekdayHoursSchedule,
      '2026-03-27T12:00:00.000Z',
      4,
      'Europe/Berlin'
    );

    expect(periods).toContainEqual({
      start: '2026-03-27T16:00:00.000Z',
      end: '2026-03-30T07:00:00.000Z'
    });
  });

  it('is the whole window for a schedule with no intervals', () => {
    expect(
      closedPeriods({ intervals: [] }, '2026-01-05T00:00:00.000Z', 1, 'UTC')
    ).toEqual([
      { start: '2026-01-05T00:00:00.000Z', end: '2026-01-06T00:00:00.000Z' }
    ]);
  });

  it('merges an interval running to 24:00 with the next day opening at 00:00', () => {
    const schedule = {
      intervals: [
        { weekday: 1, opens: '20:00', closes: '24:00' },
        { weekday: 2, opens: '00:00', closes: '02:00' }
      ]
    };

    // 2026-01-05 is a Monday.
    expect(
      closedPeriods(schedule, '2026-01-05T00:00:00.000Z', 2, 'UTC')
    ).toEqual([
      { start: '2026-01-05T00:00:00.000Z', end: '2026-01-05T20:00:00.000Z' },
      { start: '2026-01-06T02:00:00.000Z', end: '2026-01-07T00:00:00.000Z' }
    ]);
  });

  it.each([
    // Europe/Berlin: 02:00-03:00 is skipped on 2026-03-29 and repeated on 2026-10-25.
    ['Europe/Berlin', '2026-03-29', '02:30', '2026-03-29T00:30:00.000Z'],
    ['Europe/Berlin', '2026-10-25', '02:30', '2026-10-25T00:30:00.000Z'],
    // America/New_York: 02:00-03:00 is skipped on 2026-03-08, 01:00-02:00 repeated on 2026-11-01.
    ['America/New_York', '2026-03-08', '02:30', '2026-03-08T06:30:00.000Z'],
    ['America/New_York', '2026-11-01', '01:30', '2026-11-01T05:30:00.000Z']
  ])(
    'opens at the earlier instant where DST skips or repeats the local time: %s %s %s',
    (timeZone, date, opens, instant) => {
      // Each date is a Sunday; the window starts before the opening time on that zone's clock.
      const from = `${date}T00:00:00.000Z`;
      const schedule = { intervals: [{ weekday: 7, opens, closes: '12:00' }] };

      expect(closedPeriods(schedule, from, 1, timeZone)[0]).toEqual({
        start: from,
        end: instant
      });
    }
  );
});
