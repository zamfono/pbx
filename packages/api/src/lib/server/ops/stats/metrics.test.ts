import { describe, expect, it } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';

import { insertCall, makeStatsDb, queryStats } from './statsTestKit.js';

const DAY = { from: '2026-01-01', to: '2026-01-01', bucket: 'day' } as const;

/** A top-level call answered at 10:00:10 and blind-transferred at 10:01:10 to a leg answered at 10:01:20. */
async function seedTransferredCall(db: Db): Promise<string> {
  const parentCallId = await insertCall(db, {
    startedAt: '2026-01-01T10:00:00.000Z',
    answeredAt: '2026-01-01T10:00:10.000Z',
    endedAt: '2026-01-01T10:01:10.000Z',
    status: 'answered',
    answeredByUserId: 'owner'
  });
  await insertCall(db, {
    startedAt: '2026-01-01T10:01:10.000Z',
    answeredAt: '2026-01-01T10:01:20.000Z',
    endedAt: '2026-01-01T10:03:20.000Z',
    status: 'answered',
    parentCallId
  });
  return parentCallId;
}

/**
 * Three offers to ring group `rg`: one a member answered after 5 s and talked 30 s on, one
 * transferred into the group and missed, one answered by the group's announcement, no member.
 */
async function seedGroupOffers(db: Db, parentCallId: string): Promise<void> {
  await db
    .insertInto('ringGroups')
    .values({
      id: 'rg',
      name: 'Sales',
      strategy: 'simultaneous',
      createdAt: nowIso()
    })
    .execute();
  await insertCall(db, {
    startedAt: '2026-01-01T11:00:00.000Z',
    answeredAt: '2026-01-01T11:00:05.000Z',
    endedAt: '2026-01-01T11:00:35.000Z',
    status: 'answered',
    answeredByUserId: 'owner',
    ringGroupId: 'rg'
  });
  await insertCall(db, {
    startedAt: '2026-01-01T11:05:00.000Z',
    status: 'missed',
    parentCallId,
    ringGroupId: 'rg'
  });
  await insertCall(db, {
    startedAt: '2026-01-01T11:10:00.000Z',
    answeredAt: '2026-01-01T11:10:20.000Z',
    endedAt: '2026-01-01T11:10:40.000Z',
    status: 'answered',
    ringGroupId: 'rg'
  });
}

async function valueOf(
  db: Db,
  input: Record<string, unknown>
): Promise<number | null> {
  const { buckets } = await queryStats(db, { ...DAY, ...input });
  return buckets[0]?.value ?? null;
}

describe('stats.query metrics (§10.3 "Statistics")', () => {
  it('counts each call once, by its top-level row, without a ring group', async () => {
    const db = await makeStatsDb();
    await seedTransferredCall(db);

    expect(await valueOf(db, { metric: 'callVolume' })).toBe(1);
    expect(await valueOf(db, { metric: 'ringToAnswer' })).toBe(10);
    expect(await valueOf(db, { metric: 'avgCallLength' })).toBe(60);
  });

  it('counts each offer to a ring group, transfers into it included, answered only by a member', async () => {
    const db = await makeStatsDb();
    await seedGroupOffers(db, await seedTransferredCall(db));
    const group = { ringGroupId: 'rg' };

    expect(await valueOf(db, { ...group, metric: 'callVolume' })).toBe(3);
    expect(await valueOf(db, { ...group, metric: 'answerRate' })).toBe(1 / 3);
    expect(await valueOf(db, { ...group, metric: 'ringToAnswer' })).toBe(5);
    expect(await valueOf(db, { ...group, metric: 'avgCallLength' })).toBe(30);
  });

  it('reads a date alone in the tenant zone, a `to` date covering that whole day', async () => {
    const db = await makeStatsDb('Europe/Berlin');
    await insertCall(db, {
      startedAt: '2026-01-01T22:30:00.000Z',
      status: 'answered'
    });
    await insertCall(db, {
      startedAt: '2026-01-01T23:00:00.000Z',
      status: 'answered'
    });

    const result = await queryStats(db, { ...DAY, metric: 'callVolume' });

    expect(result.buckets).toEqual([
      { start: '2025-12-31T23:00:00.000Z', value: 1 }
    ]);
  });
});
