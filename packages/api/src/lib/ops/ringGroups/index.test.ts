import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db, type ReloadKind } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import { onPropagate, runOperation, type RunInput } from '../runner.js';
import { Conflict, type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton and its main DID, both required by extension assignment. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({
      id: didId,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
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

describe('ringGroups', () => {
  it('create assigns the lowest free extension and propagates pjsip and dialplan', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    const created = await runOperation<unknown, { id: string; ext: string }>(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous' },
      asRun()
    );
    expect(created.ext).toBe('001');
    const row = await db
      .selectFrom('extensions')
      .selectAll()
      .where('ringGroupId', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.ext).toBe('001');
    expect(propagated).toEqual([
      { operation: 'ringGroups.create', kind: ['pjsip', 'dialplan'] }
    ]);
  });

  it('refuses to create a ring group whose name is already used by another live group', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await runOperation(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous' },
      asRun()
    );
    const attempt = runOperation(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'sequential' },
      asRun()
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a malformed external forwarding target with a validation error', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Bad target', strategy: 'simultaneous' },
      asRun()
    );
    const attempt = runOperation(
      db,
      'ringGroups.setForwarding',
      {
        id: group.id,
        rules: [
          {
            condition: 'unanswered',
            target: { kind: 'external', external: 'not-a-number' }
          }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('update replaces members as a whole and propagates pjsip', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      {
        name: 'Sales',
        strategy: 'sequential',
        members: [{ kind: 'user', id: 'owner' }]
      },
      asRun()
    );
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    await runOperation(
      db,
      'ringGroups.update',
      { id: group.id, members: [] },
      asRun()
    );
    const members = await db
      .selectFrom('ringGroupMembers')
      .selectAll()
      .where('groupId', '=', group.id)
      .execute();
    expect(members).toHaveLength(0);
    expect(propagated).toEqual([
      { operation: 'ringGroups.update', kind: ['pjsip'] }
    ]);
  });

  it('reads without a since-soft-deleted member and updates unchanged without a 404', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const memberId = newId();
    await db
      .insertInto('users')
      .values({
        id: memberId,
        name: 'Member',
        email: 'member@x',
        role: 'user',
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      {
        name: 'Support desk',
        strategy: 'simultaneous',
        members: [
          { kind: 'user', id: 'owner' },
          { kind: 'user', id: memberId }
        ]
      },
      asRun()
    );
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', memberId)
      .execute();
    const read = await runOperation<
      unknown,
      { members: { kind: string; id: string }[] }
    >(db, 'ringGroups.get', { id: group.id }, asRun());
    expect(read.members).toEqual([{ position: 0, kind: 'user', id: 'owner' }]);
    await expect(
      runOperation(
        db,
        'ringGroups.update',
        {
          id: group.id,
          members: read.members.map(({ kind, id }) => ({ kind, id }))
        },
        asRun()
      )
    ).resolves.toMatchObject({ id: group.id });
  });

  it('rejects an unknown field on create, setForwarding and delete (.strict())', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const createAttempt = runOperation(
      db,
      'ringGroups.create',
      { name: 'Extra', strategy: 'simultaneous', bogus: true },
      asRun()
    );
    await expect(createAttempt).rejects.toMatchObject({ status: 422 });
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Strict target', strategy: 'simultaneous' },
      asRun()
    );
    const forwardingAttempt = runOperation(
      db,
      'ringGroups.setForwarding',
      { id: group.id, rules: [], bogus: true },
      asRun()
    );
    await expect(forwardingAttempt).rejects.toMatchObject({ status: 422 });
    const deleteAttempt = runOperation(
      db,
      'ringGroups.delete',
      { id: group.id, bogus: true },
      asRun({ confirm: true })
    );
    await expect(deleteAttempt).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to delete a ring group a DID still targets, with a Conflict listing it', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Reception', strategy: 'simultaneous' },
      asRun()
    );
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: targetId,
        userId: null,
        ringGroupId: group.id,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: null,
        menuId: null
      })
      .execute();
    await db
      .insertInto('dids')
      .values({
        id: newId(),
        number: '+491234567',
        label: 'Main line',
        targetId,
        createdAt: nowIso()
      })
      .execute();
    const attempt = runOperation(
      db,
      'ringGroups.delete',
      { id: group.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest types expect.any() as `any`
      references: [{ kind: 'did', id: expect.any(String), label: 'Main line' }]
    });
  });

  it('allows deleting a ring group whose own opening-hours schedule closes to its own mailbox', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Own Schedule', strategy: 'simultaneous' },
      asRun()
    );
    const ownMailboxTargetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: ownMailboxTargetId,
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: group.id,
        announcementAudioId: null,
        menuId: null
      })
      .execute();
    await db
      .insertInto('openingHours')
      .values({
        id: newId(),
        scopeUserId: null,
        scopeRingGroupId: group.id,
        scopeMenuId: null,
        closedTargetId: ownMailboxTargetId,
        createdAt: nowIso()
      })
      .execute();
    await expect(
      runOperation(
        db,
        'ringGroups.delete',
        { id: group.id },
        asRun({ confirm: true })
      )
    ).resolves.toMatchObject({ id: group.id });
  });

  it('delete records the removed extension and BLF keys in the audit diff', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string; ext: string }>(
      db,
      'ringGroups.create',
      { name: 'Reception', strategy: 'simultaneous' },
      asRun()
    );
    const deviceId = newId();
    await db
      .insertInto('devices')
      .values({
        id: deviceId,
        userId: 'owner',
        label: 'Desk',
        kind: 'manual',
        transport: 'tls',
        allowedIpsJson: null,
        sipUsername: 'dev1',
        sipPasswordEnc: Buffer.from('x'),
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('deviceBlfKeys')
      .values({ deviceId, ext: group.ext, position: 1 })
      .execute();
    await runOperation(
      db,
      'ringGroups.delete',
      { id: group.id },
      asRun({ confirm: true })
    );
    expect(
      await db.selectFrom('extensions').selectAll().execute()
    ).toHaveLength(0);
    expect(
      await db.selectFrom('deviceBlfKeys').selectAll().execute()
    ).toHaveLength(0);
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('entityId', '=', group.id)
      .where('operation', '=', 'ringGroups.delete')
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    expect(changes.find(change => change.field === 'ext')).toMatchObject({
      from: group.ext,
      to: null
    });
    expect(
      changes.find(change => change.field === 'droppedBlfKeys')
    ).toMatchObject({
      from: [{ deviceId, ext: group.ext, position: 1 }],
      to: []
    });
  });

  it('setForwarding replaces the unanswered and unavailable rules as a whole', async () => {
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
        rules: [
          { condition: 'unanswered', target: { kind: 'user', userId: 'owner' } }
        ]
      },
      asRun()
    );
    const rules = await db
      .selectFrom('ringGroupForwardRules')
      .selectAll()
      .where('groupId', '=', group.id)
      .execute();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.condition).toBe('unanswered');
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('entityId', '=', group.id)
      .where('operation', '=', 'ringGroups.setForwarding')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(1);
    const changes = JSON.parse(audit.changesJson) as { field: string }[];
    expect(changes.find(change => change.field === 'rules')).toBeDefined();
  });

  it('setForwarding refuses two rules with the same condition, with a 422', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Duplicate condition', strategy: 'simultaneous' },
      asRun()
    );
    const attempt = runOperation(
      db,
      'ringGroups.setForwarding',
      {
        id: group.id,
        rules: [
          {
            condition: 'unanswered',
            target: { kind: 'user', userId: 'owner' }
          },
          {
            condition: 'unanswered',
            target: { kind: 'external', external: '+491111111' }
          }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('update refuses two members naming the same user, with a 422', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Duplicate member', strategy: 'simultaneous' },
      asRun()
    );
    const attempt = runOperation(
      db,
      'ringGroups.update',
      {
        id: group.id,
        members: [
          { kind: 'user', id: 'owner' },
          { kind: 'user', id: 'owner' }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('setForwarding refuses an unknown ring group id with a 404', async () => {
    const db = await makeTestDb();
    const attempt = runOperation(
      db,
      'ringGroups.setForwarding',
      { id: 'nope', rules: [] },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('setForwarding refuses a soft-deleted ring group with a 404', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Gone', strategy: 'simultaneous' },
      asRun()
    );
    await runOperation(
      db,
      'ringGroups.delete',
      { id: group.id },
      asRun({ confirm: true })
    );
    const attempt = runOperation(
      db,
      'ringGroups.setForwarding',
      { id: group.id, rules: [] },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('setForwarding refuses a rule targeting a soft-deleted ring group, with a 404', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Front desk', strategy: 'simultaneous' },
      asRun()
    );
    const deletedTarget = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Gone target', strategy: 'simultaneous' },
      asRun()
    );
    await runOperation(
      db,
      'ringGroups.delete',
      { id: deletedTarget.id },
      asRun({ confirm: true })
    );
    const attempt = runOperation(
      db,
      'ringGroups.setForwarding',
      {
        id: group.id,
        rules: [
          {
            condition: 'unanswered',
            target: { kind: 'ringGroup', ringGroupId: deletedTarget.id }
          }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
    const rows = await db
      .selectFrom('ringGroupForwardRules')
      .selectAll()
      .where('groupId', '=', group.id)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('setForwarding refuses a rule targeting an unknown user id, with a 404 rather than a raw DB error', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Sales', strategy: 'simultaneous' },
      asRun()
    );
    const attempt = runOperation(
      db,
      'ringGroups.setForwarding',
      {
        id: group.id,
        rules: [
          { condition: 'unanswered', target: { kind: 'user', userId: 'nope' } }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to create a ring group with an unknown greeting audio id, with a 404', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const attempt = runOperation(
      db,
      'ringGroups.create',
      {
        name: 'Bad greeting',
        strategy: 'simultaneous',
        greetingAudioId: 'nope'
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to create a ring group with an unknown member id, with a 404', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const attempt = runOperation(
      db,
      'ringGroups.create',
      {
        name: 'Bad member',
        strategy: 'simultaneous',
        members: [{ kind: 'user', id: 'nope' }]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });
  it('sets a diagnostics override and gives it a 7-day expiry (§7)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous' },
      asRun()
    );

    const out = await runOperation<
      unknown,
      { logLevel: string | null; logLevelExpiresAt: string | null }
    >(db, 'ringGroups.update', { id: group.id, logLevel: 'qos' }, asRun());

    expect(out.logLevel).toBe('qos');
    const expiresAt = Date.parse(out.logLevelExpiresAt ?? '');
    const sevenDaysMs = 7 * 86_400_000;
    expect(expiresAt - Date.now()).toBeGreaterThan(sevenDaysMs - 60_000);
    expect(expiresAt - Date.now()).toBeLessThan(sevenDaysMs + 60_000);
    const audit = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'ringGroups.update')
      .where('entityId', '=', group.id)
      .executeTakeFirstOrThrow();
    const fields = (JSON.parse(audit.changesJson) as { field: string }[]).map(
      change => change.field
    );
    expect(fields).toEqual(
      expect.arrayContaining(['logLevel', 'logLevelExpiresAt'])
    );
  });

  it('keeps an explicit override expiry and clears the override on null (§7)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      { name: 'Support', strategy: 'simultaneous' },
      asRun()
    );

    const set = await runOperation<
      unknown,
      { logLevel: string | null; logLevelExpiresAt: string | null }
    >(
      db,
      'ringGroups.update',
      {
        id: group.id,
        logLevel: 'events',
        logLevelExpiresAt: '2026-10-01T00:00:00.000Z'
      },
      asRun()
    );
    expect(set.logLevelExpiresAt).toBe('2026-10-01T00:00:00.000Z');

    const cleared = await runOperation<
      unknown,
      { logLevel: string | null; logLevelExpiresAt: string | null }
    >(db, 'ringGroups.update', { id: group.id, logLevel: null }, asRun());

    expect(cleared.logLevel).toBeNull();
    expect(cleared.logLevelExpiresAt).toBeNull();
  });
});
