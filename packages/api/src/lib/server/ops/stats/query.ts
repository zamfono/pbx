import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { readTenantTimeZone } from '#lib/server/tenantTimeZone.js';

import { instantInput, toStoredEnd, toStoredInstant } from '../instantInput.js';
import { defineOperation, OpError } from '../types.js';
import {
  BUCKET_UNITS,
  bucketStartMs,
  bucketStarts,
  METRICS,
  metricValue,
  type BucketUnit,
  type StatsCallRow
} from './_shared.js';

// The widest series one request may ask for (§10.3): a week at minute resolution, and so a year
// at hour resolution. Every bucket is materialised in memory, so an unbounded range (1970 to 2100
// by minute, some 68 million buckets) would stall `api` for every caller.
const MAX_BUCKETS = 10_080;

const inputSchema = z
  .object({
    metric: z
      .enum(METRICS)
      .describe(
        'answerRate: answered of answered, missed and busy calls (0 to 1); ringToAnswer: mean seconds from start to answer; avgCallLength: mean seconds from answer to end; callVolume: the call count. Each call counts once; with ringGroupId, each offer to the group, answered when a member took it.'
      ),
    from: instantInput.describe(
      "Start of the range, inclusive: an ISO 8601 time, any offset (none: the tenant's time zone), or a date (its midnight)."
    ),
    to: instantInput.describe(
      "End of the range, exclusive: an ISO 8601 time, any offset (none: the tenant's time zone), or a date (the range covers that day)."
    ),
    bucket: z
      .enum(BUCKET_UNITS)
      .describe(
        'Bucket width, aligned to the tenant time zone (settings.timezone): the local hour, midnight or Monday; at most 10080 buckets per request.'
      ),
    ringGroupId: z
      .string()
      .optional()
      .describe(
        'Only the offers to this ring group, transfers into it included; left out, every call.'
      )
  })
  .strict();

/** Groups `rows` by the epoch milliseconds of the bucket start their `startedAt` falls into. */
function groupByBucket(
  rows: StatsCallRow[],
  unit: BucketUnit,
  timeZone: string
): Map<number, StatsCallRow[]> {
  const byBucket = new Map<number, StatsCallRow[]>();
  for (const row of rows) {
    const startMs = bucketStartMs(row.startedAt, unit, timeZone);
    const bucketRows = byBucket.get(startMs);
    if (bucketRows) {
      bucketRows.push(row);
    } else {
      byBucket.set(startMs, [row]);
    }
  }
  return byBucket;
}

/**
 * `GET /stats` (§10.3 "Statistics"): one metric bucketed over `[from, to)` by `calls.started_at`.
 * Without a ring group each call counts once, as its top-level row, answered by its status; with
 * one, each row offering a call to that group, a transfer leg into it included, answered when a
 * member took it.
 */
export const query = defineOperation({
  name: 'stats.query',
  description:
    'Buckets a call metric (answerRate, ringToAnswer, avgCallLength, callVolume) over a time range.',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const timeZone = await readTenantTimeZone(ctx.db);
    const from = toStoredInstant(input.from, timeZone);
    const to = toStoredEnd(input.to, timeZone);
    const starts = bucketStarts(from, to, input.bucket, timeZone, MAX_BUCKETS);
    if (starts.length > MAX_BUCKETS) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `stats: more than ${MAX_BUCKETS} ${input.bucket} buckets requested; narrow the range or widen the bucket`
      );
    }
    let callsQuery = ctx.db
      .selectFrom('calls')
      .select([
        'startedAt',
        'answeredAt',
        'answeredByUserId',
        'endedAt',
        'status'
      ])
      // A call in progress has a placeholder row, not an outcome yet (§10.1 "Call aggregate").
      .where('endedAt', 'is not', null)
      .where('startedAt', '>=', from)
      .where('startedAt', '<', to);
    const { ringGroupId } = input;
    callsQuery =
      ringGroupId === undefined
        ? callsQuery.where('parentCallId', 'is', null)
        : callsQuery.where('ringGroupId', '=', ringGroupId);
    const rows = (await callsQuery.execute()).map(row => ({
      ...row,
      answered:
        ringGroupId === undefined
          ? row.status === 'answered'
          : row.answeredByUserId !== null
    }));
    const byBucket = groupByBucket(rows, input.bucket, timeZone);
    const buckets = starts.map(startMs => ({
      start: new Date(startMs).toISOString(),
      value: metricValue(byBucket.get(startMs) ?? [], input.metric)
    }));
    return { buckets };
  }
});
