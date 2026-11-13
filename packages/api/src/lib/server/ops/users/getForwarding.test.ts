import { describe, expect, it } from 'vitest';

import { DEFAULT_SIP_HEADERS, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import {
  admin,
  createSipTargetTrunk,
  createUserActor,
  getForwarding,
  setForwarding,
  storedTargetIds,
  type Rule
} from '#testing/forwardingTestKit.js';
import { makeTestDb } from '#testing/testDb.js';

/** Every audit entry `operation` wrote, which a read must never add to (§5.7). */
async function auditCount(db: Db, operation: string): Promise<number> {
  const rows = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .execute();
  return rows.length;
}

// §10.3 "Users": `GET /users/{id}/forwarding` returns the rules in the shape the `PUT` takes.
describe('users.getForwarding', () => {
  it('reads a user’s rules in the PUT’s shape, in condition order, sip headers to an admin and the marker to the user', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const trunkId = await createSipTargetTrunk(db);
    expect(await getForwarding(db, anna.id, anna)).toEqual({
      id: anna.id,
      rules: []
    });
    const headers = [{ name: 'X-Ext', value: '{{calledExtension}}' }];
    await setForwarding(db, anna.id, [
      {
        condition: 'offline',
        target: { kind: 'external', external: '+4915112345678' }
      },
      {
        condition: 'noAnswer',
        target: { kind: 'sip', trunkId, user: 'proj_abc123', headers }
      },
      { condition: 'busy', target: { kind: 'mailboxUser', userId: anna.id } },
      {
        condition: 'unconditional',
        target: { kind: 'sip', trunkId, user: 'proj_def456' }
      }
    ]);
    const auditBefore = await auditCount(db, 'users.getForwarding');
    const sip = (user: string, sipHeaders: unknown[]): unknown => ({
      kind: 'sip',
      trunkId,
      user,
      headers: sipHeaders,
      record: false,
      ringTimeoutS: null,
      fallback: null
    });
    const rules = (
      unconditional: unknown,
      noAnswer: unknown
    ): Record<string, unknown> => ({
      id: anna.id,
      rules: [
        { condition: 'unconditional', target: unconditional },
        { condition: 'busy', target: { kind: 'mailboxUser', userId: anna.id } },
        { condition: 'noAnswer', target: noAnswer },
        {
          condition: 'offline',
          target: {
            kind: 'external',
            external: '+4915112345678',
            record: false,
            ringTimeoutS: null,
            fallback: null
          }
        }
      ]
    });
    // An admin reads the sip targets in full; the user, whose admin set them, their marker.
    expect(await getForwarding(db, anna.id, admin)).toEqual(
      rules(
        sip('proj_def456', [...DEFAULT_SIP_HEADERS]),
        sip('proj_abc123', headers)
      )
    );
    const marker = { managed: true, kind: 'sip' };
    expect(await getForwarding(db, anna.id, anna)).toEqual(
      rules(marker, marker)
    );
    expect(auditBefore).toBe(0);
    expect(await auditCount(db, 'users.getForwarding')).toBe(0);
  });

  it("refuses a user reading another user's forwarding with 403, and lets an admin read anyone's", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const ben = await createUserActor(db, 'Ben Roth', '102');
    const rules: Rule[] = [
      { condition: 'busy', target: { kind: 'mailboxUser', userId: ben.id } }
    ];
    await setForwarding(db, ben.id, rules);
    await expect(getForwarding(db, ben.id, anna)).rejects.toMatchObject({
      status: 403
    });
    expect(await getForwarding(db, ben.id, admin)).toEqual({
      id: ben.id,
      rules
    });
    await expect(getForwarding(db, 'nope', admin)).rejects.toMatchObject({
      status: 404
    });
  });

  it('round-trips: a user sending back what they read, a sip rule’s marker included, changes nothing', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const trunkId = await createSipTargetTrunk(db);
    await setForwarding(db, anna.id, [
      {
        condition: 'noAnswer',
        target: { kind: 'sip', trunkId, user: 'proj_abc123' }
      },
      { condition: 'busy', target: { kind: 'mailboxUser', userId: anna.id } }
    ]);
    const before = await getForwarding(db, anna.id, anna);
    const idsBefore = await storedTargetIds(db, anna.id);

    const out = await setForwarding(db, anna.id, before.rules, anna);
    expect(out).toEqual(before);
    expect(await getForwarding(db, anna.id, anna)).toEqual(before);
    // The sip rule keeps its own `forward_targets` row rather than a new one.
    expect((await storedTargetIds(db, anna.id)).noAnswer).toBe(
      idsBefore.noAnswer
    );
  });
});
