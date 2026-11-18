import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';
import { run, seedAudio } from '#testing/undoKit.js';

import './audit/index.js';
import './decisions/index.js';
import './didBlocks/index.js';
import './dids/index.js';
import './menus/index.js';
import './ringGroups/index.js';
import './settings/index.js';
import './users/index.js';

// §11.2 `forward_targets`: an owner's write updates its target row in place.

const FROM_VIENNA = { type: 'caller', number: '+43', isPrefix: true };

function external(number: string, fallback: object | null = null): object {
  return { kind: 'external', external: number, fallback };
}

async function arrange(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  return db;
}

async function targetIds(db: Db): Promise<string[]> {
  const rows = await db.selectFrom('forwardTargets').select('id').execute();
  return rows.map(row => row.id).sort();
}

/** The ids of `id`'s fallback chain, in order. */
async function chainIds(db: Db, id: string): Promise<string[]> {
  const row = await db
    .selectFrom('forwardTargets')
    .select('id')
    .where('fallbackOfId', '=', id)
    .executeTakeFirst();
  return row === undefined ? [] : [row.id, ...(await chainIds(db, row.id))];
}

async function didTargetId(db: Db, id: string): Promise<string> {
  const row = await db
    .selectFrom('dids')
    .select('targetId')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.targetId;
}

describe('a forward target written in place', () => {
  it("keeps a DID's row through a write-back and a change of kind, and undo restores the earlier target in it", async () => {
    const db = await arrange();
    const did = await run<{ id: string; target: object }>(db, 'dids.create', {
      number: '+4312345',
      target: external('+4366411111')
    });
    const targetId = await didTargetId(db, did.id);
    const rows = await targetIds(db);

    await run(db, 'dids.update', { id: did.id, target: did.target });
    await run(db, 'dids.update', {
      id: did.id,
      target: { kind: 'mailboxUser', userId: 'owner' }
    });
    expect(await didTargetId(db, did.id)).toBe(targetId);
    expect(await targetIds(db)).toEqual(rows);
    expect(
      await db
        .selectFrom('forwardTargets')
        .select(['external', 'mailboxUserId'])
        .where('id', '=', targetId)
        .executeTakeFirstOrThrow()
    ).toEqual({ external: null, mailboxUserId: 'owner' });

    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'dids.update')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    await run(db, 'audit.undo', { id: entry.id });
    expect(await didTargetId(db, did.id)).toBe(targetId);
    expect(await targetIds(db)).toEqual(rows);
    expect(
      await db
        .selectFrom('forwardTargets')
        .select(['external', 'mailboxUserId'])
        .where('id', '=', targetId)
        .executeTakeFirstOrThrow()
    ).toEqual({ external: '+4366411111', mailboxUserId: null });
  });

  it('updates a fallback chain in place, inserts a new fallback and deletes a removed one with the rest of its chain', async () => {
    const db = await arrange();
    const did = await run<{ id: string }>(db, 'dids.create', {
      number: '+4312345',
      target: external('+4311', external('+4322', external('+4333')))
    });
    const targetId = await didTargetId(db, did.id);
    const [second, third] = await chainIds(db, targetId);

    await run(db, 'dids.update', {
      id: did.id,
      target: external(
        '+4311',
        external('+4344', { kind: 'mailboxUser', userId: 'owner' })
      )
    });
    expect(await chainIds(db, targetId)).toEqual([second, third]);
    expect(
      await db
        .selectFrom('forwardTargets')
        .select(['id', 'external', 'mailboxUserId'])
        .where('id', 'in', [second ?? '', third ?? ''])
        .orderBy('mailboxUserId')
        .execute()
    ).toEqual([
      { id: second, external: '+4344', mailboxUserId: null },
      { id: third, external: null, mailboxUserId: 'owner' }
    ]);

    await run(db, 'dids.update', { id: did.id, target: external('+4311') });
    expect(await chainIds(db, targetId)).toEqual([]);
    expect(await targetIds(db)).not.toContain(second);
    expect(await targetIds(db)).not.toContain(third);

    await run(db, 'dids.update', {
      id: did.id,
      target: external('+4311', external('+4355'))
    });
    expect(await didTargetId(db, did.id)).toBe(targetId);
    expect(await chainIds(db, targetId)).toHaveLength(1);
  });

  it.each([
    {
      operation: 'users.setForwarding',
      table: 'userForwardRules' as const,
      conditions: ['busy', 'noAnswer']
    },
    {
      operation: 'ringGroups.setForwarding',
      table: 'ringGroupForwardRules' as const,
      conditions: ['unanswered', 'unavailable']
    }
  ])(
    "$operation keeps a rule's row by its condition and deletes a removed rule's",
    async ({ operation, table, conditions }) => {
      const db = await arrange();
      const group = await run(db, 'ringGroups.create', {
        name: 'Support',
        strategy: 'simultaneous'
      });
      const id = table === 'userForwardRules' ? 'owner' : group.id;
      const [kept = '', removed = ''] = conditions;
      const stored = async (): Promise<Record<string, string>> =>
        Object.fromEntries(
          (
            await db
              .selectFrom(table)
              .select(['condition', 'targetId'])
              .where(
                table === 'userForwardRules' ? 'userId' : 'groupId',
                '=',
                id
              )
              .execute()
          ).map(row => [row.condition, row.targetId])
        );
      await run(db, operation, {
        id,
        rules: [
          { condition: kept, target: external('+4311') },
          { condition: removed, target: external('+4322') }
        ]
      });
      const before = await stored();
      await run(db, operation, {
        id,
        rules: [{ condition: kept, target: external('+4333') }]
      });
      expect(await stored()).toEqual({ [kept]: before[kept] });
      expect(await targetIds(db)).not.toContain(before[removed]);
      expect(
        await db
          .selectFrom('forwardTargets')
          .select('external')
          .where('id', '=', before[kept] ?? '')
          .executeTakeFirstOrThrow()
      ).toEqual({ external: '+4333' });
    }
  );

  it("keeps a menu key's row by its digits and the menu's fallback row, and deletes a removed key's", async () => {
    const db = await arrange();
    const audioId = await seedAudio(db, 'announcement');
    const menu = await run(db, 'menus.create', {
      name: 'Main menu',
      audioId,
      fallbackTarget: external('+4900')
    });
    const fallbackId = async (): Promise<string> =>
      (
        await db
          .selectFrom('menus')
          .select('fallbackTargetId')
          .where('id', '=', menu.id)
          .executeTakeFirstOrThrow()
      ).fallbackTargetId;
    const keys = async (): Promise<Record<string, string>> =>
      Object.fromEntries(
        (
          await db
            .selectFrom('menuTargets')
            .select(['digits', 'targetId'])
            .where('menuId', '=', menu.id)
            .execute()
        ).map(row => [row.digits, row.targetId])
      );
    await run(db, 'menus.setTargets', {
      id: menu.id,
      targets: [
        { digits: '1', target: external('+4911') },
        { digits: '2', target: external('+4922') }
      ]
    });
    const before = await keys();
    const fallbackBefore = await fallbackId();

    await run(db, 'menus.setTargets', {
      id: menu.id,
      targets: [
        { digits: '3', target: external('+4933') },
        { digits: '1', target: { kind: 'hangup' } }
      ]
    });
    await run(db, 'menus.update', {
      id: menu.id,
      fallbackTarget: { kind: 'hangup' }
    });
    const after = await keys();
    expect(after['1']).toBe(before['1']);
    expect(Object.keys(after).sort()).toEqual(['1', '3']);
    expect(await targetIds(db)).not.toContain(before['2']);
    expect(await fallbackId()).toBe(fallbackBefore);
  });

  it("keeps a decision case's row by its position and the default's, and deletes the rows of cases it no longer has", async () => {
    const db = await arrange();
    const decision = await run(db, 'decisions.create', {
      name: 'Main line',
      cases: [
        { when: [FROM_VIENNA], target: external('+4311') },
        { when: [FROM_VIENNA], target: external('+4322') }
      ],
      default: { kind: 'hangup' }
    });
    const caseIds = async (): Promise<string[]> =>
      (
        await db
          .selectFrom('decisionCases')
          .select('targetId')
          .where('decisionId', '=', decision.id)
          .orderBy('position')
          .execute()
      ).map(row => row.targetId);
    const defaultId = async (): Promise<string> =>
      (
        await db
          .selectFrom('decisions')
          .select('defaultTargetId')
          .where('id', '=', decision.id)
          .executeTakeFirstOrThrow()
      ).defaultTargetId;
    const [first, second] = await caseIds();
    const fallback = await defaultId();

    await run(db, 'decisions.update', {
      id: decision.id,
      cases: [{ when: [FROM_VIENNA], target: external('+4333') }],
      default: external('+4344')
    });
    expect(await caseIds()).toEqual([first]);
    expect(await targetIds(db)).not.toContain(second);
    expect(await defaultId()).toBe(fallback);

    await run(db, 'decisions.update', {
      id: decision.id,
      cases: [
        { when: [FROM_VIENNA], target: external('+4333') },
        { when: [FROM_VIENNA], target: external('+4355') }
      ]
    });
    expect((await caseIds())[0]).toBe(first);
    expect(await caseIds()).toHaveLength(2);
  });

  it('deletes the row of a nullable owner set to null, and inserts one when it is set again', async () => {
    const db = await arrange();
    const seeded = await targetIds(db);
    const block = await run(db, 'didBlocks.create', {
      base: '+43123',
      digits: 2,
      fallbackTarget: external('+4311')
    });
    await run(db, 'settings.update', { fallbackTarget: external('+4322') });
    expect(await targetIds(db)).toHaveLength(seeded.length + 2);
    const settingsTarget = (
      await db
        .selectFrom('settings')
        .select('fallbackTargetId')
        .executeTakeFirstOrThrow()
    ).fallbackTargetId;

    await run(db, 'settings.update', { fallbackTarget: external('+4333') });
    expect(
      (
        await db
          .selectFrom('settings')
          .select('fallbackTargetId')
          .executeTakeFirstOrThrow()
      ).fallbackTargetId
    ).toBe(settingsTarget);

    await run(db, 'didBlocks.update', { id: block.id, fallbackTarget: null });
    await run(db, 'settings.update', { fallbackTarget: null });
    expect(await targetIds(db)).toEqual(seeded);

    await run(db, 'didBlocks.update', {
      id: block.id,
      fallbackTarget: external('+4344')
    });
    expect(await targetIds(db)).toHaveLength(seeded.length + 1);
  });
});
