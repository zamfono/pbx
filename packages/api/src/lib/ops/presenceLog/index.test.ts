import { describe, expect, it } from 'vitest';

import { newId } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

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

    const result = await runOperation<unknown, { items: SnapshotItem[] }>(
      db,
      'presenceLog.snapshot',
      { at: '2026-01-01T00:15:00.000Z' },
      asRun()
    );

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

    const result = await runOperation<unknown, { items: SnapshotItem[] }>(
      db,
      'presenceLog.snapshot',
      { at: '2026-01-01T00:30:00.000Z', userId: 'other' },
      asRun()
    );

    expect(result.items.map(item => item.userId)).toEqual(['other']);
  });
});
