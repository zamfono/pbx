/**
 * Pure geometry of the schedule week grid: the time axis, snapping, and the clamping that keeps
 * every drag result valid. Ranges stay inside the axis, at least one snap step long, and never
 * overlap another range of their day; touching one is allowed, since touching intervals are
 * joined before saving (`mergeTouching`).
 *
 * All positions are minutes since midnight, `24:00` = 1440. Ranges cross the boundary as `HH:MM`
 * strings; a string no time input produces (e.g. an emptied field) parses to `undefined` and is
 * ignored by the axis and by the neighbour clamping.
 */
import {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  minutesToTime,
  timeToMinutes,
  WEEKDAYS,
  type DayRange,
  type Week
} from './hours';

export {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  minutesToTime,
  timeToMinutes,
  withRange
} from './hours';

export const SNAP_MINUTES = 15;

const DEFAULT_AXIS_START = 6 * MINUTES_PER_HOUR;
const DEFAULT_AXIS_END = 20 * MINUTES_PER_HOUR;

export type GridBounds = { start: number; end: number };

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

export const snapToGrid = (minutes: number): number =>
  Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;

/** The axis in whole hours: 06:00–20:00, extended to contain every parsable range. */
export const gridBounds = (week: Week): GridBounds => {
  let start = DEFAULT_AXIS_START;
  let end = DEFAULT_AXIS_END;

  for (const weekday of WEEKDAYS) {
    for (const range of week[weekday]) {
      const rangeStart = timeToMinutes(range.start);
      const rangeEnd = timeToMinutes(range.end);

      if (rangeStart !== undefined) {
        start = Math.min(
          start,
          Math.floor(rangeStart / MINUTES_PER_HOUR) * MINUTES_PER_HOUR
        );
      }
      if (rangeEnd !== undefined) {
        end = Math.max(
          end,
          Math.ceil(rangeEnd / MINUTES_PER_HOUR) * MINUTES_PER_HOUR
        );
      }
    }
  }

  const clampedEnd = clamp(end, 0, MINUTES_PER_DAY);
  return { start: clamp(start, 0, clampedEnd), end: clampedEnd };
};

/**
 * The closest end before and the closest start after the range at `index`, by time: the day's
 * ranges keep the order they were entered in, so the list neighbours need not be the time ones.
 */
const neighbours = (
  ranges: DayRange[],
  index: number,
  start: number,
  end: number
): { previousEnd: number | undefined; nextStart: number | undefined } => {
  let previousEnd: number | undefined;
  let nextStart: number | undefined;

  ranges.forEach((other, position) => {
    if (position === index) {
      return;
    }
    const otherStart = timeToMinutes(other.start);
    const otherEnd = timeToMinutes(other.end);
    if (otherEnd !== undefined && otherEnd <= start) {
      previousEnd = Math.max(previousEnd ?? otherEnd, otherEnd);
    }
    if (otherStart !== undefined && otherStart >= end) {
      nextStart = Math.min(nextStart ?? otherStart, otherStart);
    }
  });

  return { previousEnd, nextStart };
};

/** The moved range, duration kept, clamped between its neighbours and the axis. */
export const movedRange = (
  ranges: DayRange[],
  index: number,
  desiredStart: number,
  bounds: GridBounds
): DayRange | undefined => {
  const range = ranges[index];
  if (range === undefined) {
    return undefined;
  }
  const start = timeToMinutes(range.start);
  const end = timeToMinutes(range.end);

  if (start === undefined || end === undefined || end <= start) {
    return range;
  }

  const duration = end - start;
  const { previousEnd, nextStart } = neighbours(ranges, index, start, end);
  const low = previousEnd ?? bounds.start;
  const high = (nextStart ?? bounds.end) - duration;

  if (high < low) {
    return range;
  }

  const newStart = clamp(snapToGrid(desiredStart), low, high);
  return {
    start: minutesToTime(newStart),
    end: minutesToTime(newStart + duration)
  };
};

/**
 * The resized range: one edge follows the pointer, clamped so the range keeps a snap step of
 * length and never overlaps a neighbour. The end edge reaches `24:00` once the axis does.
 */
export const resizedRange = (
  ranges: DayRange[],
  index: number,
  edge: 'start' | 'end',
  desired: number,
  bounds: GridBounds
): DayRange | undefined => {
  const range = ranges[index];
  if (range === undefined) {
    return undefined;
  }
  const start = timeToMinutes(range.start);
  const end = timeToMinutes(range.end);

  if (start === undefined || end === undefined) {
    return range;
  }

  const { previousEnd, nextStart } = neighbours(ranges, index, start, end);

  if (edge === 'start') {
    const low = previousEnd ?? bounds.start;
    const high = end - SNAP_MINUTES;
    if (high < low) {
      return range;
    }
    return {
      start: minutesToTime(clamp(snapToGrid(desired), low, high)),
      end: range.end
    };
  }

  const low = start + SNAP_MINUTES;
  const high = nextStart ?? bounds.end;
  if (high < low) {
    return range;
  }
  return {
    start: range.start,
    end: minutesToTime(clamp(snapToGrid(desired), low, high))
  };
};

/** The gap around `anchor` that a new range may occupy, or `undefined` inside an existing one. */
const freeInterval = (
  ranges: DayRange[],
  anchor: number,
  bounds: GridBounds
): { low: number; high: number } | undefined => {
  let low = bounds.start;
  let high = bounds.end;

  for (const range of ranges) {
    const start = timeToMinutes(range.start);
    const end = timeToMinutes(range.end);

    if (start === undefined || end === undefined) {
      continue;
    }
    if (anchor >= start && anchor < end) {
      return undefined;
    }
    if (end <= anchor) {
      low = Math.max(low, end);
    }
    if (start > anchor) {
      high = Math.min(high, start);
    }
  }

  return low < high ? { low, high } : undefined;
};

const placedRange = (
  ranges: DayRange[],
  anchor: number,
  start: number,
  end: number,
  bounds: GridBounds
): DayRange | undefined => {
  const interval = freeInterval(ranges, anchor, bounds);
  if (interval === undefined) {
    return undefined;
  }

  const placedStart = Math.max(start, interval.low);
  const placedEnd = Math.min(end, interval.high);
  if (placedEnd - placedStart < SNAP_MINUTES) {
    return undefined;
  }

  return { start: minutesToTime(placedStart), end: minutesToTime(placedEnd) };
};

/**
 * The range a press-and-drag from `anchor` to `current` draws, clipped to the free gap the drag
 * started in.
 */
export const drawnRange = (
  ranges: DayRange[],
  anchor: number,
  current: number,
  bounds: GridBounds
): DayRange | undefined => {
  const snappedAnchor = snapToGrid(anchor);
  const snappedCurrent = snapToGrid(current);
  const start = Math.min(snappedAnchor, snappedCurrent);
  let end = Math.max(snappedAnchor, snappedCurrent);

  if (end === start) {
    end = start + SNAP_MINUTES;
  }

  return placedRange(ranges, snappedAnchor, start, end, bounds);
};

/** The one-hour range a plain click at `at` creates, shortened to fit the free gap around it. */
export const clickedRange = (
  ranges: DayRange[],
  at: number,
  bounds: GridBounds
): DayRange | undefined => {
  const anchor = clamp(at, bounds.start, bounds.end);
  const start = Math.floor(anchor / SNAP_MINUTES) * SNAP_MINUTES;

  return placedRange(ranges, anchor, start, start + MINUTES_PER_HOUR, bounds);
};

/**
 * Where a range sits on the axis, in percent. An unparsable edge falls back to a one-hour block,
 * so the range stays visible and clickable while the validation names the problem.
 */
export const rangeGeometry = (
  range: DayRange,
  bounds: GridBounds
): { topPercent: number; heightPercent: number } => {
  const span = bounds.end - bounds.start;
  let start = timeToMinutes(range.start);
  let end = timeToMinutes(range.end);

  start ??= end === undefined ? bounds.start : end - MINUTES_PER_HOUR;
  if (end === undefined || end <= start) {
    end = start + MINUTES_PER_HOUR;
  }

  const clampedStart = clamp(start, bounds.start, bounds.end - SNAP_MINUTES);
  const clampedEnd = clamp(end, clampedStart + SNAP_MINUTES, bounds.end);

  return {
    topPercent: ((clampedStart - bounds.start) / span) * 100,
    heightPercent: ((clampedEnd - clampedStart) / span) * 100
  };
};
