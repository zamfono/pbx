import { describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { propagateConfig } from '#lib/server/propagation.js';
import {
  asConfirmedRun,
  makeTestDb,
  seedSettings
} from '#lib/server/testDb.js';

import type { HoursWire } from '../hours/get.js';
import { runOperation } from '../runner.js';

import '../blockedNumbers/index.js';
import '../devices/index.js';
import '../didBlocks/index.js';
import '../dids/index.js';
import '../hours/index.js';
import '../menus/index.js';
import '../ooo/index.js';
import '../settings/index.js';
import '../users/index.js';
import './index.js';

async function createUser(
  db: Db,
  name: string,
  email: string,
  extension: string
): Promise<{ id: string }> {
  const result = (await runOperation(
    db,
    'users.create',
    { name, email, extension },
    asConfirmedRun()
  )) as { user: { id: string } };
  return result.user;
}

/** The single audit row a call just wrote for `entityId`, most recent first. */
async function latestAuditEntry(
  db: Db,
  entityId: string
): Promise<{ id: string; undoneAt: string | null; undoable: number }> {
  return db
    .selectFrom('auditLog')
    .select(['id', 'undoneAt', 'undoable'])
    .where('entityId', '=', entityId)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
}

describe('audit.undo', () => {
  it('restores a plain field change and writes the undo row', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'users.update',
      { id: user.id, name: 'Anna Berger' },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, user.id);

    const result = (await runOperation(
      db,
      'audit.undo',
      { id: entry.id },
      asConfirmedRun()
    )) as { id: string };
    expect(result.id).toBe(entry.id);

    const row = await db
      .selectFrom('users')
      .select('name')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe('Anna Huber');
    const reverted = await db
      .selectFrom('auditLog')
      .select('undoneAt')
      .where('id', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(reverted.undoneAt).not.toBeNull();
    const undoEntry = await db
      .selectFrom('auditLog')
      .select(['operation', 'channel', 'revertsId', 'undoable'])
      .where('revertsId', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(undoEntry).toEqual({
      operation: 'audit.undo',
      channel: 'undo',
      revertsId: entry.id,
      undoable: 0
    });
  });

  it("leaves the undo row's client columns NULL, even when a client calls it", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'users.update',
      { id: user.id, name: 'Anna Berger' },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, user.id);

    await runOperation(
      db,
      'audit.undo',
      { id: entry.id },
      asConfirmedRun({
        channel: 'mcp',
        clientId: 'client-1',
        clientName: 'Assistant'
      })
    );

    const undoEntry = await db
      .selectFrom('auditLog')
      .select(['clientId', 'clientName'])
      .where('revertsId', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(undoEntry).toEqual({ clientId: null, clientName: null });
  });

  it('refuses undo with 409 while a later live change exists for the entity', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'users.update',
      { id: user.id, name: 'Anna Berger' },
      asConfirmedRun()
    );
    const first = await latestAuditEntry(db, user.id);
    await runOperation(
      db,
      'users.update',
      { id: user.id, name: 'Anna Carell' },
      asConfirmedRun()
    );
    const second = await latestAuditEntry(db, user.id);

    await expect(
      runOperation(db, 'audit.undo', { id: first.id }, asConfirmedRun())
    ).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'auditLog', id: second.id }] }
    });
  });

  it('re-inserts the extension and devices an undone user deletion had dropped', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const device = (await runOperation(
      db,
      'devices.create',
      { userId: user.id, label: 'Desk phone', kind: 'manual' },
      asConfirmedRun()
    )) as { device: { id: string } };
    await runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun());
    const entry = await latestAuditEntry(db, user.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const userRow = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(userRow.deletedAt).toBeNull();
    const ext = await db
      .selectFrom('extensions')
      .select('userId')
      .where('ext', '=', '101')
      .executeTakeFirstOrThrow();
    expect(ext.userId).toBe(user.id);
    const deviceRow = await db
      .selectFrom('devices')
      .select('deletedAt')
      .where('id', '=', device.device.id)
      .executeTakeFirstOrThrow();
    expect(deviceRow.deletedAt).toBeNull();
  });

  it('notifies pjsip/dialplan propagation when undoing a user deletion', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun());
    const entry = await latestAuditEntry(db, user.id);
    vi.mocked(propagateConfig).mockClear();

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    expect(vi.mocked(propagateConfig).mock.calls).toEqual([
      [db, ['pjsip', 'dialplan']]
    ]);
  });

  it('refuses undo with 409 once another user has taken the freed e-mail', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun());
    const entry = await latestAuditEntry(db, user.id);
    const other = await createUser(db, 'Bea Nolte', 'anna@x.test', '102');

    await expect(
      runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun())
    ).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'user', id: other.id }] }
    });
  });

  it('refuses undo with 409 once another user has taken the freed extension', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun());
    const entry = await latestAuditEntry(db, user.id);
    await createUser(db, 'Bea Nolte', 'bea@x.test', '101');

    await expect(
      runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun())
    ).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'extension', id: '101' }] }
    });
  });

  it('reverts a creation entry by deleting the row it created', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const entry = await latestAuditEntry(db, user.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const row = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).not.toBeNull();
  });

  it('reverts a plain settings field change', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await runOperation(
      db,
      'settings.update',
      { voicemailMaxS: 240 },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, 'settings');

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const row = await db
      .selectFrom('settings')
      .select('voicemailMaxS')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row.voicemailMaxS).not.toBe(240);
  });

  it('reverts a blocklist entry deletion', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const blocked = (await runOperation(
      db,
      'blockedNumbers.create',
      { number: '+491234567' },
      asConfirmedRun()
    )) as { id: string };
    await runOperation(
      db,
      'blockedNumbers.delete',
      { id: blocked.id },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, blocked.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const row = await db
      .selectFrom('blockedNumbers')
      .select('deletedAt')
      .where('id', '=', blocked.id)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).toBeNull();
  });

  it('refuses undo of a masked, secret-bearing change', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const device = (await runOperation(
      db,
      'devices.create',
      { userId: user.id, label: 'Desk phone', kind: 'manual' },
      asConfirmedRun()
    )) as { device: { id: string } };
    await runOperation(
      db,
      'devices.rotate',
      { id: device.device.id },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, device.device.id);

    await expect(
      runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun())
    ).rejects.toMatchObject({
      status: 409,
      title: 'audit entry is not undoable'
    });
  });
});

describe('audit.list', () => {
  it('filters by entity and hides undone entries by default', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await createUser(db, 'Bea Nolte', 'bea@x.test', '102');
    await runOperation(
      db,
      'users.update',
      { id: user.id, name: 'Anna Berger' },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, user.id);
    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const live = (await runOperation(
      db,
      'audit.list',
      { entityKind: 'user', entityId: user.id },
      asConfirmedRun()
    )) as { items: { entityId: string | null; operation: string }[] };
    expect(live.items.map(item => item.operation)).toEqual([
      'audit.undo',
      'users.create'
    ]);

    const all = (await runOperation(
      db,
      'audit.list',
      { entityKind: 'user', entityId: user.id, state: 'all' },
      asConfirmedRun()
    )) as { items: { operation: string }[] };
    expect(all.items.map(item => item.operation)).toEqual([
      'audit.undo',
      'users.update',
      'users.create'
    ]);
  });
});

describe('audit.list time range', () => {
  it('compares `from` and `to` with an offset as the instants they name, and refuses a non-instant', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const createdAts = [
      '2026-10-01T09:59:59.999Z',
      '2026-10-01T10:00:00.000Z',
      '2026-10-01T11:00:00.000Z'
    ];
    await db
      .insertInto('auditLog')
      .values(
        createdAts.map((createdAt, index) => ({
          id: newId(),
          actorUserId: 'owner',
          actorUserName: 'Owner',
          channel: 'rest',
          clientId: null,
          clientName: null,
          operation: `op.${String(index)}`,
          entityKind: 'user',
          entityId: null,
          changesJson: '[]',
          revertsId: null,
          createdAt
        }))
      )
      .execute();

    const result = (await runOperation(
      db,
      'audit.list',
      { from: '2026-10-01T12:00:00+02:00', to: '2026-10-01T11:00:00Z' },
      asConfirmedRun()
    )) as { items: { operation: string }[] };
    const attempt = runOperation(
      db,
      'audit.list',
      { from: '1 Oct' },
      asConfirmedRun()
    );

    expect(result.items.map(item => item.operation)).toEqual(['op.1']);
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('reads a date alone in the tenant zone, a `to` date covering the whole day', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { timezone: 'Europe/Berlin' });
    const createdAts = [
      '2026-09-30T21:59:59.999Z',
      '2026-09-30T22:00:00.000Z',
      '2026-10-01T10:00:00.000Z',
      '2026-10-01T21:59:59.999Z',
      '2026-10-01T22:00:00.000Z'
    ];
    await db
      .insertInto('auditLog')
      .values(
        createdAts.map((createdAt, index) => ({
          id: newId(),
          actorUserId: 'owner',
          actorUserName: 'Owner',
          channel: 'rest',
          clientId: null,
          clientName: null,
          operation: `op.${String(index)}`,
          entityKind: 'user',
          entityId: null,
          changesJson: '[]',
          revertsId: null,
          createdAt
        }))
      )
      .execute();

    const result = (await runOperation(
      db,
      'audit.list',
      { from: '2026-10-01', to: '2026-10-01' },
      asConfirmedRun()
    )) as { items: { operation: string }[] };

    expect(result.items.map(item => item.operation).sort()).toEqual([
      'op.1',
      'op.2',
      'op.3'
    ]);
  });
});

/** Inserts one live `audio_assets` row of kind `announcement`, a menu's required greeting. */
async function seedAnnouncement(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id,
      label: 'Greeting',
      kind: 'announcement',
      filename: `${id}.wav`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** The external number a forward-target column of `table`.`column` currently points at. */
async function externalOf(db: Db, targetId: string): Promise<string | null> {
  const row = await db
    .selectFrom('forwardTargets')
    .select('external')
    .where('id', '=', targetId)
    .executeTakeFirstOrThrow();
  return row.external;
}

describe('audit.undo of a forward-target change', () => {
  it('restores the DID target a retarget replaced', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const did = (await runOperation(
      db,
      'dids.create',
      {
        number: '+4989000001',
        target: { kind: 'external', external: '+491111111' }
      },
      asConfirmedRun()
    )) as { id: string };
    await runOperation(
      db,
      'dids.update',
      { id: did.id, target: { kind: 'external', external: '+492222222' } },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, did.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const row = await db
      .selectFrom('dids')
      .select('targetId')
      .where('id', '=', did.id)
      .executeTakeFirstOrThrow();
    expect(await externalOf(db, row.targetId)).toBe('+491111111');
  });

  it('restores the out-of-office target a retarget replaced', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const rule = (await runOperation(
      db,
      'ooo.create',
      {
        scope: { kind: 'tenant' },
        target: { kind: 'external', external: '+491111111' }
      },
      asConfirmedRun()
    )) as { id: string };
    await runOperation(
      db,
      'ooo.update',
      { id: rule.id, target: { kind: 'external', external: '+492222222' } },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, rule.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const row = await db
      .selectFrom('oooRules')
      .select('targetId')
      .where('id', '=', rule.id)
      .executeTakeFirstOrThrow();
    expect(await externalOf(db, row.targetId)).toBe('+491111111');
  });

  it('restores the number block fallback target a retarget replaced', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const block = (await runOperation(
      db,
      'didBlocks.create',
      {
        base: '+498912',
        fallbackTarget: { kind: 'external', external: '+491111111' }
      },
      asConfirmedRun()
    )) as { id: string };
    await runOperation(
      db,
      'didBlocks.update',
      {
        id: block.id,
        fallbackTarget: { kind: 'external', external: '+492222222' }
      },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, block.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const row = await db
      .selectFrom('didBlocks')
      .select('fallbackTargetId')
      .where('id', '=', block.id)
      .executeTakeFirstOrThrow();
    expect(await externalOf(db, row.fallbackTargetId ?? '')).toBe('+491111111');
  });

  it('restores the menu fallback target a retarget replaced', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAnnouncement(db);
    const menu = (await runOperation(
      db,
      'menus.create',
      {
        name: 'Main menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+491111111' }
      },
      asConfirmedRun()
    )) as { id: string };
    await runOperation(
      db,
      'menus.update',
      {
        id: menu.id,
        fallbackTarget: { kind: 'external', external: '+492222222' }
      },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, menu.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const row = await db
      .selectFrom('menus')
      .select('fallbackTargetId')
      .where('id', '=', menu.id)
      .executeTakeFirstOrThrow();
    expect(await externalOf(db, row.fallbackTargetId)).toBe('+491111111');
  });
});

describe('audit.undo of an entry it cannot replay', () => {
  it('refuses with 409 and leaves the entry live', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const id = newId();
    await db
      .insertInto('auditLog')
      .values({
        id,
        actorUserId: 'owner',
        actorUserName: 'Owner',
        channel: 'rest',
        clientId: null,
        clientName: null,
        operation: 'users.update',
        entityKind: 'user',
        entityId: user.id,
        // A field no `users.update` input carries: §5.8 answers 409 rather than replaying a diff
        // the owning operation cannot accept. (`logLevel` is a real input, so it replays.)
        changesJson: JSON.stringify([
          { field: 'lastSeenAt', from: null, to: '2026-01-01T00:00:00.000Z' }
        ]),
        undoable: 1,
        revertsId: null,
        undoneAt: null,
        createdAt: nowIso()
      })
      .execute();

    await expect(
      runOperation(db, 'audit.undo', { id }, asConfirmedRun())
    ).rejects.toMatchObject({ status: 409 });

    const row = await db
      .selectFrom('auditLog')
      .select('undoneAt')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.undoneAt).toBeNull();
  });

  it('refuses with 409 once another user has taken the freed SSO subject', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await db
      .updateTable('users')
      .set({ ssoSubject: 'subject-1' })
      .where('id', '=', user.id)
      .execute();
    await runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun());
    const entry = await latestAuditEntry(db, user.id);
    const other = await createUser(db, 'Bea Nolte', 'bea@x.test', '102');
    await db
      .updateTable('users')
      .set({ ssoSubject: 'subject-1' })
      .where('id', '=', other.id)
      .execute();

    await expect(
      runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun())
    ).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'user', id: other.id }] }
    });
  });
});

describe('audit.undo of an opening-hours change', () => {
  it('restores the schedule the previous set replaced', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const first = (await runOperation(
      db,
      'hours.set',
      {
        scope: { kind: 'tenant' },
        closedTarget: { kind: 'external', external: '+491111111' },
        intervals: [{ weekday: 1, opens: '09:00', closes: '17:00' }]
      },
      asConfirmedRun()
    )) as HoursWire;
    await runOperation(
      db,
      'hours.set',
      {
        scope: { kind: 'tenant' },
        active: false,
        closedTarget: { kind: 'external', external: '+492222222' },
        intervals: [{ weekday: 2, opens: '10:00', closes: '12:00' }]
      },
      asConfirmedRun()
    );
    const entry = await latestAuditEntry(db, first.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const read = (await runOperation(
      db,
      'hours.get',
      { scope: { kind: 'tenant' } },
      asConfirmedRun()
    )) as { schedule: HoursWire | null };
    expect(read.schedule).toMatchObject({
      active: true,
      closedTarget: { kind: 'external', external: '+491111111' },
      intervals: [{ weekday: 1, opens: '09:00', closes: '17:00' }]
    });
  });

  it('removes the schedule when undoing the entry that first set it', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const set = (await runOperation(
      db,
      'hours.set',
      {
        scope: { kind: 'tenant' },
        closedTarget: { kind: 'external', external: '+491111111' },
        intervals: [{ weekday: 1, opens: '09:00', closes: '17:00' }]
      },
      asConfirmedRun()
    )) as HoursWire;
    const entry = await latestAuditEntry(db, set.id);

    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());

    const read = (await runOperation(
      db,
      'hours.get',
      { scope: { kind: 'tenant' } },
      asConfirmedRun()
    )) as { schedule: HoursWire | null };
    expect(read.schedule).toBeNull();
  });
});
