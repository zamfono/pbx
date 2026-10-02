import { describe, expect, it } from 'vitest';

import { newId, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

type QueryOutput = { buckets: { start: string; value: number | null }[] };

async function insertCall(
  db: Db,
  fields: {
    startedAt: string;
    answeredAt?: string | null;
    endedAt?: string | null;
    status: string;
  }
): Promise<void> {
  await db
    .insertInto('calls')
    .values({
      id: newId(),
      direction: 'inbound',
      fromUri: '+491700000000',
      toUri: '+490000000',
      status: fields.status,
      startedAt: fields.startedAt,
      answeredAt: fields.answeredAt ?? null,
      endedAt: fields.endedAt === undefined ? fields.startedAt : fields.endedAt
    })
    .execute();
}

describe('stats.query', () => {
  it('callVolume by day counts calls per bucket', async () => {
    const db = await makeTestDb();
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

    const result = (await runOperation(
      db,
      'stats.query',
      {
        metric: 'callVolume',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-03T00:00:00.000Z',
        bucket: 'day'
      },
      asRun()
    )) as QueryOutput;

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 2 },
      { start: '2026-01-02T00:00:00.000Z', value: 1 }
    ]);
  });

  it('leaves out a call still in progress, its row not yet an outcome (§10.1 "Call aggregate")', async () => {
    const db = await makeTestDb();
    await insertCall(db, {
      startedAt: '2026-01-01T10:00:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T11:00:00.000Z',
      endedAt: null,
      status: 'interrupted'
    });

    const result = (await runOperation(
      db,
      'stats.query',
      {
        metric: 'callVolume',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        bucket: 'day'
      },
      asRun()
    )) as QueryOutput;

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 1 }
    ]);
  });

  it('answerRate is answered / (answered + missed + busy)', async () => {
    const db = await makeTestDb();
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

    const result = (await runOperation(
      db,
      'stats.query',
      {
        metric: 'answerRate',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        bucket: 'day'
      },
      asRun()
    )) as QueryOutput;

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: 1 / 3 }
    ]);
  });

  it('is null for a bucket with no calls', async () => {
    const db = await makeTestDb();

    const result = (await runOperation(
      db,
      'stats.query',
      {
        metric: 'answerRate',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        bucket: 'day'
      },
      asRun()
    )) as QueryOutput;

    expect(result.buckets).toEqual([
      { start: '2026-01-01T00:00:00.000Z', value: null }
    ]);
  });

  it('refuses a range that would lay out more buckets than one request may hold, with 422', async () => {
    const db = await makeTestDb();

    const attempt = runOperation(
      db,
      'stats.query',
      {
        metric: 'callVolume',
        from: '1970-01-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z',
        bucket: 'minute'
      },
      asRun()
    );

    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('serves a week at minute resolution', async () => {
    const db = await makeTestDb();

    const result = (await runOperation(
      db,
      'stats.query',
      {
        metric: 'callVolume',
        from: '2026-01-05T00:00:00.000Z',
        to: '2026-01-12T00:00:00.000Z',
        bucket: 'minute'
      },
      asRun()
    )) as QueryOutput;

    expect(result.buckets).toHaveLength(7 * 24 * 60);
  });

  it('refuses a from or to that is not an ISO 8601 datetime, with 422', async () => {
    const db = await makeTestDb();

    const attempt = runOperation(
      db,
      'stats.query',
      {
        metric: 'callVolume',
        from: 'yesterday',
        to: '2026-01-02T00:00:00.000Z',
        bucket: 'day'
      },
      asRun()
    );

    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('reads an offset datetime as the UTC instant it names', async () => {
    const db = await makeTestDb();
    await insertCall(db, {
      startedAt: '2026-01-01T23:30:00.000Z',
      status: 'answered'
    });

    const result = (await runOperation(
      db,
      'stats.query',
      {
        metric: 'callVolume',
        from: '2026-01-02T00:00:00+01:00',
        to: '2026-01-03T00:00:00+01:00',
        bucket: 'hour'
      },
      asRun()
    )) as QueryOutput;

    expect(result.buckets[0]).toEqual({
      start: '2026-01-01T23:00:00.000Z',
      value: 1
    });
  });
});
