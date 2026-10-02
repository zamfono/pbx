import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import { MS_PER_DAY, newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { runOperation, type RunInput } from '../ops/runner.js';
import { type Actor } from '../ops/types.js';
import { runPurge } from './purge.js';

import '../ops/ooo/index.js';
import '../ops/users/index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.FQDN ??= 'pbx.example.test';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
const DAYS_PAST_DEFAULT_RETENTION = 31;
const DAYS_WITHIN_DEFAULT_RETENTION = 5;
const BLOCK_DIGITS = 3;

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    actor: owner,
    channel: 'rest',
    requestId: 'req-1',
    confirm: true,
    ...overrides
  };
}

function daysAfter(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * MS_PER_DAY).toISOString();
}

/** An `oauth_clients` row last authorized at `lastLoginAt` (§11.2). */
async function insertClient(
  db: Db,
  clientId: string,
  lastLoginAt: string
): Promise<void> {
  await db
    .insertInto('oauthClients')
    .values({
      clientId,
      name: clientId,
      kind: 'cimd',
      redirectUrisJson: '[]',
      createdAt: lastLoginAt,
      lastLoginAt
    })
    .execute();
}

/** A 30-day refresh token of `clientId` expiring at `expiresAt` (§5.2 "Tokens"). */
async function insertRefreshToken(
  db: Db,
  userId: string,
  token: { tokenHash: string; clientId: string; expiresAt: string }
): Promise<void> {
  await db
    .insertInto('tokens')
    .values({
      ...token,
      userId,
      kind: 'refresh',
      createdAt: daysAfter(token.expiresAt, -30)
    })
    .execute();
}

async function clientIdsOf(db: Db): Promise<string[]> {
  const rows = await db.selectFrom('oauthClients').select('clientId').execute();
  return rows.map(row => row.clientId).sort();
}

async function migratedDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  return db;
}

/** Seeds the tenant `settings` singleton (default retention days), required by `runPurge`. */
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

/** A `did_blocks` row; `digits` NULL means "any number starting with `base`" (§5.9). */
async function insertDidBlock(
  db: Db,
  base: string,
  digits: number | null,
  deletedAt: string | null
): Promise<string> {
  const id = newId();
  await db
    .insertInto('didBlocks')
    .values({
      id,
      base,
      label: null,
      digits,
      fallbackTargetId: null,
      createdAt: nowIso(),
      deletedAt
    })
    .execute();
  return id;
}

/** A DID with its own forward target, live unless `deletedAt` is given. */
async function insertDid(
  db: Db,
  number: string,
  deletedAt: string | null = null
): Promise<string> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: number })
    .execute();
  const id = newId();
  await db
    .insertInto('dids')
    .values({
      id,
      number,
      label: null,
      targetId,
      createdAt: nowIso(),
      deletedAt
    })
    .execute();
  return id;
}

async function createUser(db: Db, extension: string): Promise<string> {
  const result = (await runOperation(
    db,
    'users.create',
    { name: 'Anna Huber', email: `${extension}@x.test`, extension },
    asRun()
  )) as { user: { id: string } };
  return result.user.id;
}

describe('runPurge', () => {
  it('purges a user whose own rule targets their own mailbox, with no FK error, and clears the orphaned target', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const userId = await createUser(db, '101');
    await runOperation(
      db,
      'users.setForwarding',
      {
        id: userId,
        rules: [{ condition: 'busy', target: { kind: 'mailboxUser', userId } }]
      },
      asRun()
    );
    const rule = await db
      .selectFrom('userForwardRules')
      .select('targetId')
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'users.delete', { id: userId }, asRun());
    const { deletedAt } = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    if (deletedAt === null) {
      throw new Error('expected users.delete to set deletedAt');
    }
    await expect(
      runPurge(db, daysAfter(deletedAt, DAYS_PAST_DEFAULT_RETENTION))
    ).resolves.toBeUndefined();

    const remainingUser = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(remainingUser).toBeUndefined();
    const remainingRule = await db
      .selectFrom('userForwardRules')
      .select('userId')
      .where('userId', '=', userId)
      .executeTakeFirst();
    expect(remainingRule).toBeUndefined();
    const remainingTarget = await db
      .selectFrom('forwardTargets')
      .select('id')
      .where('id', '=', rule.targetId)
      .executeTakeFirst();
    expect(remainingTarget).toBeUndefined();
  });

  it('purges a soft-deleted DID whose target is a soft-deleted user, with no FK error', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const userId = await createUser(db, '105');
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: targetId,
        userId,
        ringGroupId: null,
        external: null,
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
        number: '+491111111',
        label: null,
        targetId,
        createdAt: nowIso()
      })
      .execute();
    // The DID is soft-deleted before the user, exactly as `users.delete`'s own reference guard
    // requires (§5.9): a live DID targeting the user would otherwise block the user's own delete.
    await db
      .updateTable('dids')
      .set({ deletedAt: nowIso() })
      .where('id', '=', didId)
      .execute();
    await runOperation(db, 'users.delete', { id: userId }, asRun());
    const { deletedAt } = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (deletedAt === null) {
      throw new Error('expected users.delete to set deletedAt');
    }

    await expect(
      runPurge(db, daysAfter(deletedAt, DAYS_PAST_DEFAULT_RETENTION))
    ).resolves.toBeUndefined();

    const remainingUser = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(remainingUser).toBeUndefined();
    const remainingDid = await db
      .selectFrom('dids')
      .select('id')
      .where('id', '=', didId)
      .executeTakeFirst();
    expect(remainingDid).toBeUndefined();
    const remainingTarget = await db
      .selectFrom('forwardTargets')
      .select('id')
      .where('id', '=', targetId)
      .executeTakeFirst();
    expect(remainingTarget).toBeUndefined();
  });

  it('purges a soft-deleted DID whose target is a soft-deleted announcement asset, with no FK error', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const audioId = newId();
    await db
      .insertInto('audioAssets')
      .values({
        id: audioId,
        label: 'Closed for the day',
        kind: 'announcement',
        filename: 'closed-for-the-day.wav',
        uploadedBy: null,
        createdAt: nowIso(),
        deletedAt: nowIso()
      })
      .execute();
    const targetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: targetId,
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: audioId,
        menuId: null
      })
      .execute();
    const didId = newId();
    const createdAt = nowIso();
    await db
      .insertInto('dids')
      .values({
        id: didId,
        number: '+492222222',
        label: null,
        targetId,
        createdAt,
        deletedAt: createdAt
      })
      .execute();

    await expect(
      runPurge(db, daysAfter(createdAt, DAYS_PAST_DEFAULT_RETENTION))
    ).resolves.toBeUndefined();

    const remainingAudio = await db
      .selectFrom('audioAssets')
      .select('id')
      .where('id', '=', audioId)
      .executeTakeFirst();
    expect(remainingAudio).toBeUndefined();
    const remainingDid = await db
      .selectFrom('dids')
      .select('id')
      .where('id', '=', didId)
      .executeTakeFirst();
    expect(remainingDid).toBeUndefined();
    const remainingTarget = await db
      .selectFrom('forwardTargets')
      .select('id')
      .where('id', '=', targetId)
      .executeTakeFirst();
    expect(remainingTarget).toBeUndefined();
  });

  it('purges a user whose own OOO rule targets their own mailbox, with no FK error', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const userId = await createUser(db, '104');
    await runOperation(
      db,
      'ooo.create',
      {
        scope: { kind: 'user', id: userId },
        target: { kind: 'mailboxUser', userId }
      },
      asRun()
    );
    const rule = await db
      .selectFrom('oooRules')
      .select('targetId')
      .where('scopeUserId', '=', userId)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'users.delete', { id: userId }, asRun());
    const { deletedAt } = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (deletedAt === null) {
      throw new Error('expected users.delete to set deletedAt');
    }

    await expect(
      runPurge(db, daysAfter(deletedAt, DAYS_PAST_DEFAULT_RETENTION))
    ).resolves.toBeUndefined();

    const remainingUser = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(remainingUser).toBeUndefined();
    const remainingRule = await db
      .selectFrom('oooRules')
      .select('id')
      .where('scopeUserId', '=', userId)
      .executeTakeFirst();
    expect(remainingRule).toBeUndefined();
    const remainingTarget = await db
      .selectFrom('forwardTargets')
      .select('id')
      .where('id', '=', rule.targetId)
      .executeTakeFirst();
    expect(remainingTarget).toBeUndefined();
  });

  it('leaves a soft-deleted row younger than the retention window untouched', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const userId = await createUser(db, '102');
    await runOperation(db, 'users.delete', { id: userId }, asRun());
    const before = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (before.deletedAt === null) {
      throw new Error('expected users.delete to set deletedAt');
    }

    await runPurge(
      db,
      daysAfter(before.deletedAt, DAYS_WITHIN_DEFAULT_RETENTION)
    );

    const remainingUser = await db
      .selectFrom('users')
      .select(['id', 'deletedAt'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(remainingUser.deletedAt).toBe(before.deletedAt);
  });

  it('purges expired tokens and audit_log entries beyond audit_retention_days', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const userId = await createUser(db, '103');
    const now = nowIso();
    await db
      .insertInto('tokens')
      .values({
        tokenHash: 'expired',
        userId,
        kind: 'reset',
        clientId: null,
        createdAt: now,
        expiresAt: daysAfter(now, -1)
      })
      .execute();
    await db
      .insertInto('tokens')
      .values({
        tokenHash: 'live',
        userId,
        kind: 'reset',
        clientId: null,
        createdAt: now,
        expiresAt: daysAfter(now, 1)
      })
      .execute();
    // An expired refresh row stays 30 days past its expiry, as its client's last-expiry
    // record (§5.2 "Client rows"); a reset row goes as soon as it has expired.
    await insertClient(db, 'refreshing-client', daysAfter(now, -90));
    await insertRefreshToken(db, userId, {
      tokenHash: 'refresh-expired-long-ago',
      clientId: 'refreshing-client',
      expiresAt: daysAfter(now, -31)
    });
    await insertRefreshToken(db, userId, {
      tokenHash: 'refresh-expired-recently',
      clientId: 'refreshing-client',
      expiresAt: daysAfter(now, -29)
    });
    await db
      .updateTable('settings')
      .set({ auditRetentionDays: 30 })
      .where('id', '=', 1)
      .execute();
    const oldAuditId = newId();
    await db
      .insertInto('auditLog')
      .values({
        id: oldAuditId,
        actorUserId: userId,
        actorUserName: 'Anna Huber',
        channel: 'rest',
        clientId: null,
        clientName: null,
        operation: 'users.update',
        entityKind: 'user',
        entityId: userId,
        changesJson: '[]',
        undoable: 1,
        revertsId: null,
        undoneAt: null,
        createdAt: daysAfter(now, -31)
      })
      .execute();

    await runPurge(db, now);

    const tokenHashes = (
      await db.selectFrom('tokens').select('tokenHash').execute()
    ).map(row => row.tokenHash);
    expect(tokenHashes).not.toContain('expired');
    expect(tokenHashes).toContain('live');
    expect(tokenHashes).not.toContain('refresh-expired-long-ago');
    expect(tokenHashes).toContain('refresh-expired-recently');
    const auditIds = (
      await db.selectFrom('auditLog').select('id').execute()
    ).map(row => row.id);
    expect(auditIds).not.toContain(oldAuditId);
  });

  it('purges backup_runs older than recording_retention_days and keeps the younger ones', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const now = nowIso();
    await db
      .updateTable('settings')
      .set({ recordingRetentionDays: 30 })
      .where('id', '=', 1)
      .execute();
    await db
      .insertInto('backupTargets')
      .values({
        id: 'target-1',
        kind: 'local',
        paramsJson: '{"path":"/backups/restic"}',
        enabled: 1,
        secretEnc: Buffer.from('x'),
        createdAt: now
      })
      .execute();
    for (const [id, ageDays] of [
      ['old-run', 31],
      ['young-run', 29]
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; inserts serialize
      await db
        .insertInto('backupRuns')
        .values({
          id,
          targetId: 'target-1',
          status: 'ok',
          startedAt: daysAfter(now, -ageDays),
          finishedAt: daysAfter(now, -ageDays)
        })
        .execute();
    }

    await runPurge(db, now);

    const runIds = (
      await db.selectFrom('backupRuns').select('id').execute()
    ).map(row => row.id);
    expect(runIds).toEqual(['young-run']);
  });

  it('purges an oauth_clients row only once its last token expired more than 30 days ago', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const userId = await createUser(db, '104');
    const now = nowIso();
    const clients = [
      // Its last refresh token expired 31 days ago: due (§5.2).
      { clientId: 'expired-long-ago', tokenExpiresInDays: -31 },
      // Its last refresh token expired 10 days ago: not yet due.
      { clientId: 'expired-recently', tokenExpiresInDays: -10 },
      // Still holds a live refresh token, whatever its last login.
      { clientId: 'live', tokenExpiresInDays: 20 }
    ];
    for (const client of clients) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; inserts serialize
      await db
        .insertInto('oauthClients')
        .values({
          clientId: client.clientId,
          name: client.clientId,
          kind: 'cimd',
          redirectUrisJson: '[]',
          createdAt: daysAfter(now, -120),
          lastLoginAt: daysAfter(now, -120)
        })
        .execute();
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; inserts serialize
      await db
        .insertInto('tokens')
        .values({
          tokenHash: `token-${client.clientId}`,
          userId,
          kind: 'refresh',
          clientId: client.clientId,
          createdAt: daysAfter(now, client.tokenExpiresInDays - 30),
          expiresAt: daysAfter(now, client.tokenExpiresInDays)
        })
        .execute();
    }

    await runPurge(db, now);

    const clientIds = (
      await db.selectFrom('oauthClients').select('clientId').execute()
    )
      .map(row => row.clientId)
      .sort();
    expect(clientIds).toEqual(['expired-recently', 'live']);
  });

  it('keeps a client that kept refreshing until 30 days after its last token expired', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const userId = await createUser(db, '105');
    const now = nowIso();
    // Logged in once 120 days ago and refreshed ever since; a refresh never touches
    // `last_login_at`. Its last refresh token expired a day ago.
    await insertClient(db, 'refreshing', daysAfter(now, -120));
    await insertRefreshToken(db, userId, {
      tokenHash: 'last-refresh',
      clientId: 'refreshing',
      expiresAt: daysAfter(now, -1)
    });

    await runPurge(db, now);
    await runPurge(db, daysAfter(now, 1));
    await runPurge(db, daysAfter(now, 28));
    expect(await clientIdsOf(db)).toEqual(['refreshing']);

    await runPurge(db, daysAfter(now, 30));
    expect(await clientIdsOf(db)).toEqual([]);
    const tokens = await db.selectFrom('tokens').select('tokenHash').execute();
    expect(tokens).toEqual([]);
  });

  it('purges a client no token references, unless it was authorized within the code lifetime', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const now = nowIso();
    // Authorized a moment ago: its code may not have been redeemed for a token yet (§5.2).
    await insertClient(db, 'in-flight', now);
    // Authorized an hour ago and never redeemed a code: no token will ever reference it.
    await insertClient(
      db,
      'abandoned',
      new Date(Date.parse(now) - 3_600_000).toISOString()
    );

    await runPurge(db, now);

    expect(await clientIdsOf(db)).toEqual(['in-flight']);
  });

  it('keeps a due DID block that still holds a live DID, and purges the rest of the pass', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const now = nowIso();
    const deletedAt = daysAfter(now, -DAYS_PAST_DEFAULT_RETENTION);
    const heldBlockId = await insertDidBlock(db, '+4989', null, deletedAt);
    await insertDid(db, '+498912345');
    const freeBlockId = await insertDidBlock(db, '+4930', null, deletedAt);

    await expect(runPurge(db, now)).resolves.toBeUndefined();

    const blockIds = (
      await db.selectFrom('didBlocks').select('id').execute()
    ).map(row => row.id);
    expect(blockIds).toContain(heldBlockId);
    expect(blockIds).not.toContain(freeBlockId);
  });

  it('purges a due DID block whose only DIDs inside it are soft-deleted', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const now = nowIso();
    const deletedAt = daysAfter(now, -DAYS_PAST_DEFAULT_RETENTION);
    const blockId = await insertDidBlock(db, '+4989', null, deletedAt);
    await insertDid(db, '+498912345', deletedAt);

    await expect(runPurge(db, now)).resolves.toBeUndefined();

    const remainingBlock = await db
      .selectFrom('didBlocks')
      .select('id')
      .where('id', '=', blockId)
      .executeTakeFirst();
    expect(remainingBlock).toBeUndefined();
  });

  it('keeps a due digits block only while a live DID matches its digit count', async () => {
    const db = await migratedDb();
    await seedTenant(db);
    const now = nowIso();
    const deletedAt = daysAfter(now, -DAYS_PAST_DEFAULT_RETENTION);
    const blockId = await insertDidBlock(db, '+4989', BLOCK_DIGITS, deletedAt);
    await insertDid(db, '+49891234567');

    await expect(runPurge(db, now)).resolves.toBeUndefined();

    const remainingBlock = await db
      .selectFrom('didBlocks')
      .select('id')
      .where('id', '=', blockId)
      .executeTakeFirst();
    expect(remainingBlock).toBeUndefined();
  });
});

describe('runPurge: voicemail files', () => {
  const previousMediaDir = process.env.MEDIA_DIR;

  afterEach(() => {
    if (previousMediaDir === undefined) {
      delete process.env.MEDIA_DIR;
    } else {
      process.env.MEDIA_DIR = previousMediaDir;
    }
  });

  /** A voicemail row in a mailbox, with its WAV on the media volume; returns the file's path. */
  async function insertVoicemail(
    db: Db,
    mediaDir: string,
    mailbox: { mailboxUserId?: string; mailboxRingGroupId?: string }
  ): Promise<string> {
    const filename = `${newId()}.wav`;
    const filePath = path.join(mediaDir, 'voicemail', filename);
    await writeFile(filePath, 'audio-bytes');
    await db
      .insertInto('voicemails')
      .values({
        id: newId(),
        ...mailbox,
        caller: '+491701234567',
        filename,
        durationS: 5,
        createdAt: nowIso()
      })
      .execute();
    return filePath;
  }

  async function exists(filePath: string): Promise<boolean> {
    return access(filePath).then(
      () => true,
      () => false
    );
  }

  it("unlinks a purged user's and ring group's voicemail files, and keeps a live user's", async () => {
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-purge-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
    await mkdir(path.join(mediaDir, 'voicemail'), { recursive: true });
    process.env.MEDIA_DIR = mediaDir;
    const db = await migratedDb();
    await seedTenant(db);
    const deletedUser = await createUser(db, '101');
    const liveUser = await createUser(db, '102');
    await runOperation(db, 'users.delete', { id: deletedUser }, asRun());
    const { deletedAt } = await db
      .selectFrom('users')
      .select('deletedAt')
      .where('id', '=', deletedUser)
      .executeTakeFirstOrThrow();
    if (deletedAt === null) {
      throw new Error('expected users.delete to set deletedAt');
    }
    const ringGroupId = newId();
    await db
      .insertInto('ringGroups')
      .values({
        id: ringGroupId,
        name: 'Sales',
        strategy: 'simultaneous',
        createdAt: nowIso(),
        deletedAt
      })
      .execute();
    const userFile = await insertVoicemail(db, mediaDir, {
      mailboxUserId: deletedUser
    });
    const groupFile = await insertVoicemail(db, mediaDir, {
      mailboxRingGroupId: ringGroupId
    });
    const liveFile = await insertVoicemail(db, mediaDir, {
      mailboxUserId: liveUser
    });

    await runPurge(db, daysAfter(deletedAt, DAYS_PAST_DEFAULT_RETENTION));

    expect(await exists(userFile)).toBe(false);
    expect(await exists(groupFile)).toBe(false);
    expect(await exists(liveFile)).toBe(true);
    const remaining = await db
      .selectFrom('voicemails')
      .select('mailboxUserId')
      .execute();
    expect(remaining).toEqual([{ mailboxUserId: liveUser }]);
  });
});
