import { describe, expect, it } from 'vitest';

import {
  admin,
  createSipTargetTrunk,
  createUserActor,
  setForwarding,
  storedConditions,
  type Rule
} from '#testing/forwardingTestKit.js';
import { asRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

// §10.3 "Users": `PUT /users/{id}/forwarding` is self-service on the user's own id.
describe('users.setForwarding, self-service', () => {
  it('lets a user set their own rules to every non-sip kind, attributed to them in the audit log (§5.7)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const ben = await createUserActor(db, 'Ben Roth', '102');
    const rules: Rule[] = [
      { condition: 'unconditional', target: { kind: 'user', userId: ben.id } },
      { condition: 'busy', target: { kind: 'mailboxUser', userId: anna.id } },
      {
        condition: 'noAnswer',
        target: { kind: 'external', external: '+4915112345678' }
      }
    ];
    const out = await setForwarding(db, anna.id, rules, anna);
    expect(out.rules).toEqual(rules);
    expect(await storedConditions(db, anna.id)).toEqual([
      'busy',
      'noAnswer',
      'unconditional'
    ]);
    const entry = await db
      .selectFrom('auditLog')
      .select(['actorUserId', 'actorUserName', 'channel', 'undoable'])
      .where('operation', '=', 'users.setForwarding')
      .where('entityId', '=', anna.id)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({
      actorUserId: anna.id,
      actorUserName: 'Anna Huber',
      channel: 'rest',
      undoable: 1
    });
  });

  it("refuses a user setting another user's forwarding with 403, as users.update does, and lets an admin", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const ben = await createUserActor(db, 'Ben Roth', '102');
    const rules: Rule[] = [
      { condition: 'busy', target: { kind: 'mailboxUser', userId: ben.id } }
    ];
    await expect(setForwarding(db, ben.id, rules, anna)).rejects.toMatchObject({
      status: 403
    });
    expect(await storedConditions(db, ben.id)).toEqual([]);
    await setForwarding(db, ben.id, rules, admin);
    expect(await storedConditions(db, ben.id)).toEqual(['busy']);
  });

  it('refuses a sip target in a user’s own forwarding with 403 (§10.3 "Forward targets")', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const trunkId = await createSipTargetTrunk(db);
    const attempt = setForwarding(
      db,
      anna.id,
      [
        {
          condition: 'noAnswer',
          target: { kind: 'sip', trunkId, user: 'proj_abc123' }
        }
      ],
      anna
    );
    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect(await storedConditions(db, anna.id)).toEqual([]);
  });

  it("lets an admin undo a user's own forwarding change, restoring the rules it replaced (§5.8)", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const trunkId = await createSipTargetTrunk(db);
    await setForwarding(db, anna.id, [
      {
        condition: 'noAnswer',
        target: { kind: 'sip', trunkId, user: 'proj_abc123' }
      }
    ]);
    await setForwarding(db, anna.id, [], anna);
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'users.setForwarding')
      .where('actorUserId', '=', anna.id)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', { id: entry.id }, asRun());
    expect(await storedConditions(db, anna.id)).toEqual(['noAnswer']);
  });
});
