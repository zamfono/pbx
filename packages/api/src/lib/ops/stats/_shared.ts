export const METRICS = [
  'answerRate',
  'ringToAnswer',
  'avgCallLength',
  'callVolume'
] as const;
export type Metric = (typeof METRICS)[number];

export const BUCKET_UNITS = ['minute', 'hour', 'day', 'week'] as const;
export type BucketUnit = (typeof BUCKET_UNITS)[number];

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
const MS_PER_WEEK = DAYS_PER_WEEK * MS_PER_DAY;

const STEP_MS_BY_UNIT: Record<BucketUnit, number> = {
  minute: MS_PER_MINUTE,
  hour: MS_PER_HOUR,
  day: MS_PER_DAY,
  week: MS_PER_WEEK
};

// ISO weekday numbering (1 = Monday .. 7 = Sunday), the week-bucket's own start-of-week boundary.
const MONDAY_ISO_WEEKDAY = 1;
const SUNDAY_JS_WEEKDAY = 0;

/** `date` floored to its bucket's own boundary in UTC: the minute, hour, midnight or Monday. */
function alignedStart(date: Date, unit: BucketUnit): Date {
  const aligned = new Date(date);
  aligned.setUTCMilliseconds(0);
  aligned.setUTCSeconds(0);
  if (unit === 'minute') {
    return aligned;
  }
  aligned.setUTCMinutes(0);
  if (unit === 'hour') {
    return aligned;
  }
  aligned.setUTCHours(0, 0, 0, 0);
  if (unit === 'day') {
    return aligned;
  }
  const jsWeekday = aligned.getUTCDay();
  const isoWeekday =
    jsWeekday === SUNDAY_JS_WEEKDAY ? DAYS_PER_WEEK : jsWeekday;
  aligned.setUTCDate(aligned.getUTCDate() - (isoWeekday - MONDAY_ISO_WEEKDAY));
  return aligned;
}

export type BucketPlan = {
  starts: string[];
  stepMs: number;
  alignedStartMs: number;
};

/**
 * How many `unit` buckets `planBuckets` would lay over `[from, to)`, computed without building
 * them, so a caller can refuse a range too wide to materialise.
 */
export function bucketCount(
  from: string,
  to: string,
  unit: BucketUnit
): number {
  const stepMs = STEP_MS_BY_UNIT[unit];
  const alignedStartMs = alignedStart(new Date(from), unit).getTime();
  const endMs = new Date(to).getTime();
  return Math.max(0, Math.ceil((endMs - alignedStartMs) / stepMs));
}

/** Fixed-width `unit` buckets covering `[from, to)`, aligned to the unit's own UTC boundary. */
export function planBuckets(
  from: string,
  to: string,
  unit: BucketUnit
): BucketPlan {
  const stepMs = STEP_MS_BY_UNIT[unit];
  const alignedStartMs = alignedStart(new Date(from), unit).getTime();
  const endMs = new Date(to).getTime();
  const starts: string[] = [];
  for (let timeMs = alignedStartMs; timeMs < endMs; timeMs += stepMs) {
    starts.push(new Date(timeMs).toISOString());
  }
  return { starts, stepMs, alignedStartMs };
}

/** The index into `plan.starts` that `timestamp` falls into, which may be out of range. */
export function bucketIndex(plan: BucketPlan, timestamp: string): number {
  return Math.floor(
    (Date.parse(timestamp) - plan.alignedStartMs) / plan.stepMs
  );
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
