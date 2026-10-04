import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';

import {
  installRingotelFake,
  type RingotelFake
} from '#testing/ringotelFake.js';
import { asConfirmedRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { encrypt, keyringFromEnv } from '../secretbox.js';
import { isRosterPending, retryPendingRoster } from './roster.js';
import { runOperation } from './runner.js';

import './users/index.js';

/** The `ringotel.roster` rows, oldest first, as their channel and `{field: to}` changes. */
async function rosterRows(
  db: Db
): Promise<{ channel: string; changes: Record<string, unknown> }[]> {
  const rows = await db
    .selectFrom('auditLog')
    .select(['channel', 'changesJson', 'entityKind'])
    .where('operation', '=', 'ringotel.roster')
    .orderBy('createdAt')
    .execute();
  return rows.map(row => {
    expect(row.entityKind).toBe('settings');
    const changes = JSON.parse(row.changesJson) as {
      field: string;
      to: unknown;
    }[];
    return {
      channel: row.channel,
      changes: Object.fromEntries(
        changes.map(change => [change.field, change.to])
      )
    };
  });
}

async function setUpRingotel(db: Db): Promise<void> {
  await seedSettings(db, {
    ringotelOrgId: 'org-1',
    ringotelBranchId: 'branch-1',
    ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
  });
}

async function createUser(db: Db): Promise<void> {
  await runOperation(
    db,
    'users.create',
    { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
    asConfirmedRun()
  );
}

let fake: RingotelFake | null = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

describe('ringotel.roster outcome rows (§5.7, §10.4 "Colleague presence")', () => {
  it('records a push Ringotel took, triggered by the operation', async () => {
    const db = await makeTestDb();
    await setUpRingotel(db);
    fake = installRingotelFake();

    await createUser(db);

    expect(await rosterRows(db)).toEqual([
      {
        channel: 'rest',
        changes: { outcome: 'pushed', trigger: 'users.create' }
      }
    ]);
    expect(await isRosterPending(db)).toBe(false);
  });

  it('records a refusal and the retries at api and Asterisk starts on channel job', async () => {
    const db = await makeTestDb();
    await setUpRingotel(db);
    fake = installRingotelFake();
    fake.failing.add('updateBranch');
    await createUser(db);
    await retryPendingRoster(db, 'api.start');
    fake.failing.delete('updateBranch');
    await retryPendingRoster(db, 'asterisk.started');

    const rows = await rosterRows(db);
    expect(rows.map(row => [row.channel, row.changes.outcome])).toEqual([
      ['rest', 'refused'],
      ['job', 'refused'],
      ['job', 'pushed']
    ]);
    expect(rows.map(row => row.changes.trigger)).toEqual([
      'users.create',
      'api.start',
      'asterisk.started'
    ]);
    expect(rows[0]?.changes.reason).toEqual(expect.any(String));
    expect(await isRosterPending(db)).toBe(false);
  });

  it('drops the marker as skipped once Ringotel is no longer set up, and records nothing while none is pending', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { ringotelRosterPending: 1 });

    await retryPendingRoster(db, 'api.start');
    await retryPendingRoster(db, 'api.start');

    expect(await rosterRows(db)).toEqual([
      {
        channel: 'job',
        changes: {
          outcome: 'skipped',
          trigger: 'api.start',
          reason: 'Ringotel is not set up'
        }
      }
    ]);
    expect(await isRosterPending(db)).toBe(false);
  });
});
