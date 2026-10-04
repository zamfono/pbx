import { describe, expect, it } from 'vitest';

import { newId } from '@zamfono/shared';

import { asRun, makeTestDb, seedSettings } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';

type SnapshotItem = {
  userId: string;
  status: string;
  since: string;
  peer: string | null;
  ringGroupId: string | null;
};

describe('presenceLog.snapshot', () => {
  it("picks each user's latest `since` <= `at` and ignores rows recorded later", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await db
      .insertInto('presenceLog')
      .values([
        {
          id: newId(),
          userId: 'owner',
          status: 'available',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:00:00.000Z'
        },
        {
          id: newId(),
          userId: 'owner',
          status: 'busy',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:10:00.000Z'
        },
        {
          id: newId(),
          userId: 'owner',
          status: 'offline',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:20:00.000Z'
        }
      ])
      .execute();

    const result = (await runOperation(
      db,
      'presenceLog.snapshot',
      { at: '2026-01-01T00:15:00.000Z' },
      asRun()
    )) as { items: SnapshotItem[] };

    expect(result.items).toEqual([
      {
        userId: 'owner',
        status: 'busy',
        since: '2026-01-01T00:10:00.000Z',
        peer: null,
        ringGroupId: null
      }
    ]);
  });

  it('scopes to `userId` when given', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await db
      .insertInto('users')
      .values({
        id: 'other',
        name: 'Other',
        email: 'other@x',
        role: 'user',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .execute();
    await db
      .insertInto('presenceLog')
      .values([
        {
          id: newId(),
          userId: 'owner',
          status: 'available',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:00:00.000Z'
        },
        {
          id: newId(),
          userId: 'other',
          status: 'busy',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:00:00.000Z'
        }
      ])
      .execute();

    const result = (await runOperation(
      db,
      'presenceLog.snapshot',
      { at: '2026-01-01T00:30:00.000Z', userId: 'other' },
      asRun()
    )) as { items: SnapshotItem[] };

    expect(result.items.map(item => item.userId)).toEqual(['other']);
  });

  it('pages the snapshot by user like every other list (§10.3 "Conventions")', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await db
      .insertInto('users')
      .values({
        id: 'other',
        name: 'Other',
        email: 'other@x',
        role: 'user',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .execute();
    await db
      .insertInto('presenceLog')
      .values(
        ['owner', 'other'].flatMap(userId => [
          {
            id: newId(),
            userId,
            status: 'available',
            peer: null,
            ringGroupId: null,
            since: '2026-01-01T00:00:00.000Z'
          },
          {
            id: newId(),
            userId,
            status: 'busy',
            peer: null,
            ringGroupId: null,
            since: '2026-01-01T00:10:00.000Z'
          }
        ])
      )
      .execute();
    type Page = { items: SnapshotItem[]; nextCursor: string | null };

    const first = (await runOperation(
      db,
      'presenceLog.snapshot',
      { at: '2026-01-01T00:30:00.000Z', limit: 1 },
      asRun()
    )) as Page;
    const second = (await runOperation(
      db,
      'presenceLog.snapshot',
      { at: '2026-01-01T00:30:00.000Z', limit: 1, cursor: first.nextCursor },
      asRun()
    )) as Page;

    expect(
      [...first.items, ...second.items].map(item => [item.userId, item.status])
    ).toEqual([
      ['other', 'busy'],
      ['owner', 'busy']
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    ['an offset', '2026-01-01T02:15:00+02:00'],
    ['no milliseconds', '2026-01-01T00:15:00Z'],
    ['no offset, read in the tenant zone', '2026-01-01T01:15:00'],
    ['Z with milliseconds', '2026-01-01T00:15:00.000Z']
  ])('compares an `at` with %s as the instant it names', async (_form, at) => {
    const db = await makeTestDb();
    await seedSettings(db, { timezone: 'Europe/Berlin' });
    await db
      .insertInto('presenceLog')
      .values([
        {
          id: newId(),
          userId: 'owner',
          status: 'available',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:00:00.000Z'
        },
        {
          id: newId(),
          userId: 'owner',
          status: 'busy',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:15:00.000Z'
        },
        {
          id: newId(),
          userId: 'owner',
          status: 'offline',
          peer: null,
          ringGroupId: null,
          since: '2026-01-01T00:15:00.001Z'
        }
      ])
      .execute();

    const result = (await runOperation(
      db,
      'presenceLog.snapshot',
      { at },
      asRun()
    )) as { items: SnapshotItem[] };

    expect(result.items.map(item => item.status)).toEqual(['busy']);
  });

  it('refuses an `at` that is not an ISO 8601 instant with 422', async () => {
    const db = await makeTestDb();

    const attempt = runOperation(
      db,
      'presenceLog.snapshot',
      { at: 'yesterday' },
      asRun()
    );

    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });
});
