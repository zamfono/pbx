import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { openTargetSecret } from './ops/backups/_secret.js';
import { keyringFromEnv } from './secretbox.js';
import {
  createDefaultBackupTarget,
  LOCAL_BACKUP_REPOSITORY
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

describe('createDefaultBackupTarget', () => {
  it('creates a local target on the backups volume, keyed by BACKUP_PASSWORD', async () => {
    const db = await migratedDb();
    await createDefaultBackupTarget(
      db,
      { BACKUP_PASSWORD: 'from-env', MOH_SOURCE_DIR: '' },
      kr,
      nowIso(),
      logger
    );
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
    await createDefaultBackupTarget(
      db,
      { MOH_SOURCE_DIR: '' },
      kr,
      nowIso(),
      logger
    );
    expect(await db.selectFrom('backupTargets').selectAll().execute()).toEqual(
      []
    );
  });
});
