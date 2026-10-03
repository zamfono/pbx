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
    cursor = bucketStart(cursor.add(ONE_BUCKET[unit]), unit);
  }
  return starts;
}

export type StatsCallRow = {
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  status: string;
};

/** §10.3 "Statistics": one metric's value over a bucket's calls, or `null` with nothing to divide. */
export function metricValue(
  rows: StatsCallRow[],
  metric: Metric
): number | null {
  if (metric === 'callVolume') {
    return rows.length;
  }
  if (metric === 'answerRate') {
    const answered = rows.filter(row => row.status === 'answered').length;
    const missed = rows.filter(row => row.status === 'missed').length;
    const busy = rows.filter(row => row.status === 'busy').length;
    const denominator = answered + missed + busy;
    return denominator === 0 ? null : answered / denominator;
  }
  if (metric === 'ringToAnswer') {
    const answered = rows.filter(
      (row): row is StatsCallRow & { answeredAt: string } =>
        row.answeredAt !== null
    );
    if (answered.length === 0) {
      return null;
    }
    const totalMs = answered.reduce(
      (sum, row) =>
        sum + (Date.parse(row.answeredAt) - Date.parse(row.startedAt)),
      0
    );
    return totalMs / answered.length / MS_PER_SECOND;
  }
  const finished = rows.filter(
    (row): row is StatsCallRow & { answeredAt: string; endedAt: string } =>
      row.answeredAt !== null && row.endedAt !== null
  );
  if (finished.length === 0) {
    return null;
  }
  const totalMs = finished.reduce(
    (sum, row) => sum + (Date.parse(row.endedAt) - Date.parse(row.answeredAt)),
    0
  );
  return totalMs / finished.length / MS_PER_SECOND;
}
