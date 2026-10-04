import { describe, expect, it } from 'vitest';

import { insertCall, makeStatsDb, queryStats } from '#testing/statsTestKit.js';

describe('stats.query', () => {
  it('callVolume by day counts calls per bucket', async () => {
    const db = await makeStatsDb();
    await insertCall(db, {
      startedAt: '2026-01-01T10:00:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T20:00:00.000Z',
      status: 'missed'
    });
    await insertCall(db, {
      startedAt: '2026-01-02T10:00:00.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      bucket: 'day'
    });

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 2 },
      { start: '2026-01-02T00:00:00.000Z', value: 1 }
    ]);
  });

  it('leaves out a call still in progress, its row not yet an outcome (§10.1 "Call aggregate")', async () => {
    const db = await makeStatsDb();
    await insertCall(db, {
      startedAt: '2026-01-01T10:00:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T11:00:00.000Z',
      endedAt: null,
      status: 'interrupted'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      bucket: 'day'
    });

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 1 }
    ]);
  });

  it('answerRate is answered / (answered + missed + busy)', async () => {
    const db = await makeStatsDb();
    await insertCall(db, {
      startedAt: '2026-01-01T01:00:00.000Z',
      status: 'answered',
      answeredAt: '2026-01-01T01:00:05.000Z'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T02:00:00.000Z',
      status: 'missed'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T03:00:00.000Z',
      status: 'busy'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T04:00:00.000Z',
      status: 'failed'
    });

    const result = await queryStats(db, {
      metric: 'answerRate',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      bucket: 'day'
    });

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 1 / 3 }
    ]);
  });

  it('is null for a bucket with no calls', async () => {
    const db = await makeStatsDb();

    const result = await queryStats(db, {
      metric: 'answerRate',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      bucket: 'day'
    });

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: null }
    ]);
  });

  it('refuses a range that would lay out more buckets than one request may hold, with 422', async () => {
    const db = await makeStatsDb();

    const attempt = queryStats(db, {
      metric: 'callVolume',
      from: '1970-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
      bucket: 'minute'
    });

    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('serves a week at minute resolution', async () => {
    const db = await makeStatsDb();

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-01-05T00:00:00.000Z',
      to: '2026-01-12T00:00:00.000Z',
      bucket: 'minute'
    });

    expect(result.buckets).toHaveLength(7 * 24 * 60);
  });

  it('refuses a from or to that is not an ISO 8601 datetime, with 422', async () => {
    const db = await makeStatsDb();

    const attempt = queryStats(db, {
      metric: 'callVolume',
      from: 'yesterday',
      to: '2026-01-02T00:00:00.000Z',
      bucket: 'day'
    });

    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('reads an offset datetime as the UTC instant it names', async () => {
    const db = await makeStatsDb();
    await insertCall(db, {
      startedAt: '2026-01-01T23:30:00.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-01-02T00:00:00+01:00',
      to: '2026-01-03T00:00:00+01:00',
      bucket: 'hour'
    });

    expect(result.buckets[0]).toEqual({
      start: '2026-01-01T23:00:00.000Z',
      value: 1
    });
  });
});
