import { describe, expect, it } from 'vitest';

import { asRun, makeTestDb } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import type { HoursWire } from './get.js';

import './index.js';

describe('hours', () => {
  it('has no schedule for a scope until one is set', async () => {
    const db = await makeTestDb();
    const read = (await runOperation(
      db,
      'hours.get',
      { scope: { kind: 'tenant' } },
      asRun()
    )) as { schedule: HoursWire | null };
    expect(read.schedule).toBeNull();
  });

  it('sets, sorts and reads back a schedule, then deletes it', async () => {
    const db = await makeTestDb();
    const set = (await runOperation(
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
    )) as HoursWire;
    expect(set.intervals).toEqual([
      { weekday: 1, opens: '09:00', closes: '12:00' },
      { weekday: 1, opens: '13:00', closes: '17:00' }
    ]);
    const read = (await runOperation(
      db,
      'hours.get',
      { scope: { kind: 'tenant' } },
      asRun()
    )) as { schedule: HoursWire | null };
    expect(read.schedule?.intervals).toHaveLength(2);
    await runOperation(
      db,
      'hours.delete',
      { scope: { kind: 'tenant' } },
      asRun({ confirm: true })
    );
    const afterDelete = (await runOperation(
      db,
      'hours.get',
      { scope: { kind: 'tenant' } },
      asRun()
    )) as { schedule: HoursWire | null };
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
