import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import { sha256Hex } from '#lib/server/hash.js';
import { provisioningFile } from '#lib/server/provisioning/link.js';
import { asConfirmedRun, asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../index.js';

beforeEach(() => {
  vi.stubEnv('FQDN', 'pbx.example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type Created = {
  device: { id: string };
  connectionSettings: { adminPassword: string | null };
  provisioningLink?: string;
};

/** Anna Huber at extension 205. Returns her id. */
async function seedAnna(db: Db): Promise<string> {
  await seedSettings(db, {});
  return seedUser(db, { name: 'Anna Huber', email: 'anna@x.test', ext: '205' });
}

async function create(db: Db, userId: string, kind: string): Promise<Created> {
  return (await runOperation(
    db,
    'devices.create',
    { userId, label: 'Desk', kind },
    asRun()
  )) as Created;
}

/** The token of link `url`, after checking its shape. */
function tokenOf(url: string | undefined): string {
  const match =
    /^https:\/\/pbx\.example\.com\/provision\/(?<token>[A-Za-z0-9_-]{43})\/$/u.exec(
      url ?? ''
    );
  expect(match).not.toBeNull();
  return match?.groups?.token ?? '';
}

/** A `yealink` device of Anna's and its link's token. */
async function seedDesk(db: Db): Promise<{ id: string; token: string }> {
  const created = await create(db, await seedAnna(db), 'yealink');
  return { id: created.device.id, token: tokenOf(created.provisioningLink) };
}

async function newLink(db: Db, id: string): Promise<string> {
  const { url } = (await runOperation(
    db,
    'devices.provisioningLink',
    { id },
    asRun()
  )) as { url: string };
  return tokenOf(url);
}

const cfg = (db: Db, token: string): Promise<string | null> =>
  provisioningFile(db, token, 'y000000000000.cfg', '203.0.113.9');

describe('a yealink device (§10.4 "`yealink`")', () => {
  it('is created with its link, of which it keeps only the hash, and an admin password', async () => {
    const db = await makeTestDb();
    const created = await create(db, await seedAnna(db), 'yealink');
    const token = tokenOf(created.provisioningLink);
    const row = await db
      .selectFrom('devices')
      .select('provisioningTokenHash')
      .where('id', '=', created.device.id)
      .executeTakeFirstOrThrow();
    expect(row.provisioningTokenHash).toBe(sha256Hex(token));
    expect(created.connectionSettings.adminPassword).toMatch(
      /^[A-Za-z0-9]{24}$/u
    );
    const revealed = (await runOperation(
      db,
      'devices.revealCredentials',
      { id: created.device.id },
      asRun()
    )) as { adminPassword: string | null };
    expect(revealed.adminPassword).toBe(
      created.connectionSettings.adminPassword
    );
  });

  it('a manual device has neither link nor admin password, and gets no new link', async () => {
    const db = await makeTestDb();
    const created = await create(db, await seedAnna(db), 'manual');
    expect(created.provisioningLink).toBeUndefined();
    expect(created.connectionSettings.adminPassword).toBeNull();
    await expect(
      runOperation(
        db,
        'devices.provisioningLink',
        { id: created.device.id },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('is refused on plain transport, which is for manual devices alone', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'devices.create',
        {
          userId: await seedAnna(db),
          label: 'Desk',
          kind: 'yealink',
          transport: 'plain',
          allowedIps: ['203.0.113.7']
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('a new link revokes the one before, and deleting the device revokes it', async () => {
    const db = await makeTestDb();
    const { id, token: first } = await seedDesk(db);
    const second = await newLink(db, id);
    expect(await cfg(db, first)).toBeNull();
    expect(await cfg(db, second)).not.toBeNull();

    await runOperation(db, 'devices.delete', { id }, asConfirmedRun());
    expect(await cfg(db, second)).toBeNull();
  });
});

describe('GET /provision/<token>/<file>', () => {
  it('answers .cfg files, 404s every other file and an unknown token, and records the fetch', async () => {
    const db = await makeTestDb();
    const { id, token } = await seedDesk(db);

    expect(
      await provisioningFile(db, token, 'y000000000000.boot', '203.0.113.9')
    ).toBeNull();
    expect(await cfg(db, 'x'.repeat(43))).toBeNull();
    const fetched = (): Promise<unknown> =>
      db
        .selectFrom('devices')
        .select(['provisionedAt', 'provisionedFrom'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    expect(await fetched()).toEqual({
      provisionedAt: null,
      provisionedFrom: null
    });

    const body = await provisioningFile(
      db,
      token,
      '805ec0123456.cfg',
      '203.0.113.9'
    );
    expect(body).toMatch(/^#!version:1\.0\.0\.1\n/u);
    expect(await fetched()).toMatchObject({ provisionedFrom: '203.0.113.9' });
  });
});

describe("devices.setBlf: a yealink device's line keys (§10.4)", () => {
  it('a new yealink device starts with its line key and a DND key', async () => {
    const db = await makeTestDb();
    const { id } = await seedDesk(db);
    expect(await runOperation(db, 'devices.getBlf', { id }, asRun())).toEqual({
      keys: [
        { kind: 'line' },
        { kind: 'feature', feature: 'dndToggle', label: 'DND' }
      ]
    });
  });

  it('takes every kind of key in order and reads them back', async () => {
    const db = await makeTestDb();
    const { id } = await seedDesk(db);
    await db
      .insertInto('extensions')
      .values({ ext: '701', isParkingSlot: 1 })
      .execute();
    const keys = [
      { kind: 'line' },
      { kind: 'blf', ext: '701' },
      { kind: 'quickDial', number: '+43123456789', label: 'Taxi' },
      { kind: 'feature', feature: 'park', label: 'Park' },
      { kind: 'empty' },
      { kind: 'blf', ext: '205' }
    ];
    await runOperation(db, 'devices.setBlf', { id, keys }, asRun());
    expect(await runOperation(db, 'devices.getBlf', { id }, asRun())).toEqual({
      keys
    });
  });

  it("takes mailbox keys for the user's own mailbox and their ring groups', not another's", async () => {
    const db = await makeTestDb();
    const { id } = await seedDesk(db);
    const anna = (
      await db
        .selectFrom('extensions')
        .select('userId')
        .where('ext', '=', '205')
        .executeTakeFirstOrThrow()
    ).userId;
    await db
      .insertInto('ringGroups')
      .values({
        id: 'rg-support',
        name: 'Support',
        strategy: 'simultaneous',
        createdAt: '2026-10-21T00:00:00.000Z'
      })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId: 'rg-support', position: 0, userId: anna })
      .execute();
    await db
      .insertInto('extensions')
      .values({ ext: '600', ringGroupId: 'rg-support' })
      .execute();
    await seedUser(db, { name: 'Ben', email: 'ben@x.test', ext: '206' });
    const keys = [
      { kind: 'mailbox', ext: '205', label: 'My VM' },
      { kind: 'mailbox', ext: '600', label: 'Support VM' },
      { kind: 'blf', ext: '600' }
    ];
    await runOperation(db, 'devices.setBlf', { id, keys }, asRun());
    expect(await runOperation(db, 'devices.getBlf', { id }, asRun())).toEqual({
      keys
    });
    await expect(
      runOperation(
        db,
        'devices.setBlf',
        { id, keys: [{ kind: 'mailbox', ext: '206', label: 'Ben VM' }] },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it("follows its user's renumbering on a mailbox key as on a BLF key", async () => {
    const db = await makeTestDb();
    const { id } = await seedDesk(db);
    const keys = [
      { kind: 'mailbox', ext: '205', label: 'My VM' },
      { kind: 'blf', ext: '205' }
    ];
    await runOperation(db, 'devices.setBlf', { id, keys }, asRun());
    const anna = (
      await db
        .selectFrom('extensions')
        .select('userId')
        .where('ext', '=', '205')
        .executeTakeFirstOrThrow()
    ).userId;
    await runOperation(
      db,
      'users.update',
      { id: anna, extension: '207' },
      asConfirmedRun()
    );
    expect(await runOperation(db, 'devices.getBlf', { id }, asRun())).toEqual({
      keys: [
        { kind: 'mailbox', ext: '207', label: 'My VM' },
        { kind: 'blf', ext: '207' }
      ]
    });
  });

  it("keeps a label off an extension's key and the line key in the table itself", async () => {
    const db = await makeTestDb();
    const { id } = await seedDesk(db);
    const insert = (row: Record<string, unknown>): Promise<unknown> =>
      db
        .insertInto('deviceBlfKeys')
        .values({ deviceId: id, position: 9, ...row })
        .execute();
    await expect(insert({ ext: '205', label: 'Anna' })).rejects.toThrow(
      /CHECK/u
    );
    await expect(insert({ isLineKey: 1, label: 'Desk' })).rejects.toThrow(
      /CHECK/u
    );
    await expect(insert({ feature: 'park' })).rejects.toThrow(/CHECK/u);
    await expect(insert({ isEmpty: 1, isLineKey: 1 })).rejects.toThrow(
      /CHECK/u
    );
  });

  it('refuses a second line key, a number that is not E.164, and a manual device', async () => {
    const db = await makeTestDb();
    const { id } = await seedDesk(db);
    const set = (deviceId: string, keys: unknown[]): Promise<unknown> =>
      runOperation(db, 'devices.setBlf', { id: deviceId, keys }, asRun());
    await expect(
      set(id, [{ kind: 'line' }, { kind: 'line' }])
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      set(id, [{ kind: 'quickDial', number: '0123', label: 'Taxi' }])
    ).rejects.toMatchObject({ status: 422 });
    const manual = await create(
      db,
      await seedUser(db, { name: 'Ben', email: 'ben@x.test', ext: '206' }),
      'manual'
    );
    await expect(
      set(manual.device.id, [{ kind: 'blf', ext: '205' }])
    ).rejects.toMatchObject({
      status: 422
    });
  });
});

describe('a device\'s message indicator (§9.3 "MWI")', () => {
  /** Anna in ring group Support; returns her id. */
  async function seedSupport(db: Db): Promise<string> {
    const anna = await seedAnna(db);
    await db
      .insertInto('ringGroups')
      .values({
        id: 'rg-support',
        name: 'Support',
        strategy: 'simultaneous',
        createdAt: '2026-10-21T00:00:00.000Z'
      })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId: 'rg-support', position: 0, userId: anna })
      .execute();
    return anna;
  }

  const groupsOf = async (
    db: Db,
    userId: string,
    id: string
  ): Promise<unknown> =>
    (
      (await runOperation(db, 'devices.list', { userId }, asRun())) as {
        items: { id: string; mwiRingGroups: string[] | null }[];
      }
    ).items.find(item => item.id === id)?.mwiRingGroups;

  it('counts every group on a manual device and none on a yealink one by default', async () => {
    const db = await makeTestDb();
    const anna = await seedSupport(db);
    const manual = await create(db, anna, 'manual');
    const yealink = await create(db, anna, 'yealink');
    expect(await groupsOf(db, anna, manual.device.id)).toBeNull();
    expect(await groupsOf(db, anna, yealink.device.id)).toEqual([]);
  });

  it("takes the user's own groups alone, and undo restores the setting before", async () => {
    const db = await makeTestDb();
    const anna = await seedSupport(db);
    const { device } = await create(db, anna, 'yealink');
    const update = (mwiRingGroups: string[] | null): Promise<unknown> =>
      runOperation(
        db,
        'devices.update',
        { id: device.id, mwiRingGroups },
        asRun()
      );

    await update(['rg-support']);
    expect(await groupsOf(db, anna, device.id)).toEqual(['rg-support']);
    await expect(update(['rg-other'])).rejects.toMatchObject({ status: 422 });

    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'devices.update')
      .where('entityId', '=', device.id)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());
    expect(await groupsOf(db, anna, device.id)).toEqual([]);
  });
});
