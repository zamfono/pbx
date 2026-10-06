import { describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';

describe('ringGroups.getForwarding', () => {
  it('reads the rules back in the shape ringGroups.setForwarding takes', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const group = (await runOperation(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous' },
      asRun()
    )) as { id: string };
    const rules = [
      { condition: 'unanswered', target: { kind: 'user', userId: 'owner' } },
      {
        condition: 'unavailable',
        target: { kind: 'external', external: '+491111111', record: false }
      }
    ];
    await runOperation(
      db,
      'ringGroups.setForwarding',
      { id: group.id, rules: [...rules].reverse() },
      asRun()
    );

    expect(
      await runOperation(
        db,
        'ringGroups.getForwarding',
        { id: group.id },
        asRun()
      )
    ).toEqual({ id: group.id, rules });
  });

  it('refuses an unknown ring group id with a 404', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(db, 'ringGroups.getForwarding', { id: 'nope' }, asRun())
    ).rejects.toMatchObject({ status: 404 });
  });
});
