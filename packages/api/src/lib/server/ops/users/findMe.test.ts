import { describe, expect, it, vi } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../dids/index.js';
import './index.js';

vi.mock('#lib/server/mail/index.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/mail/index.js')>();
  return { ...actual, sendMail: vi.fn(() => Promise.resolve('sent')) };
});

const OWN_DID = '+4989123456';

async function dbWithOwnDid(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  await runOperation(
    db,
    'dids.create',
    { number: OWN_DID, target: { kind: 'user', userId: 'owner' } },
    asRun()
  );
  return db;
}

describe('a find-me entry that is an own DID', () => {
  it('users.update refuses it with 422 naming the entry', async () => {
    const db = await dbWithOwnDid();
    const created = (await runOperation(
      db,
      'users.create',
      { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
      asRun()
    )) as { user: { id: string } };
    await expect(
      runOperation(
        db,
        'users.update',
        {
          id: created.user.id,
          findMe: [
            { number: '+491701234567', delayS: 0 },
            { number: OWN_DID, delayS: 5 }
          ]
        },
        asRun()
      )
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(OWN_DID) as unknown
    });
  });

  it('users.create refuses it with 422', async () => {
    const db = await dbWithOwnDid();
    await expect(
      runOperation(
        db,
        'users.create',
        {
          name: 'Anna Huber',
          email: 'anna@x.test',
          extension: '101',
          findMe: [{ number: OWN_DID, delayS: 0 }]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });
});
