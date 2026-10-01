import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../devices/index.js';
import '../menus/index.js';
import '../ringGroups/index.js';
import '../users/index.js';
import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.test';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    actor: owner,
    channel: 'rest',
    requestId: 'req-1',
    confirm: true,
    ...overrides
  };
}

/** Seeds the tenant `settings` singleton, required by extension assignment. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId
    })
    .execute();
}

async function createUser(db: Db, name: string, ext: string): Promise<string> {
  const result = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    { name, email: `${name.toLowerCase()}@x.test`, extension: ext },
    asRun()
  );
  return result.user.id;
}

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
  await runOperation(db, 'audit.undo', { id: entry.id }, asRun());
}

function external(number: string): { kind: 'external'; external: string } {
  return { kind: 'external', external: number };
}

describe('audit.undo of a whole-list replace', () => {
  it("restores a user's forwarding rules", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const anna = await createUser(db, 'Anna', '101');
    const first = [{ condition: 'unconditional', target: external('+4911') }];
    await runOperation(
      db,
      'users.setForwarding',
      { id: anna, rules: first },
      asRun()
    );
    await runOperation(
      db,
      'users.setForwarding',
      { id: anna, rules: [{ condition: 'busy', target: external('+4922') }] },
      asRun()
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
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous' },
      asRun()
    );
    await runOperation(
      db,
      'ringGroups.setForwarding',
      {
        id: group.id,
        rules: [{ condition: 'unanswered', target: external('+4911') }]
      },
      asRun()
    );
    await runOperation(
      db,
      'ringGroups.setForwarding',
      { id: group.id, rules: [] },
      asRun()
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
    await seedTenant(db);
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
    const menu = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      { name: 'Main menu', audioId, fallbackTarget: external('+4900') },
      asRun()
    );
    const first = [{ digits: '1', target: external('+4911') }];
    await runOperation(
      db,
      'menus.setTargets',
      { id: menu.id, targets: first },
      asRun()
    );
    await runOperation(
      db,
      'menus.setTargets',
      { id: menu.id, targets: [{ digits: '2', target: external('+4922') }] },
      asRun()
    );

    await undoLatest(db, 'menus.setTargets', menu.id);

    const read = await runOperation<unknown, { targets: unknown[] }>(
      db,
      'menus.get',
      { id: menu.id },
      asRun()
    );
    expect(read.targets).toEqual(first);
  });

  it("restores a ringotel device's BLF panel", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const anna = await createUser(db, 'Anna', '101');
    await createUser(db, 'Ben', '102');
    const device = await runOperation<unknown, { device: { id: string } }>(
      db,
      'devices.create',
      { userId: anna, label: 'App', kind: 'ringotel' },
      asRun()
    );
    const { id } = device.device;
    await runOperation(db, 'devices.setBlf', { id, keys: ['102'] }, asRun());
    await runOperation(
      db,
      'devices.setBlf',
      { id, keys: ['101', '102'] },
      asRun()
    );

    await undoLatest(db, 'devices.setBlf', id);

    const read = await runOperation<unknown, { keys: string[] }>(
      db,
      'devices.getBlf',
      { id },
      asRun()
    );
    expect(read.keys).toEqual(['102']);
  });
});
