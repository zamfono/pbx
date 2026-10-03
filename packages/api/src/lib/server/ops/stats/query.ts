import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { readTenantTimeZone } from '#lib/server/tenantTimeZone.js';

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

// The widest series one request may ask for: a week at minute resolution, and so a year at hour
// resolution. §10.3 states no bound, but every bucket is materialised in memory, so an unbounded
// range (1970 to 2100 by minute, some 68 million buckets) would stall `api` for every caller.
const MAX_BUCKETS = 10_080;

const inputSchema = z
  .object({
    metric: z
      .enum(METRICS)
      .describe(
        'answerRate: answered of answered, missed and busy calls (0 to 1); ringToAnswer and avgCallLength: mean seconds; callVolume: the call count.'
      ),
    from: z.iso
      .datetime({ offset: true })
      .describe('Start of the range, inclusive, ISO 8601 with offset.'),
    to: z.iso
      .datetime({ offset: true })
      .describe('End of the range, exclusive, ISO 8601 with offset.'),
    bucket: z
      .enum(BUCKET_UNITS)
      .describe(
        'Bucket width, aligned to the tenant time zone (settings.timezone): the local hour, midnight or Monday; at most 10080 buckets per request.'
      ),
    ringGroupId: z
      .string()
      .optional()
      .describe("Only this ring group's calls; left out, every call.")
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
 * `GET /stats` (§10.3 "Statistics"): one metric bucketed over `[from, to)` by `calls.started_at`,
 * optionally scoped to one ring group.
 */
export const query = defineOperation({
  name: 'stats.query',
  description:
    'Buckets a call metric (answerRate, ringToAnswer, avgCallLength, callVolume) over a time range.',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    // `calls.started_at` is stored in UTC (§11.1), and compared as a string below, so an input
    // carrying an offset is brought to the same form first.
    const from = new Date(input.from).toISOString();
    const to = new Date(input.to).toISOString();
    const timeZone = await readTenantTimeZone(ctx.db);
    const starts = bucketStarts(from, to, input.bucket, timeZone, MAX_BUCKETS);
    if (starts.length > MAX_BUCKETS) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `stats: more than ${MAX_BUCKETS} ${input.bucket} buckets requested; narrow the range or widen the bucket`
      );
    }
    let callsQuery = ctx.db
      .selectFrom('calls')
      .select(['startedAt', 'answeredAt', 'endedAt', 'status'])
      // A call in progress has a placeholder row, not an outcome yet (§10.1 "Call aggregate").
      .where('endedAt', 'is not', null)
      .where('startedAt', '>=', from)
      .where('startedAt', '<', to);
    if (input.ringGroupId !== undefined) {
      callsQuery = callsQuery.where('ringGroupId', '=', input.ringGroupId);
    }
    const rows = await callsQuery.execute();
    const byBucket = groupByBucket(rows, input.bucket, timeZone);
    const buckets = starts.map(startMs => ({
      start: new Date(startMs).toISOString(),
      value: metricValue(byBucket.get(startMs) ?? [], input.metric)
    }));
    return { buckets };
  }
});
