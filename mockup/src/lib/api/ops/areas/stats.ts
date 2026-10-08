/**
 * Statistics (`ops/stats/`, §10.3 "Statistics", admin): one metric bucketed over `[from, to)` by
 * the call's start, buckets aligned to the tenant clock (local hour, midnight, Monday). Without a
 * ring group each call counts once as its top-level row, answered when its status is `answered`;
 * with one, every offer to that group counts, answered when a member took it.
 */
import { invalid } from '../../errors';
import type { Call } from '../../types';
import { defineOp } from '../core';
import { requireInstant, tenantZone, zonedParts, zonedToUtc } from './calls';

export const METRICS = [
  'answerRate',
  'ringToAnswer',
  'avgCallLength',
  'callVolume'
] as const;
export type Metric = (typeof METRICS)[number];
export const BUCKET_UNITS = ['minute', 'hour', 'day', 'week'] as const;
export type BucketUnit = (typeof BUCKET_UNITS)[number];

export type StatsInput = {
  metric: Metric;
  from: string;
  to: string;
  bucket: BucketUnit;
  ringGroupId?: string;
};
export type StatsBucket = { start: string; value: number | null };

const MAX_BUCKETS = 10_080;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The start of the `unit` bucket instant `ms` falls into, on the clock of `timeZone`. */
export function bucketStart(
  ms: number,
  unit: BucketUnit,
  timeZone: string
): number {
  if (unit === 'minute') {
    return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  }
  const p = zonedParts(ms, timeZone);
  if (unit === 'hour') {
    return zonedToUtc(timeZone, p.year, p.month, p.day, p.hour);
  }
  return zonedToUtc(
    timeZone,
    p.year,
    p.month,
    p.day - (unit === 'week' ? p.weekday - 1 : 0)
  );
}

function nextBucket(start: number, unit: BucketUnit, timeZone: string): number {
  if (unit === 'minute') {
    return start + MINUTE_MS;
  }
  const p = zonedParts(start, timeZone);
  const next =
    unit === 'hour'
      ? zonedToUtc(timeZone, p.year, p.month, p.day, p.hour + 1)
      : zonedToUtc(
          timeZone,
          p.year,
          p.month,
          p.day + (unit === 'week' ? 7 : 1)
        );
  // A repeated hour at a DST change: the next bucket is the next real hour.
  return next > start ? next : start + HOUR_MS;
}

/** One metric's value over a bucket's calls, or null with nothing to divide (§10.3). */
export function metricValue(
  rows: { call: Call; answered: boolean }[],
  metric: Metric
): number | null {
  if (metric === 'callVolume') {
    return rows.length;
  }
  if (metric === 'answerRate') {
    const offered = rows.filter(row =>
      ['answered', 'missed', 'busy'].includes(row.call.status)
    );
    return offered.length === 0
      ? null
      : offered.filter(row => row.answered).length / offered.length;
  }
  const answered = rows.filter(
    row =>
      row.answered && row.call.answeredAt !== null && row.call.endedAt !== null
  );
  if (answered.length === 0) {
    return null;
  }
  const total = answered.reduce((sum, { call }) => {
    const start = Date.parse(
      metric === 'ringToAnswer' ? call.startedAt : (call.answeredAt as string)
    );
    const end = Date.parse(
      metric === 'ringToAnswer'
        ? (call.answeredAt as string)
        : (call.endedAt as string)
    );
    return sum + (end - start);
  }, 0);
  return total / answered.length / 1000;
}

defineOp<StatsInput, { buckets: StatsBucket[] }>({
  name: 'stats.query',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    if (!METRICS.includes(input.metric)) {
      throw invalid(
        'metric',
        'statsMetric',
        `stats: unknown metric ${String(input.metric)}`
      );
    }
    if (!BUCKET_UNITS.includes(input.bucket)) {
      throw invalid(
        'bucket',
        'statsBucket',
        `stats: unknown bucket ${String(input.bucket)}`
      );
    }
    const timeZone = tenantZone(ctx.db);
    const from = requireInstant(ctx.db, 'from', input.from);
    const to = requireInstant(ctx.db, 'to', input.to, true);
    const starts: number[] = [];
    for (
      let cursor = bucketStart(from, input.bucket, timeZone);
      cursor < to && starts.length <= MAX_BUCKETS;
      cursor = nextBucket(cursor, input.bucket, timeZone)
    ) {
      starts.push(cursor);
    }
    if (starts.length > MAX_BUCKETS) {
      throw invalid(
        'bucket',
        'statsTooManyBuckets',
        `stats: more than ${MAX_BUCKETS} ${input.bucket} buckets requested; narrow the range or widen the bucket`,
        { max: MAX_BUCKETS }
      );
    }
    const byBucket = new Map<number, { call: Call; answered: boolean }[]>();
    for (const call of ctx.db.calls) {
      const started = Date.parse(call.startedAt);
      if (call.endedAt === null || started < from || started >= to) {
        continue;
      }
      if (
        input.ringGroupId === undefined
          ? call.parentCallId !== null
          : call.ringGroupId !== input.ringGroupId
      ) {
        continue;
      }
      const answered =
        input.ringGroupId === undefined
          ? call.status === 'answered'
          : call.answeredByUserId !== null;
      const key = bucketStart(started, input.bucket, timeZone);
      const rows = byBucket.get(key) ?? [];
      rows.push({ call, answered });
      byBucket.set(key, rows);
    }
    return {
      buckets: starts.map(start => ({
        start: new Date(start).toISOString(),
        value: metricValue(byBucket.get(start) ?? [], input.metric)
      }))
    };
  }
});
