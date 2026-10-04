import { describe, expect, it } from 'vitest';

import { DEFAULT_SIP_HEADERS, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import {
  admin,
  createSipTargetTrunk,
  createUserActor,
  getForwarding,
  setForwarding,
  storedConditions,
  storedTargetIds,
  type Rule
} from '#testing/forwardingTestKit.js';
import { makeTestDb } from '#testing/testDb.js';

import type { Actor } from '../types.js';

type Fixture = { db: Db; anna: Actor; sipRule: Rule };

/** Anna, with an admin-set `noAnswer` rule to a `sip` target and a `busy` rule of her own. */
async function withAdminSipRule(): Promise<Fixture> {
  const db = await makeTestDb();
  await seedSettings(db);
  const anna = await createUserActor(db, 'Anna Huber', '101');
  const trunkId = await createSipTargetTrunk(db);
  const sipRule: Rule = {
    condition: 'noAnswer',
    target: {
      kind: 'sip',
      trunkId,
      user: 'proj_abc123',
      headers: [{ name: 'X-Ext', value: '{{calledExtension}}' }]
    }
  };
  await setForwarding(db, anna.id, [
    sipRule,
    { condition: 'busy', target: { kind: 'mailboxUser', userId: anna.id } }
  ]);
  return { db, anna, sipRule };
}

/** The `changes_json` of the latest (ids are UUIDv7, so time-ordered) `users.setForwarding` entry `actorId` wrote. */
async function latestChanges(db: Db, actorId: string): Promise<unknown> {
  const entry = await db
    .selectFrom('auditLog')
    .select('changesJson')
    .where('operation', '=', 'users.setForwarding')
    .where('actorUserId', '=', actorId)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  return JSON.parse(entry.changesJson);
}

// §10.3 "Forward targets": a user's `PUT` keeps the very `sip` target a condition already holds.
describe('users.setForwarding, an admin-set sip rule', () => {
  it('keeps an identical sip rule, on its own row, while the user changes another condition', async () => {
    const { db, anna, sipRule } = await withAdminSipRule();
    const idsBefore = await storedTargetIds(db, anna.id);
    const targetsBefore = await db
      .selectFrom('forwardTargets')
      .select('id')
      .execute();
    const external: Rule = {
      condition: 'busy',
      target: { kind: 'external', external: '+4915112345678' }
    };

    await setForwarding(db, anna.id, [sipRule, external], anna);
    expect((await getForwarding(db, anna.id, anna)).rules).toEqual([
      external,
      sipRule
    ]);
    const idsAfter = await storedTargetIds(db, anna.id);
    expect(idsAfter.noAnswer).toBe(idsBefore.noAnswer);
    expect(idsAfter.busy).not.toBe(idsBefore.busy);
    // One row replaced (busy), none added for the kept sip target.
    const targetsAfter = await db
      .selectFrom('forwardTargets')
      .select('id')
      .execute();
    expect(targetsAfter).toHaveLength(targetsBefore.length);
    // The user's audit entry records the sip rule as unchanged, `from` and `to` alike.
    expect(await latestChanges(db, anna.id)).toEqual([
      {
        field: 'rules',
        from: [
          {
            condition: 'busy',
            target: { kind: 'mailboxUser', userId: anna.id }
          },
          sipRule
        ],
        to: [sipRule, external]
      }
    ]);
  });

  it('keeps a sip rule sent without headers when it holds the defaults, as the wire returns it', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUserActor(db, 'Anna Huber', '101');
    const trunkId = await createSipTargetTrunk(db);
    const bare: Rule = {
      condition: 'offline',
      target: { kind: 'sip', trunkId, user: 'proj_abc123' }
    };
    await setForwarding(db, anna.id, [bare]);
    await setForwarding(db, anna.id, [bare], anna);
    expect((await getForwarding(db, anna.id, anna)).rules).toEqual([
      {
        condition: 'offline',
        target: { ...bare.target, headers: [...DEFAULT_SIP_HEADERS] }
      }
    ]);
  });

  it('refuses a user a sip rule differing in its trunk, user part or headers with 403', async () => {
    const { db, anna, sipRule } = await withAdminSipRule();
    const otherTrunk = await createSipTargetTrunk(
      db,
      'Other',
      'sip.other.test'
    );
    const target = sipRule.target;
    const variants: Record<string, unknown>[] = [
      { ...target, trunkId: otherTrunk },
      { ...target, user: 'proj_other' },
      { ...target, headers: [{ name: 'X-Ext', value: '{{did}}' }] },
      {
        ...target,
        headers: [{ name: 'X-Other', value: '{{calledExtension}}' }]
      },
      { ...target, headers: [] }
    ];
    const before = await getForwarding(db, anna.id, anna);
    await Promise.all(
      variants.map(variant =>
        expect(
          setForwarding(
            db,
            anna.id,
            [{ condition: 'noAnswer', target: variant }],
            anna
          )
        ).rejects.toMatchObject({ status: 403 })
      )
    );
    expect(await getForwarding(db, anna.id, anna)).toEqual(before);
  });

  it('refuses the identical sip target under another condition with 403, moved or copied', async () => {
    const { db, anna, sipRule } = await withAdminSipRule();
    const before = await getForwarding(db, anna.id, anna);
    const moved: Rule = { condition: 'busy', target: sipRule.target };
    await expect(
      setForwarding(db, anna.id, [moved], anna)
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      setForwarding(db, anna.id, [sipRule, moved], anna)
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      setForwarding(
        db,
        anna.id,
        [{ condition: 'dnd', target: sipRule.target }],
        anna
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(await getForwarding(db, anna.id, anna)).toEqual(before);
  });

  it('removes the sip rule, and its target row, when the user leaves it out', async () => {
    const { db, anna } = await withAdminSipRule();
    const { noAnswer } = await storedTargetIds(db, anna.id);
    await setForwarding(
      db,
      anna.id,
      [{ condition: 'busy', target: { kind: 'mailboxUser', userId: anna.id } }],
      anna
    );
    expect(await storedConditions(db, anna.id)).toEqual(['busy']);
    const row = await db
      .selectFrom('forwardTargets')
      .select('id')
      .where('id', '=', noAnswer ?? '')
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('leaves admins unaffected: they resend, change or move a sip rule freely', async () => {
    const { db, anna, sipRule } = await withAdminSipRule();
    await setForwarding(db, anna.id, [sipRule], admin);
    const moved: Rule = {
      condition: 'busy',
      target: { ...sipRule.target, user: 'proj_other' }
    };
    await setForwarding(db, anna.id, [sipRule, moved], admin);
    expect((await getForwarding(db, anna.id, admin)).rules).toEqual([
      moved,
      sipRule
    ]);
    expect(await latestChanges(db, admin.id)).toEqual([
      { field: 'rules', from: [sipRule], to: [sipRule, moved] }
    ]);
  });
});
