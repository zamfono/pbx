import { describe, expect, it } from 'vitest';

import { insertCall, makeStatsDb, queryStats } from './statsTestKit.js';

describe('stats.query buckets on the tenant clock', () => {
  it('lays a 23-hour day bucket over the spring-forward day', async () => {
    const db = await makeStatsDb('Europe/Berlin');
    // 23:30 on 29 March and 00:30 on 30 March, Berlin time.
    await insertCall(db, {
      startedAt: '2026-03-29T21:30:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-03-29T22:30:00.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-03-28T23:00:00.000Z',
      to: '2026-03-30T22:00:00.000Z',
      bucket: 'day'
    });

    expect(result.buckets).toEqual([
      { start: '2026-03-28T23:00:00.000Z', value: 1 },
      { start: '2026-03-29T22:00:00.000Z', value: 1 }
    ]);
  });

  it('lays a 25-hour day bucket over the fall-back day', async () => {
    const db = await makeStatsDb('Europe/Berlin');
    // 23:30 on 25 October, Berlin time.
    await insertCall(db, {
      startedAt: '2026-10-25T22:30:00.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-10-24T22:00:00.000Z',
      to: '2026-10-26T23:00:00.000Z',
      bucket: 'day'
    });

    expect(result.buckets).toEqual([
      { start: '2026-10-24T22:00:00.000Z', value: 1 },
      { start: '2026-10-25T23:00:00.000Z', value: 0 }
    ]);
  });

  it('starts a week bucket at Monday midnight, local time', async () => {
    const db = await makeStatsDb('Europe/Berlin');
    // 23:30 on Sunday 11 January and 00:30 on Monday 12 January, Berlin time.
    await insertCall(db, {
      startedAt: '2026-01-11T22:30:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-01-11T23:30:00.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-01-07T12:00:00.000Z',
      to: '2026-01-12T00:00:00.000Z',
      bucket: 'week'
    });

    expect(result.buckets).toEqual([
      { start: '2026-01-04T23:00:00.000Z', value: 1 },
      { start: '2026-01-11T23:00:00.000Z', value: 1 }
    ]);
  });

  it('starts an hour bucket at the local hour in a zone half an hour off UTC', async () => {
    const db = await makeStatsDb('Asia/Kolkata');
    await insertCall(db, {
      startedAt: '2026-01-01T00:15:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T00:45:00.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T02:00:00.000Z',
      bucket: 'hour'
    });

    expect(result.buckets).toEqual([
      { start: '2025-12-31T23:30:00.000Z', value: 1 },
      { start: '2026-01-01T00:30:00.000Z', value: 1 },
      { start: '2026-01-01T01:30:00.000Z', value: 0 }
    ]);
  });

  it('starts a minute bucket on the UTC minute in any zone', async () => {
    const db = await makeStatsDb('Asia/Kolkata');
    await insertCall(db, {
      startedAt: '2026-01-01T00:01:10.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, {
      metric: 'callVolume',
      from: '2026-01-01T00:00:30.000Z',
      to: '2026-01-01T00:02:00.000Z',
      bucket: 'minute'
    });

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 0 },
      { start: '2026-01-01T00:01:00.000Z', value: 1 }
    ]);
  });

  it('re-buckets the same calls after a time zone change', async () => {
    const db = await makeStatsDb('UTC');
    await insertCall(db, {
      startedAt: '2026-01-01T03:00:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T10:00:00.000Z',
      status: 'answered'
    });
    const input = {
      metric: 'callVolume',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      bucket: 'day'
    };

    const inUtc = await queryStats(db, input);
    await db
      .updateTable('settings')
      .set({ timezone: 'America/New_York' })
      .where('id', '=', 1)
      .execute();
    const inNewYork = await queryStats(db, input);

    expect(inUtc.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 2 }
    ]);
    expect(inNewYork.buckets).toEqual([
      { start: '2025-12-31T05:00:00.000Z', value: 1 },
      { start: '2026-01-01T05:00:00.000Z', value: 1 }
    ]);
  });
});
