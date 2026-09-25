import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '../secretbox.js';
import { makeTestDb } from '../testDb.js';
import { activeRingotelProvider, providerFor } from './index.js';
import type { RingotelClient } from './ringotelClient.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

/** Seeds the tenant `settings` singleton, optionally already provisioned with Ringotel ids. */
async function seedSettings(
  db: Db,
  ringotel?: { orgId: string; branchId: string }
): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId,
      ringotelOrgId: ringotel?.orgId ?? null,
      ringotelBranchId: ringotel?.branchId ?? null,
      ringotelApiTokenEnc: ringotel
        ? encrypt(keyringFromEnv(process.env), 'ringotel-key')
        : null
    })
    .execute();
}

describe('activeRingotelProvider', () => {
  it('is null while provisioning.ringotelSetup has not run', async () => {
    const db = await makeTestDb();
    await seedSettings(db);

    expect(await activeRingotelProvider(db)).toBeNull();
  });

  it('is a Ringotel provider once the organization and connection ids are set', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { orgId: 'org-1', branchId: 'branch-1' });

    const provider = await activeRingotelProvider(db);

    expect(provider).not.toBeNull();
    expect(typeof provider?.onDeviceCreated).toBe('function');
  });
});

describe('providerFor', () => {
  it("returns the no-op manual provider for 'manual'", async () => {
    const provider = providerFor('manual');
    await expect(
      provider.onDeviceCreated({} as never, { username: 'x', password: 'y' })
    ).resolves.toBeUndefined();
  });

  it("builds a Ringotel provider for 'ringotel'", () => {
    const client: RingotelClient = {
      call: <T>() => Promise.resolve(undefined as T)
    };
    // An overload of `providerFor` requires this second argument for `'ringotel'` at compile
    // time, so there is no runtime case of a caller omitting it to test.
    const provider = providerFor('ringotel', { client, db: {} as never });
    expect(typeof provider.onDeviceCreated).toBe('function');
  });
});
