import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { createUser } from '#testing/fixtures.js';
import { asConfirmedRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../devices/index.js';
import '../menus/index.js';
import '../ringGroups/index.js';
import '../users/index.js';
import './index.js';

/** Undoes the latest `operation` entry recorded for `entityId`. */
async function undoLatest(
  db: Db,
  operation: string,
  entityId: string
): Promise<void> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .where('entityId', '=', entityId)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());
}

function external(number: string): { kind: 'external'; external: string } {
  return { kind: 'external', external: number };
}

describe('audit.undo of a whole-list replace', () => {
  it("restores a user's forwarding rules", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, '101', {
      name: 'Anna',
      email: 'anna@x.test'
    });
    const first = [{ condition: 'unconditional', target: external('+4911') }];
    await runOperation(
      db,
      'users.setForwarding',
      { id: anna, rules: first },
      asConfirmedRun()
    );
    await runOperation(
      db,
      'users.setForwarding',
      { id: anna, rules: [{ condition: 'busy', target: external('+4922') }] },
      asConfirmedRun()
    );

    await undoLatest(db, 'users.setForwarding', anna);

    const rules = await db
      .selectFrom('userForwardRules as r')
      .innerJoin('forwardTargets as t', 't.id', 'r.targetId')
      .select(['r.condition', 't.external'])
      .where('r.userId', '=', anna)
      .execute();
    expect(rules).toEqual([{ condition: 'unconditional', external: '+4911' }]);
  });

  it("restores a ring group's forwarding rules", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const group = (await runOperation(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous' },
      asConfirmedRun()
    )) as { id: string };
    await runOperation(
      db,
      'ringGroups.setForwarding',
      {
        id: group.id,
        rules: [{ condition: 'unanswered', target: external('+4911') }]
      },
      asConfirmedRun()
    );
    await runOperation(
      db,
      'ringGroups.setForwarding',
      { id: group.id, rules: [] },
      asConfirmedRun()
    );

    await undoLatest(db, 'ringGroups.setForwarding', group.id);

    const rules = await db
      .selectFrom('ringGroupForwardRules as r')
      .innerJoin('forwardTargets as t', 't.id', 'r.targetId')
      .select(['r.condition', 't.external'])
      .where('r.groupId', '=', group.id)
      .execute();
    expect(rules).toEqual([{ condition: 'unanswered', external: '+4911' }]);
  });

  it("restores a menu's DTMF map", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = newId();
    await db
      .insertInto('audioAssets')
      .values({
        id: audioId,
        label: 'Greeting',
        kind: 'announcement',
        filename: `${audioId}.wav`,
        createdAt: nowIso()
      })
      .execute();
    const menu = (await runOperation(
      db,
      'menus.create',
      { name: 'Main menu', audioId, fallbackTarget: external('+4900') },
      asConfirmedRun()
    )) as { id: string };
    const first = [{ digits: '1', target: external('+4911') }];
    await runOperation(
      db,
      'menus.setTargets',
      { id: menu.id, targets: first },
      asConfirmedRun()
    );
    await runOperation(
      db,
      'menus.setTargets',
      { id: menu.id, targets: [{ digits: '2', target: external('+4922') }] },
      asConfirmedRun()
    );

    await undoLatest(db, 'menus.setTargets', menu.id);

    const read = (await runOperation(
      db,
      'menus.get',
      { id: menu.id },
      asConfirmedRun()
    )) as { targets: unknown[] };
    expect(read.targets).toEqual(first);
  });

  it("restores a ringotel device's BLF panel", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, '101', {
      name: 'Anna',
      email: 'anna@x.test'
    });
    await createUser(db, '102', {
      name: 'Ben',
      email: 'ben@x.test'
    });
    const device = (await runOperation(
      db,
      'devices.create',
      { userId: anna, label: 'App', kind: 'ringotel' },
      asConfirmedRun()
    )) as { device: { id: string } };
    const { id } = device.device;
    await runOperation(
      db,
      'devices.setBlf',
      { id, keys: ['102'] },
      asConfirmedRun()
    );
    await runOperation(
      db,
      'devices.setBlf',
      { id, keys: ['101', '102'] },
      asConfirmedRun()
    );

    await undoLatest(db, 'devices.setBlf', id);

    const read = (await runOperation(
      db,
      'devices.getBlf',
      { id },
      asConfirmedRun()
    )) as { keys: string[] };
    expect(read.keys).toEqual(['102']);
  });
});
