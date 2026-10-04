import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { keySpec } from '#testing/fixtures.js';

import { openTargetSecret } from './ops/backups/_secret.js';
import { keyringFromEnv } from './secretbox.js';
import {
  createDefaultBackupTarget,
  LOCAL_BACKUP_REPOSITORY
} from './seedBackupTarget.js';

const logger = pino({ level: 'silent' });
const kr = keyringFromEnv({
  SECRETBOX_KEY: keySpec()
});

describe('createDefaultBackupTarget', () => {
  it('creates a local target on the backups volume, keyed by BACKUP_PASSWORD', async () => {
    const db = await migratedTestDb();
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
    const db = await migratedTestDb();
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
