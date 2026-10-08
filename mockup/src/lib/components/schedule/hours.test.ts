import { describe, expect, test } from 'vitest';

import type { HoursInterval } from '#lib/api/types.js';

import {
  addRange,
  emptyWeek,
  groupWeek,
  intervalsFromWeek,
  mergeTouching,
  removeRange,
  setRange,
  validateIntervals,
  weekFromIntervals
} from './hours';

const interval = (
  weekday: number,
  opens: string,
  closes: string
): HoursInterval => ({ weekday, opens, closes });

describe('conversion', () => {
  test('round-trips intervals through the week, keeping the entered order', () => {
    const intervals = [
      interval(1, '13:00', '17:00'),
      interval(1, '08:00', '12:00'),
      interval(7, '10:00', '24:00')
    ];
    const week = weekFromIntervals(intervals);

    expect(week[1]).toEqual([
      { start: '13:00', end: '17:00' },
      { start: '08:00', end: '12:00' }
    ]);
    expect(week[7]).toEqual([{ start: '10:00', end: '24:00' }]);
    expect(intervalsFromWeek(week)).toEqual(intervals);
  });

  test('skips unknown weekdays', () => {
    const week = weekFromIntervals([interval(0, '08:00', '09:00')]);
    expect(intervalsFromWeek(week)).toEqual([]);
  });
});

describe('validateIntervals', () => {
  test('accepts a valid week, including 24:00 and touching intervals', () => {
    expect(
      validateIntervals([
        interval(1, '08:00', '12:00'),
        interval(1, '12:00', '17:00'),
        interval(6, '00:00', '24:00')
      ])
    ).toBeUndefined();
    expect(validateIntervals([])).toBeUndefined();
  });

  test('rejects malformed times; 24:00 only closes', () => {
    expect(validateIntervals([interval(2, '8:00', '12:00')])).toEqual({
      weekday: 2,
      code: 'schedule.error.invalidTime'
    });
    expect(validateIntervals([interval(3, '24:00', '24:00')])).toEqual({
      weekday: 3,
      code: 'schedule.error.invalidTime'
    });
    expect(validateIntervals([interval(3, '10:00', '24:30')])).toEqual({
      weekday: 3,
      code: 'schedule.error.invalidTime'
    });
    expect(validateIntervals([interval(3, '10:00', '')])).toEqual({
      weekday: 3,
      code: 'schedule.error.invalidTime'
    });
  });

  test('rejects an end at or before the start', () => {
    expect(validateIntervals([interval(4, '17:00', '09:00')])).toEqual({
      weekday: 4,
      code: 'schedule.error.endBeforeStart'
    });
    expect(validateIntervals([interval(4, '09:00', '09:00')])).toEqual({
      weekday: 4,
      code: 'schedule.error.endBeforeStart'
    });
  });

  test('rejects overlaps, whatever the order of the intervals', () => {
    expect(
      validateIntervals([
        interval(5, '13:00', '17:00'),
        interval(5, '08:00', '13:30')
      ])
    ).toEqual({ weekday: 5, code: 'schedule.error.overlap' });
  });

  test('rejects a repeated (weekday, opens)', () => {
    expect(
      validateIntervals([
        interval(1, '09:00', '10:00'),
        interval(1, '09:00', '12:00')
      ])
    ).toEqual({ weekday: 1, code: 'schedule.error.overlap' });
    expect(
      validateIntervals([
        interval(1, '09:00', '10:00'),
        interval(2, '09:00', '10:00')
      ])
    ).toBeUndefined();
  });

  test('reports the first broken day, Monday first', () => {
    expect(
      validateIntervals([
        interval(7, '10:00', '09:00'),
        interval(2, 'xx', '10:00')
      ])
    ).toEqual({ weekday: 2, code: 'schedule.error.invalidTime' });
  });

  test('rejects an unknown weekday', () => {
    expect(validateIntervals([interval(8, '09:00', '10:00')])).toEqual({
      weekday: 8,
      code: 'schedule.error.invalidWeekday'
    });
  });
});

describe('mergeTouching', () => {
  test('joins touching intervals and sorts each day', () => {
    expect(
      mergeTouching([
        interval(2, '13:00', '17:00'),
        interval(1, '12:00', '24:00'),
        interval(1, '08:00', '12:00'),
        interval(2, '08:00', '12:00')
      ])
    ).toEqual([
      interval(1, '08:00', '24:00'),
      interval(2, '08:00', '12:00'),
      interval(2, '13:00', '17:00')
    ]);
  });

  test('keeps a contained interval inside its container', () => {
    expect(
      mergeTouching([
        interval(1, '08:00', '18:00'),
        interval(1, '09:00', '10:00')
      ])
    ).toEqual([interval(1, '08:00', '18:00')]);
  });

  test('leaves the input untouched', () => {
    const input = [
      interval(1, '08:00', '12:00'),
      interval(1, '12:00', '13:00')
    ];
    mergeTouching(input);
    expect(input[0]).toEqual(interval(1, '08:00', '12:00'));
  });
});

describe('range edits', () => {
  test('adds 09:00–17:00 to an empty day, else the hour after the latest end', () => {
    const week = addRange(emptyWeek(), 1);
    expect(week[1]).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(addRange(week, 1)[1]).toEqual([
      { start: '09:00', end: '17:00' },
      { start: '17:00', end: '18:00' }
    ]);
  });

  test('cuts an added range at 24:00', () => {
    const week = weekFromIntervals([interval(1, '10:00', '23:30')]);
    expect(addRange(week, 1)[1].at(-1)).toEqual({
      start: '23:30',
      end: '24:00'
    });
  });

  test('sets and removes a range by index', () => {
    const week = weekFromIntervals([
      interval(3, '08:00', '12:00'),
      interval(3, '13:00', '17:00')
    ]);
    expect(setRange(week, 3, 1, { end: '24:00' })[3]).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '13:00', end: '24:00' }
    ]);
    expect(removeRange(week, 3, 0)[3]).toEqual([
      { start: '13:00', end: '17:00' }
    ]);
  });
});

describe('groupWeek', () => {
  test('groups consecutive days with identical hours', () => {
    const split = (weekday: number): HoursInterval[] => [
      interval(weekday, '08:00', '12:30'),
      interval(weekday, '13:30', '17:30')
    ];
    const groups = groupWeek([
      ...split(1),
      ...split(2),
      ...split(3),
      ...split(4),
      interval(5, '08:00', '14:00'),
      interval(7, '08:00', '14:00')
    ]);

    expect(groups).toEqual([
      {
        from: 1,
        to: 4,
        ranges: [
          { start: '08:00', end: '12:30' },
          { start: '13:30', end: '17:30' }
        ]
      },
      { from: 5, to: 5, ranges: [{ start: '08:00', end: '14:00' }] },
      { from: 7, to: 7, ranges: [{ start: '08:00', end: '14:00' }] }
    ]);
  });

  test('treats touching intervals like their merged form', () => {
    expect(
      groupWeek([
        interval(1, '08:00', '17:00'),
        interval(2, '08:00', '12:00'),
        interval(2, '12:00', '17:00')
      ])
    ).toEqual([{ from: 1, to: 2, ranges: [{ start: '08:00', end: '17:00' }] }]);
  });
});
