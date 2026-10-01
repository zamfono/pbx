import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { installRingotelFake } from '$lib/server/provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '$lib/server/secretbox.js';
import { makeTestDb } from '$lib/server/testDb.js';

import { onPropagate, runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../devices/index.js';

import { setAccountLockLookup } from './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.test';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton, required by extension and phone-number checks. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
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

type CreateOutput = {
  user: { id: string; extension: string };
  setupLink: string;
};

async function createUser(
  db: Db,
  name: string,
  email: string,
  extension: string,
  role?: 'admin' | 'user'
): Promise<CreateOutput> {
  return runOperation<unknown, CreateOutput>(
    db,
    'users.create',
    { name, email, extension, role },
    asRun()
  );
}

/** Marks the tenant as already provisioned with Ringotel, so `activeRingotelProvider` pushes. */
async function enableRingotel(db: Db): Promise<void> {
  await db
    .updateTable('settings')
    .set({
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key')
    })
    .where('id', '=', 1)
    .execute();
}

type FetchCall = { method: string; params?: Record<string, unknown> };

/**
 * Stubs `globalThis.fetch` to record every Ringotel RPC call (§10.4), as `ops/provisioning`;
 * `createUser` answers with the new user's id, as the Admin API does.
 */
function stubFetch(overrides: Record<string, unknown> = {}): FetchCall[] {
  const results: Record<string, unknown> = {
    createUser: { id: 'ru-new' },
    ...overrides
  };
  const calls: FetchCall[] = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as FetchCall;
    calls.push(body);
    return Promise.resolve(
      new Response(JSON.stringify({ result: results[body.method] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('users', () => {
  it('create assigns an extension row and returns a setup link', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const result = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    expect(result.user.extension).toBe('101');
    expect(result.setupLink).toContain('token=');
    const ext = await db
      .selectFrom('extensions')
      .selectAll()
      .where('ext', '=', '101')
      .executeTakeFirstOrThrow();
    expect(ext.userId).toBe(result.user.id);
  });

  it('refuses a duplicate extension with 409', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await expect(
      createUser(db, 'Ben Roth', 'ben@x.test', '101')
    ).rejects.toMatchObject({
      status: 409
    });
  });

  it('refuses an extension that is one of the tenant emergency numbers', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    // Dialling resolves an emergency number before any extension (§9.4 "Dial-plan resolution"),
    // so such a user would never be reachable on it.
    await expect(
      createUser(db, 'Anna Huber', 'anna@x.test', '112')
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to delete a user another user still forwards to, listing that user', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const userA = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const userB = await createUser(db, 'Ben Roth', 'ben@x.test', '102');
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: userA.user.id,
        rules: [
          {
            condition: 'unconditional',
            target: { kind: 'user', userId: userB.user.id }
          }
        ]
      },
      asRun()
    );
    const attempt = runOperation(
      db,
      'users.delete',
      { id: userB.user.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'user', id: userA.user.id }]
    });
  });

  it('setForwarding records the replaced rules and targets, undoable', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const userA = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const userB = await createUser(db, 'Ben Roth', 'ben@x.test', '102');
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: userA.user.id,
        rules: [
          {
            condition: 'unconditional',
            target: { kind: 'user', userId: userB.user.id }
          }
        ]
      },
      asRun()
    );
    await runOperation(
      db,
      'users.setForwarding',
      { id: userA.user.id, rules: [] },
      asRun()
    );
    const audit = await db
      .selectFrom('auditLog')
      .select(['undoable', 'changesJson'])
      .where('operation', '=', 'users.setForwarding')
      .where('entityId', '=', userA.user.id)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(1);
    const change = (
      JSON.parse(audit.changesJson) as { field: string; from: unknown }[]
    ).find(entry => entry.field === 'rules');
    expect(change?.from).toEqual([
      {
        condition: 'unconditional',
        target: { kind: 'user', userId: userB.user.id }
      }
    ]);
  });

  it('delete cascades devices, the extension and tokens, recording all three in the audit diff', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const device = await runOperation<unknown, { device: { id: string } }>(
      db,
      'devices.create',
      { userId: user.user.id, label: 'Desk', kind: 'manual' },
      asRun()
    );
    const clientId = newId();
    await db
      .insertInto('oauthClients')
      .values({
        clientId,
        name: 'Test client',
        kind: 'cimd',
        redirectUrisJson: '[]',
        createdAt: nowIso(),
        lastLoginAt: nowIso()
      })
      .execute();
    await db
      .insertInto('tokens')
      .values({
        tokenHash: newId(),
        userId: user.user.id,
        kind: 'refresh',
        clientId,
        createdAt: nowIso(),
        expiresAt: nowIso()
      })
      .execute();
    await runOperation(
      db,
      'users.delete',
      { id: user.user.id },
      asRun({ confirm: true })
    );
    const deviceRow = await db
      .selectFrom('devices')
      .select('deletedAt')
      .where('id', '=', device.device.id)
      .executeTakeFirstOrThrow();
    expect(deviceRow.deletedAt).not.toBeNull();
    const ext = await db
      .selectFrom('extensions')
      .select('ext')
      .where('ext', '=', '101')
      .executeTakeFirst();
    expect(ext).toBeUndefined();
    const token = await db
      .selectFrom('tokens')
      .select('revokedAt')
      .where('userId', '=', user.user.id)
      .where('kind', '=', 'refresh')
      .executeTakeFirstOrThrow();
    expect(token.revokedAt).not.toBeNull();
    const audit = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'users.delete')
      .where('entityId', '=', user.user.id)
      .executeTakeFirstOrThrow();
    const fields = (JSON.parse(audit.changesJson) as { field: string }[]).map(
      change => change.field
    );
    expect(fields).toEqual(
      expect.arrayContaining(['devices', 'ext', 'tokensRevoked'])
    );
  });

  it('refuses a self-service update that carries an admin-only field, with 403', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(
      db,
      'Anna Huber',
      'anna@x.test',
      '101',
      'user'
    );
    const actor: Actor = { id: user.user.id, name: 'Anna Huber', role: 'user' };
    const attempt = runOperation(
      db,
      'users.update',
      { id: user.user.id, role: 'admin' },
      asRun({ actor })
    );
    await expect(attempt).rejects.toMatchObject({ status: 403 });
  });

  it('extension change renames every device sip_username and returns them', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const device = await runOperation<unknown, { sipUsername: string }>(
      db,
      'devices.create',
      { userId: user.user.id, label: 'Desk', kind: 'manual' },
      asRun()
    );
    expect(device.sipUsername.startsWith('e101-d')).toBe(true);
    const result = await runOperation<
      unknown,
      { affectedDevices?: { id: string; sipUsername: string }[] }
    >(db, 'users.update', { id: user.user.id, extension: '105' }, asRun());
    expect(result.affectedDevices).toHaveLength(1);
    expect(result.affectedDevices?.[0]?.sipUsername.startsWith('e105-d')).toBe(
      true
    );
    const row = await db
      .selectFrom('devices')
      .select('sipUsername')
      .where('userId', '=', user.user.id)
      .executeTakeFirstOrThrow();
    expect(row.sipUsername.startsWith('e105-d')).toBe(true);
    const audit = await db
      .selectFrom('auditLog')
      .select(['id', 'changesJson'])
      .where('operation', '=', 'users.update')
      .where('entityId', '=', user.user.id)
      .executeTakeFirstOrThrow();
    const extensionChange = (
      JSON.parse(audit.changesJson) as {
        field: string;
        from: unknown;
        to: unknown;
      }[]
    ).find(change => change.field === 'extension');
    expect(extensionChange).toEqual({
      field: 'extension',
      from: '101',
      to: '105'
    });
    const affectedDevicesChange = (
      JSON.parse(audit.changesJson) as { field: string; to: unknown }[]
    ).find(change => change.field === 'affectedDevices');
    expect(affectedDevicesChange?.to).toEqual(result.affectedDevices);
  });

  it('extension change moves the Ringotel user to the new extension and SIP username (§10.4)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await enableRingotel(db);
    const ringotel = installRingotelFake();
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const device = await runOperation<
      unknown,
      { device: { id: string; sipUsername: string } }
    >(
      db,
      'devices.create',
      { userId: user.user.id, label: 'App', kind: 'ringotel' },
      asRun()
    );
    // Ringotel holds the user under the old extension until the rename reaches it.
    expect(ringotel.users.map(remote => remote.extension)).toEqual(['101']);

    const renamed = await runOperation<
      unknown,
      { affectedDevices: { sipUsername: string }[] }
    >(db, 'users.update', { id: user.user.id, extension: '205' }, asRun());

    const newUsername = renamed.affectedDevices[0]?.sipUsername;
    expect(newUsername).toBe(
      device.device.sipUsername.replace(/^e101-/u, 'e205-')
    );
    expect(ringotel.users).toMatchObject([
      { extension: '205', username: newUsername, authname: newUsername }
    ]);
    // A later rotation finds the user at the new extension and reaches it.
    const rotated = await runOperation<unknown, { sipPassword: string }>(
      db,
      'devices.rotate',
      { id: device.device.id },
      asRun({ confirm: true })
    );
    expect(ringotel.users[0]?.password).toBe(rotated.sipPassword);
    ringotel.restore();
  });

  it('extension rename regenerates a device slug that would collide with another live device', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const userA = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const userB = await createUser(db, 'Ben Roth', 'ben@x.test', '102');
    const deviceA = await runOperation<unknown, { sipUsername: string }>(
      db,
      'devices.create',
      { userId: userA.user.id, label: 'Desk', kind: 'manual' },
      asRun()
    );
    // Another live device already holds the exact sip_username userA's device would naively take
    // on by keeping its own slug and adopting the target ext '999' (unused, so the rename itself
    // is otherwise unconstrained); users.update must fall back to a fresh slug instead of erroring.
    const collidingUsername = deviceA.sipUsername.replace('e101-', 'e999-');
    await db
      .insertInto('devices')
      .values({
        id: newId(),
        userId: userB.user.id,
        label: 'Other',
        kind: 'manual',
        transport: 'tls',
        allowedIpsJson: null,
        sipUsername: collidingUsername,
        sipPasswordEnc: Buffer.from('x'),
        createdAt: nowIso()
      })
      .execute();
    const result = await runOperation<
      unknown,
      { affectedDevices?: { id: string; sipUsername: string }[] }
    >(db, 'users.update', { id: userA.user.id, extension: '999' }, asRun());
    expect(result.affectedDevices?.[0]?.sipUsername.startsWith('e999-')).toBe(
      true
    );
    expect(result.affectedDevices?.[0]?.sipUsername).not.toBe(
      collidingUsername
    );
    const rows = await db.selectFrom('devices').select('sipUsername').execute();
    const usernames = rows.map(row => row.sipUsername);
    expect(new Set(usernames).size).toBe(usernames.length);
  });

  it('records boolean field changes as wire booleans, not storage 0/1', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'users.update',
      { id: user.user.id, clir: true, mailboxEnabled: false },
      asRun()
    );
    const audit = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'users.update')
      .where('entityId', '=', user.user.id)
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: 'clir', from: null, to: true },
        { field: 'mailboxEnabled', from: true, to: false }
      ])
    );
  });

  it('refuses a calleridDidId that names no live DID, and accepts a live numeric one', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await expect(
      runOperation(
        db,
        'users.update',
        { id: user.user.id, calleridDidId: 'missing' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    const did = await db
      .selectFrom('dids')
      .select('id')
      .where('number', '=', '+490000000')
      .executeTakeFirstOrThrow();
    const result = await runOperation<
      unknown,
      { user: { calleridDidId: string | null } }
    >(db, 'users.update', { id: user.user.id, calleridDidId: did.id }, asRun());
    expect(result.user.calleridDidId).toBe(did.id);
  });

  it('refuses a calleridDidId naming a soft-deleted DID', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const deletedDidId = newId();
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, external: '+491111111' })
      .execute();
    await db
      .insertInto('dids')
      .values({
        id: deletedDidId,
        number: '+491111111',
        label: null,
        targetId,
        createdAt: nowIso(),
        deletedAt: nowIso()
      })
      .execute();
    await expect(
      runOperation(
        db,
        'users.update',
        { id: user.user.id, calleridDidId: deletedDidId },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a mailboxAudioId that names no live audio asset', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await expect(
      runOperation(
        db,
        'users.update',
        { id: user.user.id, mailboxAudioId: 'missing' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 404 });
    await db
      .insertInto('audioAssets')
      .values({
        id: 'deleted-audio',
        label: 'Old greeting',
        kind: 'vmGreeting',
        filename: 'old.wav',
        createdAt: nowIso(),
        deletedAt: nowIso()
      })
      .execute();
    await expect(
      runOperation(
        db,
        'users.update',
        { id: user.user.id, mailboxAudioId: 'deleted-audio' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a findMe leg whose number is not E.164', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await expect(
      runOperation(
        db,
        'users.update',
        { id: user.user.id, findMe: [{ number: 'abc', delayS: 0 }] },
        asRun()
      )
    ).rejects.toThrow();
  });

  it('erases a non-owner and scrubs their name, email and findMe from the audit diff', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(
      db,
      'Anna Huber',
      'anna@x.test',
      '101',
      'user'
    );
    await runOperation(
      db,
      'users.update',
      { id: user.user.id, findMe: [{ number: '+490000001', delayS: 5 }] },
      asRun()
    );
    await runOperation(
      db,
      'users.erase',
      { id: user.user.id },
      asRun({ confirm: true })
    );
    const row = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', user.user.id)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).not.toBeNull();
    const entries = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('entityKind', '=', 'user')
      .where('entityId', '=', user.user.id)
      .execute();
    const changes = entries.flatMap(
      entry =>
        JSON.parse(entry.changesJson) as {
          field: string;
          from: unknown;
          to: unknown;
        }[]
    );
    for (const change of changes) {
      if (['name', 'email', 'findMe'].includes(change.field)) {
        expect(change.from).toBe('***');
        expect(change.to).toBe('***');
      }
    }
  });

  it("scrubs the external numbers of the user's forward rules from the audit diff", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(
      db,
      'Anna Huber',
      'anna@x.test',
      '101',
      'user'
    );
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: user.user.id,
        rules: [
          {
            condition: 'unconditional',
            target: { kind: 'external', external: '+4917012345678' }
          }
        ]
      },
      asRun()
    );

    await runOperation(
      db,
      'users.erase',
      { id: user.user.id },
      asRun({ confirm: true })
    );

    const entry = await db
      .selectFrom('auditLog')
      .select(['changesJson', 'undoable'])
      .where('operation', '=', 'users.setForwarding')
      .where('entityId', '=', user.user.id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toEqual([
      { field: 'rules', from: '***', to: '***' }
    ]);
    expect(entry.undoable).toBe(0);
  });

  // §5.10: "The erase call is itself audited, content-masked, `undoable=0`."
  it("masks the erase call's own audit entry, cascade included", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'devices.create',
      { userId: user.user.id, label: 'Anna desk phone', kind: 'manual' },
      asRun()
    );
    await runOperation(
      db,
      'users.erase',
      { id: user.user.id },
      asRun({ confirm: true })
    );
    const entry = await db
      .selectFrom('auditLog')
      .select(['changesJson', 'undoable'])
      .where('operation', '=', 'users.erase')
      .executeTakeFirstOrThrow();
    expect(entry.undoable).toBe(0);
    expect(entry.changesJson).not.toContain('Anna desk phone');
    expect(entry.changesJson).not.toContain('e101-');
    expect(entry.changesJson).not.toContain('"101"');
    const changes = JSON.parse(entry.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change).toEqual({ field: change.field, from: '***', to: '***' });
    }
  });

  it('refuses to erase a user another user still forwards to, listing that user', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const userA = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const userB = await createUser(db, 'Ben Roth', 'ben@x.test', '102');
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: userA.user.id,
        rules: [
          {
            condition: 'unconditional',
            target: { kind: 'user', userId: userB.user.id }
          }
        ]
      },
      asRun()
    );
    const attempt = runOperation(
      db,
      'users.erase',
      { id: userB.user.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'user', id: userA.user.id }]
    });
  });

  it("refuses to erase the tenant's last live owner, with 409", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const owningUser = await createUser(
      db,
      'Own Er',
      'owner2@x.test',
      '101',
      'admin'
    );
    await db
      .updateTable('users')
      .set({ role: 'owner', passwordHash: 'x' })
      .where('id', '=', owningUser.user.id)
      .execute();
    // `makeTestDb` seeds its own live `owner` row; demote it so `owningUser` is the only one left.
    await db
      .updateTable('users')
      .set({ role: 'admin' })
      .where('id', '=', 'owner')
      .execute();
    await expect(
      runOperation(
        db,
        'users.erase',
        { id: owningUser.user.id },
        asRun({ confirm: true })
      )
    ).rejects.toMatchObject({ status: 409 });
    const row = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', owningUser.user.id)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).toBeNull();
  });

  it('setPresence writes no audit row', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'users.setPresence',
      { id: user.user.id, dnd: true },
      asRun()
    );
    const rows = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'users.setPresence')
      .execute();
    expect(rows).toHaveLength(0);
    const row = await db
      .selectFrom('users')
      .select('dnd')
      .where('id', '=', user.user.id)
      .executeTakeFirstOrThrow();
    expect(row.dnd).toBe(1);
  });

  it('renaming the person re-renders PJSIP, whose endpoints carry the name as caller ID (§9.3)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const kinds: string[][] = [];
    onPropagate(change => {
      if (change.operation === 'users.update') {
        kinds.push(change.kind);
      }
      return Promise.resolve();
    });
    await runOperation(
      db,
      'users.update',
      { id: user.user.id, name: 'Anna Berger' },
      asRun()
    );
    await runOperation(
      db,
      'users.update',
      { id: user.user.id, ringTimeoutS: 30 },
      asRun()
    );
    expect(kinds).toEqual([['pjsip'], []]);
  });

  it("setPresence propagates, so core recomputes the user's presence (§3.1, §10.2)", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const propagated: string[] = [];
    onPropagate(change => {
      propagated.push(change.operation);
      return Promise.resolve();
    });
    await runOperation(
      db,
      'users.setPresence',
      { id: user.user.id, dnd: true },
      asRun()
    );
    expect(propagated).toContain('users.setPresence');
  });
  it('delete frees the Ringotel user of a ringotel device (§10.4 lifecycle)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await enableRingotel(db);
    const calls = stubFetch({ getUsers: [{ id: 'ru-1', extension: '101' }] });
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'devices.create',
      { userId: user.user.id, label: 'App', kind: 'ringotel' },
      asRun()
    );
    const callsBeforeDelete = calls.length;

    await runOperation(
      db,
      'users.delete',
      { id: user.user.id },
      asRun({ confirm: true })
    );

    const deletion = calls
      .slice(callsBeforeDelete)
      .find(call => call.method === 'deleteUser');
    expect(deletion?.params?.id).toBe('ru-1');
  });

  it('erase frees the Ringotel user of a ringotel device (§10.4 lifecycle)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await enableRingotel(db);
    const calls = stubFetch({ getUsers: [{ id: 'ru-2', extension: '101' }] });
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'devices.create',
      { userId: user.user.id, label: 'App', kind: 'ringotel' },
      asRun()
    );
    const callsBeforeErase = calls.length;

    await runOperation(
      db,
      'users.erase',
      { id: user.user.id },
      asRun({ confirm: true })
    );

    const deletion = calls
      .slice(callsBeforeErase)
      .find(call => call.method === 'deleteUser');
    expect(deletion?.params?.id).toBe('ru-2');
  });

  it('the setup link points at the set-password page', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const result = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    expect(result.setupLink).toMatch(
      /^https:\/\/pbx\.example\.test\/auth\/set-password\?token=/u
    );
  });
  it('a name change re-pushes the roster with the stored display name (§10.4)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await enableRingotel(db);
    const calls = stubFetch({ getUsers: [{ id: 'ru-1', extension: '105' }] });
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'devices.create',
      { userId: user.user.id, label: 'App', kind: 'ringotel' },
      asRun()
    );
    const callsBeforeUpdate = calls.length;

    await runOperation(
      db,
      'users.update',
      { id: user.user.id, name: 'Anna Neu', extension: '105' },
      asRun()
    );

    const push = calls
      .slice(callsBeforeUpdate)
      .find(call => call.method === 'updateBranch');
    const provision = push?.params?.provision as {
      blfs: { number: string; title: string }[];
    };
    expect(provision.blfs).toContainEqual({ number: '105', title: 'Anna Neu' });
  });

  it('a rename without an extension change still re-pushes the roster (§10.4)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await enableRingotel(db);
    const calls = stubFetch({ getUsers: [{ id: 'ru-1', extension: '101' }] });
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    await runOperation(
      db,
      'devices.create',
      { userId: user.user.id, label: 'App', kind: 'ringotel' },
      asRun()
    );
    const callsBeforeUpdate = calls.length;

    await runOperation(
      db,
      'users.update',
      { id: user.user.id, name: 'Anna Neu' },
      asRun()
    );

    const push = calls
      .slice(callsBeforeUpdate)
      .find(call => call.method === 'updateBranch');
    const provision = push?.params?.provision as {
      blfs: { number: string; title: string }[];
    };
    expect(provision.blfs).toContainEqual({ number: '101', title: 'Anna Neu' });
  });
  it("a soft-deleted user's own OOO rule leaves another user's delete free (§5.9)", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const anna = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const ben = await createUser(db, 'Ben Roth', 'ben@x.test', '102');
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, userId: ben.user.id })
      .execute();
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: anna.user.id,
        targetId,
        createdAt: nowIso()
      })
      .execute();
    await expect(
      runOperation(
        db,
        'users.delete',
        { id: ben.user.id },
        asRun({ confirm: true })
      )
    ).rejects.toMatchObject({ status: 409 });

    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', anna.user.id)
      .execute();

    const deleted = await runOperation<unknown, { id: string }>(
      db,
      'users.delete',
      { id: ben.user.id },
      asRun({ confirm: true })
    );
    expect(deleted.id).toBe(ben.user.id);
  });

  it("a soft-deleted user's own opening hours leave another user's delete free (§5.9)", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const anna = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    const ben = await createUser(db, 'Ben Roth', 'ben@x.test', '102');
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({ id: targetId, userId: ben.user.id })
      .execute();
    await db
      .insertInto('openingHours')
      .values({
        id: newId(),
        scopeUserId: anna.user.id,
        closedTargetId: targetId,
        createdAt: nowIso()
      })
      .execute();
    await expect(
      runOperation(
        db,
        'users.delete',
        { id: ben.user.id },
        asRun({ confirm: true })
      )
    ).rejects.toMatchObject({ status: 409 });

    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', anna.user.id)
      .execute();

    const deleted = await runOperation<unknown, { id: string }>(
      db,
      'users.delete',
      { id: ben.user.id },
      asRun({ confirm: true })
    );
    expect(deleted.id).toBe(ben.user.id);
  });
  it('carries an active account lock on the user record (§5.5)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');
    setAccountLockLookup(email =>
      email === 'anna@x.test' ? { until: '2026-09-22T12:15:00.000Z' } : null
    );

    try {
      const read = await runOperation<unknown, { lockedUntil: string | null }>(
        db,
        'users.get',
        { id: user.user.id },
        asRun()
      );
      expect(read.lockedUntil).toBe('2026-09-22T12:15:00.000Z');
    } finally {
      setAccountLockLookup(undefined);
    }
  });

  it('reports no lock on the user record while the account is unlocked (§5.5)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');

    const read = await runOperation<unknown, { lockedUntil: string | null }>(
      db,
      'users.get',
      { id: user.user.id },
      asRun()
    );

    expect(read.lockedUntil).toBeNull();
  });
  it('sets a diagnostics override on a user and gives it a 7-day expiry (§7)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(db, 'Anna Huber', 'anna@x.test', '101');

    const out = await runOperation<
      unknown,
      { user: { logLevel: string | null; logLevelExpiresAt: string | null } }
    >(db, 'users.update', { id: user.user.id, logLevel: 'events' }, asRun());

    expect(out.user.logLevel).toBe('events');
    const expiresAt = Date.parse(out.user.logLevelExpiresAt ?? '');
    const sevenDaysMs = 7 * 86_400_000;
    expect(expiresAt - Date.now()).toBeGreaterThan(sevenDaysMs - 60_000);
    expect(expiresAt - Date.now()).toBeLessThan(sevenDaysMs + 60_000);
  });

  it('refuses a diagnostics override for a user actor, admin-only (§5.3)', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const user = await createUser(
      db,
      'Anna Huber',
      'anna@x.test',
      '101',
      'user'
    );

    const attempt = runOperation(
      db,
      'users.update',
      { id: user.user.id, logLevel: 'qos' },
      asRun({
        actor: { id: user.user.id, name: 'Anna Huber', role: 'user' }
      })
    );

    await expect(attempt).rejects.toMatchObject({ status: 403 });
  });
});
