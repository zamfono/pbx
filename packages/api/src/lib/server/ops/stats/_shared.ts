import { MS_PER_SECOND } from '@zamfono/shared';

export const METRICS = [
  'answerRate',
  'ringToAnswer',
  'avgCallLength',
  'callVolume'
] as const;
export type Metric = (typeof METRICS)[number];

export const BUCKET_UNITS = ['minute', 'hour', 'day', 'week'] as const;
export type BucketUnit = (typeof BUCKET_UNITS)[number];

const ONE_BUCKET: Record<BucketUnit, Temporal.DurationLike> = {
  minute: { minutes: 1 },
  hour: { hours: 1 },
  day: { days: 1 },
  week: { weeks: 1 }
};

/**
 * The start of the `unit` bucket `at` falls into, on the tenant clock `at` carries: the local
 * hour, local midnight or local Monday midnight (ISO week). A minute is the same in every zone.
 */
function bucketStart(
  at: Temporal.ZonedDateTime,
  unit: BucketUnit
): Temporal.ZonedDateTime {
  if (unit === 'minute') {
    return at
      .toInstant()
      .round({ smallestUnit: 'minute', roundingMode: 'floor' })
      .toZonedDateTimeISO(at.timeZoneId);
  }
  if (unit === 'hour') {
    return at.round({ smallestUnit: 'hour', roundingMode: 'floor' });
  }
  const midnight = at.startOfDay();
  return unit === 'day'
    ? midnight
    : midnight.subtract({ days: midnight.dayOfWeek - 1 }).startOfDay();
}

/**
 * The start of the `unit` bucket after the one starting at `cursor`. An hour a half-hour DST
 * change repeats lasts 90 minutes, so an hour later can still fall into it; the next bucket then
 * starts at the next local hour.
 */
function nextBucketStart(
  cursor: Temporal.ZonedDateTime,
  unit: BucketUnit
): Temporal.ZonedDateTime {
  const next = bucketStart(cursor.add(ONE_BUCKET[unit]), unit);
  if (Temporal.ZonedDateTime.compare(next, cursor) > 0) {
    return next;
  }
  const nextLocal = cursor
    .toPlainDateTime()
    .add(ONE_BUCKET[unit])
    .toZonedDateTime(cursor.timeZoneId);
  return bucketStart(nextLocal, unit);
}

/** The epoch milliseconds of the `unit` bucket start `instant` falls into in `timeZone`. */
export function bucketStartMs(
  instant: string,
  unit: BucketUnit,
  timeZone: string
): number {
  const at = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
  return bucketStart(at, unit).epochMilliseconds;
}

/**
 * The epoch milliseconds of each `unit` bucket start covering `[from, to)` in `timeZone`, the
 * first at or before `from`; at most `limit + 1` of them, so a caller can tell a range too wide
 * to materialise without laying it all out.
 */
export function bucketStarts(
  from: string,
  to: string,
  unit: BucketUnit,
  timeZone: string,
  limit: number
): number[] {
  const endMs = Date.parse(to);
  const starts: number[] = [];
  let cursor = bucketStart(
    Temporal.Instant.from(from).toZonedDateTimeISO(timeZone),
    unit
  );
  while (cursor.epochMilliseconds < endMs && starts.length <= limit) {
    starts.push(cursor.epochMilliseconds);
    cursor = nextBucketStart(cursor, unit);
  }
  return starts;
}

/** A call `stats.query` counts; `answered` as its view defines it (§10.3 "Statistics"). */
export type StatsCallRow = {
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  status: string;
  answered: boolean;
};

type AnsweredRow = StatsCallRow & { answeredAt: string; endedAt: string };

/** The mean of `durationMs` over `rows` in seconds, or `null` without rows. */
function meanSeconds(
  rows: AnsweredRow[],
  durationMs: (row: AnsweredRow) => number
): number | null {
  if (rows.length === 0) {
    return null;
  }
  const totalMs = rows.reduce((sum, row) => sum + durationMs(row), 0);
  return totalMs / rows.length / MS_PER_SECOND;
}

/**
 * §10.3 "Statistics": one metric's value over a bucket's calls, or `null` with nothing to divide.
 * `answerRate` is the answered among the answered, missed and busy; `ringToAnswer` and
 * `avgCallLength` are the mean seconds from start to answer and from answer to end of the
 * answered.
 */
export function metricValue(
  rows: StatsCallRow[],
  metric: Metric
): number | null {
  if (metric === 'callVolume') {
    return rows.length;
  }
  if (metric === 'answerRate') {
    const offered = rows.filter(row =>
      ['answered', 'missed', 'busy'].includes(row.status)
    );
    return offered.length === 0
      ? null
      : offered.filter(row => row.answered).length / offered.length;
  }
  const answered = rows.filter(
    (row): row is AnsweredRow =>
      row.answered && row.answeredAt !== null && row.endedAt !== null
  );
  return metric === 'ringToAnswer'
    ? meanSeconds(
        answered,
        row => Date.parse(row.answeredAt) - Date.parse(row.startedAt)
      )
    : meanSeconds(
        answered,
        row => Date.parse(row.endedAt) - Date.parse(row.answeredAt)
      );
}
