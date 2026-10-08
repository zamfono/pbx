import { describe, expect, test } from 'vitest';

import {
  clickedRange,
  drawnRange,
  gridBounds,
  minutesToTime,
  movedRange,
  rangeGeometry,
  resizedRange,
  snapToGrid,
  timeToMinutes,
  withRange
} from './grid';
import { weekFromIntervals, type DayRange, type Week } from './hours';

const bounds = { start: 6 * 60, end: 20 * 60 };
const fullDay = { start: 0, end: 24 * 60 };
const range = (start: string, end: string): DayRange => ({ start, end });
const minutes = (time: string): number => timeToMinutes(time) ?? Number.NaN;

const officeWeek = (): Week =>
  weekFromIntervals(
    [1, 2, 3, 4, 5].map(weekday => ({
      weekday,
      opens: '09:00',
      closes: '17:00'
    }))
  );

describe('time conversion', () => {
  test('converts between times and minutes', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('')).toBeUndefined();
    expect(timeToMinutes('24:01')).toBeUndefined();
    expect(minutesToTime(570)).toBe('09:30');
    expect(minutesToTime(-10)).toBe('00:00');
  });

  test('24:00 is the end of the day', () => {
    expect(timeToMinutes('24:00')).toBe(1440);
    expect(minutesToTime(1440)).toBe('24:00');
    expect(minutesToTime(2000)).toBe('24:00');
  });

  test('snaps to the 15-minute grid', () => {
    expect(snapToGrid(547)).toBe(540);
    expect(snapToGrid(553)).toBe(555);
  });
});

describe('axis', () => {
  test('defaults to 06:00–20:00 and extends to contain ranges', () => {
    expect(gridBounds(officeWeek())).toEqual(bounds);

    const late = withRange(officeWeek(), 1, range('21:15', '22:30'));
    expect(gridBounds(late)).toEqual({ start: 6 * 60, end: 23 * 60 });
  });

  test('reaches 24:00 for a range closing at midnight', () => {
    const open = withRange(officeWeek(), 6, range('18:00', '24:00'));
    expect(gridBounds(open)).toEqual({ start: 6 * 60, end: 24 * 60 });
  });
});

describe('moving', () => {
  test('keeps the duration and clamps against neighbours and the axis', () => {
    const ranges = [range('09:00', '12:00'), range('13:00', '17:00')];

    expect(movedRange(ranges, 0, minutes('08:07'), bounds)).toEqual(
      range('08:00', '11:00')
    );
    expect(movedRange(ranges, 0, minutes('11:00'), bounds)).toEqual(
      range('10:00', '13:00')
    );
    expect(movedRange(ranges, 0, 0, bounds)).toEqual(range('06:00', '09:00'));
  });

  test('clamps against the neighbour in time, whatever the list order', () => {
    const ranges = [range('13:00', '17:00'), range('09:00', '12:00')];

    expect(movedRange(ranges, 1, minutes('11:00'), bounds)).toEqual(
      range('10:00', '13:00')
    );
  });

  test('can push a range up to 24:00', () => {
    expect(
      movedRange([range('20:00', '22:00')], 0, minutes('23:30'), fullDay)
    ).toEqual(range('22:00', '24:00'));
  });
});

describe('resizing', () => {
  test('keeps a minimum length and the neighbour gap', () => {
    const ranges = [range('09:00', '12:00'), range('13:00', '17:00')];

    expect(resizedRange(ranges, 0, 'end', minutes('14:00'), bounds)).toEqual(
      range('09:00', '13:00')
    );
    expect(resizedRange(ranges, 0, 'end', 0, bounds)).toEqual(
      range('09:00', '09:15')
    );
    expect(resizedRange(ranges, 1, 'start', minutes('11:00'), bounds)).toEqual(
      range('12:00', '17:00')
    );
  });

  test('snaps the end edge to 24:00 at the end of a full-day axis', () => {
    expect(
      resizedRange([range('18:00', '22:00')], 0, 'end', 1435, fullDay)
    ).toEqual(range('18:00', '24:00'));
    expect(
      resizedRange([range('18:00', '22:00')], 0, 'end', 1500, fullDay)
    ).toEqual(range('18:00', '24:00'));
  });
});

describe('drawing', () => {
  test('clips to the free gap the drag started in', () => {
    const ranges = [range('09:00', '12:00')];

    expect(
      drawnRange(ranges, minutes('13:00'), minutes('15:07'), bounds)
    ).toEqual(range('13:00', '15:00'));
    expect(drawnRange(ranges, minutes('14:00'), 0, bounds)).toEqual(
      range('12:00', '14:00')
    );
    expect(
      drawnRange(ranges, minutes('10:00'), minutes('11:00'), bounds)
    ).toBeUndefined();
  });

  test('draws up to 24:00', () => {
    expect(drawnRange([], minutes('22:00'), 1440, fullDay)).toEqual(
      range('22:00', '24:00')
    );
  });

  test('a plain click creates an hour, shortened to fit the gap', () => {
    const ranges = [range('09:00', '12:00'), range('13:00', '17:00')];

    expect(clickedRange(ranges, minutes('12:20'), bounds)).toEqual(
      range('12:15', '13:00')
    );
    expect(clickedRange(ranges, minutes('10:00'), bounds)).toBeUndefined();
    expect(clickedRange([], minutes('23:40'), fullDay)).toEqual(
      range('23:30', '24:00')
    );
  });
});

test('withRange keeps the day sorted by start', () => {
  const week = withRange(
    withRange(officeWeek(), 6, range('14:00', '15:00')),
    6,
    range('08:00', '09:00')
  );

  expect(week[6]).toEqual([range('08:00', '09:00'), range('14:00', '15:00')]);
});

test('geometry places unparsable ranges as a visible fallback block', () => {
  expect(rangeGeometry(range('09:00', '12:00'), bounds)).toEqual({
    topPercent: (180 / 840) * 100,
    heightPercent: (180 / 840) * 100
  });

  const broken = rangeGeometry(range('', ''), bounds);
  expect(broken.topPercent).toBe(0);
  expect(broken.heightPercent).toBeGreaterThan(0);

  expect(rangeGeometry(range('12:00', '24:00'), fullDay)).toEqual({
    topPercent: 50,
    heightPercent: 50
  });
});
