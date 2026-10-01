import { describe, expect, it } from 'vitest';

import { makeTestDb } from '$lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';
import type { HoursWire } from './get.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

describe('hours', () => {
  it('has no schedule for a scope until one is set', async () => {
    const db = await makeTestDb();
    const read = await runOperation<unknown, { schedule: HoursWire | null }>(
      db,
      'hours.get',
      { scope: { kind: 'tenant' } },
      asRun()
    );
    expect(read.schedule).toBeNull();
  });

  it('sets, sorts and reads back a schedule, then deletes it', async () => {
    const db = await makeTestDb();
    const set = await runOperation<unknown, HoursWire>(
      db,
      'hours.set',
      {
        scope: { kind: 'tenant' },
        closedTarget: { kind: 'external', external: '+491234567' },
        intervals: [
          { weekday: 1, opens: '13:00', closes: '17:00' },
          { weekday: 1, opens: '09:00', closes: '12:00' }
        ]
      },
      asRun()
    );
    expect(set.intervals).toEqual([
      { weekday: 1, opens: '09:00', closes: '12:00' },
      { weekday: 1, opens: '13:00', closes: '17:00' }
    ]);
    const read = await runOperation<unknown, { schedule: HoursWire | null }>(
      db,
      'hours.get',
      { scope: { kind: 'tenant' } },
      asRun()
    );
    expect(read.schedule?.intervals).toHaveLength(2);
    await runOperation(
      db,
      'hours.delete',
      { scope: { kind: 'tenant' } },
      asRun({ confirm: true })
    );
    const afterDelete = await runOperation<
      unknown,
      { schedule: HoursWire | null }
    >(db, 'hours.get', { scope: { kind: 'tenant' } }, asRun());
    expect(afterDelete.schedule).toBeNull();
  });

  it('refuses an interval crossing midnight', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'hours.set',
        {
          scope: { kind: 'tenant' },
          closedTarget: { kind: 'external', external: '+491234567' },
          intervals: [{ weekday: 1, opens: '22:00', closes: '02:00' }]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an invalid time of day', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'hours.set',
        {
          scope: { kind: 'tenant' },
          closedTarget: { kind: 'external', external: '+491234567' },
          intervals: [{ weekday: 1, opens: '09:60', closes: '17:00' }]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lets a user manage only their own user scope', async () => {
    const db = await makeTestDb();
    const asUser = asRun({
      actor: { id: 'owner', name: 'Owner', role: 'user' }
    });
    await expect(
      runOperation(
        db,
        'hours.set',
        {
          scope: { kind: 'tenant' },
          closedTarget: { kind: 'external', external: '+491234567' },
          intervals: []
        },
        asUser
      )
    ).rejects.toMatchObject({ status: 403 });
  });
});
