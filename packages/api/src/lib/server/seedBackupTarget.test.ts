import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { openTargetSecret, sealTargetSecret } from './ops/backups/_secret.js';
import { keyringFromEnv } from './secretbox.js';
import {
  LOCAL_BACKUP_REPOSITORY,
  seedBackupTarget
} from './seedBackupTarget.js';

const logger = pino({ level: 'silent' });
const KEY_BYTES = 32;
const kr = keyringFromEnv({
  SECRETBOX_KEY: `1:${randomBytes(KEY_BYTES).toString('base64')}`
});

async function migratedDb(): Promise<Db> {
  const db = await migratedTestDb();
  return db;
}

describe('seedBackupTarget', () => {
  it('creates a local target on the backups volume, keyed by BACKUP_PASSWORD', async () => {
    const db = await migratedDb();
    const result = await seedBackupTarget(
      db,
      { BACKUP_PASSWORD: 'from-env' },
      kr,
      logger
    );
    expect(result).toBe('seeded');
    const rows = await db.selectFrom('backupTargets').selectAll().execute();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.kind).toBe('local');
    expect(row?.enabled).toBe(1);
    expect(JSON.parse(row?.paramsJson ?? '{}')).toEqual({
      path: LOCAL_BACKUP_REPOSITORY,
      forget: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }
    });
    expect(openTargetSecret(kr, row?.secretEnc ?? Buffer.alloc(0))).toEqual({
      resticPassword: 'from-env'
    });
  });

  it('creates nothing without BACKUP_PASSWORD', async () => {
    const db = await migratedDb();
    expect(await seedBackupTarget(db, {}, kr, logger)).toBe('skipped');
    expect(await db.selectFrom('backupTargets').selectAll().execute()).toEqual(
      []
    );
  });

  it('runs once: a second start adds no second target', async () => {
    const db = await migratedDb();
    const env = { BACKUP_PASSWORD: 'from-env' };
    await seedBackupTarget(db, env, kr, logger);
    expect(await seedBackupTarget(db, env, kr, logger)).toBe('skipped');
    expect(
      await db.selectFrom('backupTargets').selectAll().execute()
    ).toHaveLength(1);
  });

  it('does not bring back a target an admin deleted', async () => {
    const db = await migratedDb();
    await db
      .insertInto('backupTargets')
      .values({
        id: newId(),
        kind: 'local',
        paramsJson: '{"path":"/backups/restic"}',
        enabled: 1,
        secretEnc: sealTargetSecret(kr, { resticPassword: 'old' }),
        createdAt: nowIso(),
        deletedAt: nowIso()
      })
      .execute();
    expect(
      await seedBackupTarget(db, { BACKUP_PASSWORD: 'x' }, kr, logger)
    ).toBe('skipped');
  });
});
